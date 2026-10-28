// Meridian Payroll desktop app (Electron main process).
//
// The pages are the static build in dist/client, served from app://meridian/.
// The payroll database runs here, in Node, as a real Postgres data folder under
// the app's own AppData folder. Automatic backups are JSON files beside it.
// Neither goes in Documents: OneDrive may sync it, which would copy ID numbers
// to Microsoft's cloud (and could copy the database mid-write). Copies meant to
// leave the computer are the downloaded backup files, which are encrypted.
// The page reaches both only through the bridge in preload.cjs.

import { app, BrowserWindow, ipcMain, Menu, net, protocol, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PGlite, types } from "@electric-sql/pglite";
import { DURABLE_START_PARAMS, DurableNodeFS } from "./durable-fs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.join(here, "..", "dist", "client");
const ORIGIN = "app://meridian";

app.setName("Meridian Payroll");
// MERIDIAN_HOME puts everything in one other folder (for testing, or running from a USB stick).
const HOME = process.env.MERIDIAN_HOME;
// The same folder in development and when installed (the package name would otherwise pick it in development).
app.setPath("userData", HOME ? path.join(HOME, "app") : path.join(app.getPath("appData"), "Meridian Payroll"));
const DATA_DIR = path.join(app.getPath("userData"), "database");
const BACKUP_DIR = path.join(app.getPath("userData"), "Backups");
// Says whether the database is open. Still "open" at startup means the last session never closed it:
// a crash, a power cut or a forced quit.
const SESSION_FILE = path.join(app.getPath("userData"), "session.json");
const lastSession = (() => {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, "utf8")); } catch { return null; }
})();

// One running copy: two processes writing one data folder would corrupt it.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// ---------------------------------------------------------------- database

/** @type {Promise<PGlite> | undefined} */
let dbPromise;
function database() {
  dbPromise ??= (async () => {
    const db = new PGlite({
      // Every commit is flushed to the disk before the app reports it saved (durable-fs.mjs), so a power cut
      // or system crash can't lose it or leave the database half-written.
      fs: new DurableNodeFS(DATA_DIR),
      startParams: DURABLE_START_PARAMS,
      // Match what Supabase/PostgREST returns (and the browser build): numbers for numeric, strings for dates and times.
      parsers: {
        [types.NUMERIC]: (v) => Number(v),
        [types.DATE]: (v) => v,
        [types.TIMESTAMPTZ]: (v) => v,
        [types.TIMESTAMP]: (v) => v,
      },
    });
    await db.waitReady;
    writeDurably(SESSION_FILE, JSON.stringify({ open: true, startedAt: new Date().toISOString() }));
    return db;
  })().catch((e) => {
    dbPromise = undefined; // try again next time (e.g. after the recovery screen moves a damaged folder aside)
    throw e;
  });
  return dbPromise;
}

/** Closes the database (if it opened) and moves its folder aside, never deleting it. Returns where it went. */
async function setAsideDatabase() {
  for (const tx of transactions.values()) tx.rollback(new Error("The database is being replaced"));
  if (dbPromise) {
    try { await (await dbPromise).close(); } catch { /* it never opened */ }
    dbPromise = undefined;
  }
  if (!fs.existsSync(DATA_DIR)) return null;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const aside = path.join(path.dirname(DATA_DIR), `database-damaged-${stamp}`);
  fs.renameSync(DATA_DIR, aside);
  return aside;
}

/** Open transactions by id, each owned by the page (webContents) that began it. */
const transactions = new Map();
let nextTx = 1;

/** Runs a handler and returns its result or a plain error, so the page sees Postgres' own message. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, value: await fn(event, ...args) };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  });
}

function target(txId) {
  if (txId == null) return database();
  const tx = transactions.get(txId);
  if (!tx) throw new Error("The transaction has already finished");
  return tx.sql;
}

handle("db:query", async (_e, sql, params, txId) => {
  const { rows, affectedRows } = await (await target(txId)).query(sql, params);
  return { rows, affectedRows };
});
handle("db:exec", async (_e, sql, txId) => {
  await (await target(txId)).exec(sql);
  return null;
});
// PGlite runs a transaction as a callback; this one stays open until the page ends it.
// Other queries wait for it, just as they do in the browser build.
handle("db:begin", async (event) => {
  const db = await database();
  const id = nextTx++;
  const owner = event.sender.id;
  const page = pageGeneration(owner);
  let opened;
  const started = new Promise((r) => { opened = r; });
  const tx = { sql: null, owner, commit: null, rollback: null, done: null };
  tx.done = db.transaction((sql) => new Promise((commit, rollback) => {
    // The page may have reloaded while this waited its turn; then nobody will ever end it.
    if (pageGeneration(owner) !== page) { rollback(new Error("The page closed")); return; }
    Object.assign(tx, { sql, commit, rollback });
    transactions.set(id, tx);
    opened();
  }));
  tx.done.catch(() => {}).finally(() => transactions.delete(id));
  await Promise.race([started, tx.done]); // throws if the transaction couldn't start
  return id;
});
handle("db:end", async (_e, txId, commit) => {
  const tx = transactions.get(txId);
  if (!tx) throw new Error("The transaction has already finished");
  if (commit) tx.commit();
  else tx.rollback(new Error("rolled back"));
  try {
    await tx.done;
  } catch (e) {
    if (commit) throw e;
  }
  return null;
});

/** A page that reloads or crashes mid-transaction never finishes it: roll back so the database isn't held. */
const generations = new Map();
const pageGeneration = (ownerId) => generations.get(ownerId) ?? 0;
function rollbackFor(ownerId) {
  generations.set(ownerId, pageGeneration(ownerId) + 1);
  for (const tx of transactions.values()) if (tx.owner === ownerId) tx.rollback(new Error("The page closed"));
}

// ---------------------------------------------------------------- backups
// One file per backup: <id>.json holding { id, created_at, reason, counts, snapshot }.

const backupFile = (id) => path.join(BACKUP_DIR, `${String(id).padStart(6, "0")}.json`);
function backupIds() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter((f) => /^\d+\.json$/.test(f)).map((f) => Number(f.slice(0, -5))).sort((a, b) => a - b);
}

/** Writes to a temporary file, flushes it to the disk, then renames it into place, so a backup is never half-written. */
function writeDurably(file, text) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

handle("backups:add", (_e, record) => {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const id = (backupIds().at(-1) ?? 0) + 1;
  writeDurably(backupFile(id), JSON.stringify({ id, ...record }));
  return id;
});
handle("backups:get", (_e, id) => {
  const file = backupFile(id);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
});
// Each file's details (everything but the snapshot), read once per file version. The folder is the
// truth: files added, changed or removed outside the app show up on the next listing.
const infoCache = new Map();
handle("backups:list", () => backupIds().map((id) => {
  const file = backupFile(id);
  try {
    const stamp = fs.statSync(file).mtimeMs;
    const hit = infoCache.get(file);
    if (hit?.stamp === stamp) return hit.info;
    const { snapshot: _skip, ...info } = JSON.parse(fs.readFileSync(file, "utf8"));
    infoCache.set(file, { stamp, info });
    return info;
  } catch {
    return null; // a damaged file is left alone and skipped
  }
}).filter(Boolean));
handle("backups:delete", (_e, ids) => {
  for (const id of ids) {
    fs.rmSync(backupFile(id), { force: true });
    infoCache.delete(backupFile(id));
  }
  return null;
});

handle("desktop:info", () => ({ dataDir: DATA_DIR, backupDir: BACKUP_DIR, computerName: os.hostname() }));
handle("desktop:session", () => ({ uncleanSince: lastSession?.open ? lastSession.startedAt ?? null : null }));
handle("db:set-aside", () => setAsideDatabase());
handle("desktop:open-folder", async (_e, which) => {
  const dir = which === "backups" ? BACKUP_DIR : DATA_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const err = await shell.openPath(dir);
  if (err) throw new Error(err);
  return null;
});

// ---------------------------------------------------------------- window

/** Serves the built pages; any path that isn't a file gets the app shell, so deep links work. */
function serveApp() {
  protocol.handle("app", (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname);
    let file = path.normalize(path.join(CLIENT_DIR, rel));
    if (!file.startsWith(CLIENT_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(CLIENT_DIR, "_shell.html");
    return net.fetch(pathToFileURL(file).toString());
  });
}

/** mailto:, tel: and web links open in the user's own apps; the window only ever shows the app. */
function openOutside(url) {
  if (/^(https?|mailto|tel):/i.test(url)) void shell.openExternal(url);
}

let win;
let pageWatchesClose = false;
let closeApproved = false;
let closeTimer = null;
const CLOSE_WAIT_MS = 30_000;
function approveClose() {
  closeApproved = true;
  clearTimeout(closeTimer);
  win?.close();
}
ipcMain.on("app:close-watch", () => { pageWatchesClose = true; });
ipcMain.on("app:close-ready", approveClose);

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Meridian Payroll",
    icon: path.join(here, "..", "build", "icon.ico"),
    show: false,
    webPreferences: { preload: path.join(here, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once("ready-to-show", () => win.show());
  // Give the page a chance to back up its last changes. It only gets asked if it said it's listening,
  // and the window closes anyway if it takes longer than CLOSE_WAIT_MS.
  win.on("close", (e) => {
    if (closeApproved || !pageWatchesClose) return;
    e.preventDefault();
    if (closeTimer) return; // already asked
    win.webContents.send("app:closing");
    closeTimer = setTimeout(approveClose, CLOSE_WAIT_MS);
  });
  const contents = win.webContents;
  const id = contents.id;
  contents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: "deny" }; });
  contents.on("will-navigate", (e, url) => {
    if (!url.startsWith(ORIGIN)) { e.preventDefault(); openOutside(url); }
  });
  contents.on("did-start-navigation", (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    rollbackFor(id);
    pageWatchesClose = false; // the new page registers again once its data is open
  });
  contents.on("render-process-gone", () => rollbackFor(id));
  contents.on("destroyed", () => rollbackFor(id));
  void win.loadURL(`${ORIGIN}/dashboard`);
}

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  if (app.isPackaged) Menu.setApplicationMenu(null);
  serveApp();
  createWindow();
});

app.on("window-all-closed", () => app.quit());

// Close the database cleanly before exiting.
let closed = false;
app.on("will-quit", (e) => {
  if (closed || !dbPromise) return;
  e.preventDefault();
  for (const tx of transactions.values()) tx.rollback(new Error("The app is closing"));
  dbPromise
    .then((db) => db.close())
    .then(() => writeDurably(SESSION_FILE, JSON.stringify({ open: false, closedAt: new Date().toISOString() })))
    .catch(() => {})
    .finally(() => { closed = true; app.quit(); });
});
