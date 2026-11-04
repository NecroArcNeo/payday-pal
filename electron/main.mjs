// Meridian Payroll desktop app (Electron main process).
//
// The pages are the static build in dist/client, served from app://meridian/.
// The payroll database runs here, in Node: one SQLite file (database.mjs) in a folder
// under the app's own AppData folder. Automatic backups are JSON files beside it.
// Neither goes in Documents: OneDrive may sync it, which would copy ID numbers
// to Microsoft's cloud (and could copy the database mid-write). Copies meant to
// leave the computer are the downloaded backup files, which are encrypted.
// The page reaches both only through the bridge in preload.cjs.
//
// Both are encrypted on the disk (SQLCipher for the database, sealed files for backups) with a data key
// kept in keyring.json (keyring.mjs). Without an app password, Windows unlocks that key for this user account
// and the app opens as usual; with one, nothing in the folder can be read until it's typed. Until the key is
// unlocked, every database and backup call is refused.

import { app, BrowserWindow, ipcMain, Menu, net, protocol, safeStorage, shell } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDatabase, runQuery, transactionGate } from "./database.mjs";
import * as keyring from "./keyring.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.join(here, "..", "dist", "client");
const ORIGIN = "app://meridian";
// `npm run dev`: the pages come from the Vite dev server (hot reload) instead of dist/client.
const DEV_URL = process.env.MERIDIAN_DEV_URL;
const PAGE_ORIGIN = DEV_URL ? new URL(DEV_URL).origin : ORIGIN;

app.setName("Meridian Payroll");
// MERIDIAN_HOME puts everything in one other folder (for testing, or running from a USB stick).
const HOME = process.env.MERIDIAN_HOME;
// The same folder in development and when installed (the package name would otherwise pick it in development).
app.setPath("userData", HOME ? path.join(HOME, "app") : path.join(app.getPath("appData"), "Meridian Payroll"));
// The database folder: payroll.db, plus SQLite's write-ahead log beside it while it's open.
const DATA_DIR = path.join(app.getPath("userData"), "database");
const DB_FILE = path.join(DATA_DIR, "payroll.db");
const BACKUP_DIR = path.join(app.getPath("userData"), "Backups");
// Says whether the database is open. Still "open" at startup means the last session never closed it:
// a crash, a power cut or a forced quit.
const SESSION_FILE = path.join(app.getPath("userData"), "session.json");
const KEYRING_FILE = path.join(app.getPath("userData"), "keyring.json");
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

/** The SQLCipher key: derived from the data key, so one key never serves two purposes. 64 hex characters. */
const databaseKey = (key) => Buffer.from(crypto.hkdfSync("sha256", key, Buffer.alloc(0), "meridian database", 32)).toString("hex");

/** A database folder from before SQLite (Postgres' files): moved aside, never deleted, so a backup can be restored. */
let movedOldDatabase = null;
function setAsideOldDatabase() {
  if (!fs.existsSync(path.join(DATA_DIR, "PG_VERSION"))) return;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  movedOldDatabase = path.join(path.dirname(DATA_DIR), `database-pglite-${stamp}`);
  fs.renameSync(DATA_DIR, movedOldDatabase);
}

/** The open connection, and what clears its one-transaction flags (database.mjs). Opened on first use. */
let opened = null;
function database() {
  if (opened) return opened;
  if (!dataKey) throw new Error("The app is locked");
  setAsideOldDatabase();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let conn;
  try {
    conn = openDatabase(DB_FILE, databaseKey(dataKey));
    // Reads every page and checks it (its HMAC included), so damage shows up now, on the recovery screen, rather
    // than halfway through a payroll run. A few milliseconds for a payroll-sized file.
    const check = conn.db.pragma("quick_check", { simple: true });
    if (check !== "ok") throw new Error(`The database file is damaged (${String(check).replace(/\s+/g, " ").slice(0, 100)}…)`);
  } catch (e) {
    try { conn?.db.close(); } catch { /* already unusable */ }
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(/not a database|malformed|corrupt/i.test(why) ? `The database file is damaged or was changed outside the app (${why})` : why);
  }
  opened = conn;
  writeDurably(SESSION_FILE, JSON.stringify({ open: true, startedAt: new Date().toISOString() }));
  return opened;
}

// One transaction at a time, as one connection allows (transactionGate, database.mjs): while the page has one open, its
// other queries (and any other transaction) wait for it to end. A page that reloads or crashes mid-transaction is
// rolled back, so a page that's gone can't hold the database.
const gate = transactionGate(() => database());
const rollbackAll = () => gate.rollback();

/** Closes the database (if it opened) and moves its folder aside, never deleting it. Returns where it went. */
async function setAsideDatabase() {
  await requireUnlocked();
  rollbackAll();
  if (opened) {
    try { opened.db.close(); } catch { /* it never opened properly */ }
    opened = null;
  }
  if (!fs.existsSync(DATA_DIR)) return null;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const aside = path.join(path.dirname(DATA_DIR), `database-damaged-${stamp}`);
  fs.renameSync(DATA_DIR, aside);
  return aside;
}

/** Runs a handler and returns its result or a plain error, so the page sees SQLite's own message. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, value: await fn(event, ...args) };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  });
}

handle("db:query", async (_e, sql, params, txId) => {
  await requireUnlocked();
  return gate.run(txId, (db) => runQuery(db, sql, params ?? []));
});
handle("db:exec", async (_e, sql, txId) => {
  await requireUnlocked();
  return gate.run(txId, (db) => { db.exec(sql); return null; });
});
handle("db:begin", async (event) => {
  await requireUnlocked();
  const owner = event.sender.id;
  const page = pageGeneration(owner);
  // The page may have reloaded while this waited its turn; then nobody would ever end it.
  return gate.begin(owner, () => pageGeneration(owner) === page);
});
handle("db:end", async (_e, txId, commit) => {
  gate.end(txId, commit);
  return null;
});

const generations = new Map();
const pageGeneration = (ownerId) => generations.get(ownerId) ?? 0;
function rollbackFor(ownerId) {
  generations.set(ownerId, pageGeneration(ownerId) + 1);
  if (gate.owner === ownerId) rollbackAll();
}

// ---------------------------------------------------------------- security

let ring = null; // keyring.json's contents
let dataKey = null; // only while unlocked
let securityError = null; // why the keyring can't be used at all
let deviceFailed = false; // there's no password, but Windows couldn't unlock the key (another computer or account)
let encryptError = null; // sealing old backups failed: they stay as they were, and it's tried again next start
let failures = 0; // wrong passwords or keys in a row

let rewrapDevice = false; // Windows rotated its key: the device wrap should be made again with the new one
/** Windows' protection for this user account (DPAPI); `protect` is null where the system has none. */
async function device() {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return { protect: null, unprotect: async () => { throw new Error("No safe storage"); } };
  return {
    protect: (s) => safeStorage.encryptStringAsync(s),
    unprotect: async (b) => {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(b);
      rewrapDevice ||= shouldReEncrypt;
      return result;
    },
  };
}

function saveKeyring(next) {
  writeDurably(KEYRING_FILE, JSON.stringify(next, null, 2));
  ring = next;
}

/** Backups from before encryption: sealed in place, each checked before it replaces the original. */
function sealOldBackups() {
  for (const id of backupIds()) {
    const file = backupFile(id);
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; } // damaged: left alone, as listing does
    if (keyring.isSealed(raw)) continue;
    const sealed = sealBackup(raw);
    if (JSON.stringify(keyring.unseal(dataKey, sealed)) !== JSON.stringify(raw)) throw new Error(`Backup ${id} didn't seal correctly`);
    writeDurably(file, JSON.stringify(sealed));
    infoCache.delete(file);
  }
}

/** Once the key is known: seal backups still unsealed. A failure leaves them as they were. */
function afterUnlock() {
  failures = 0;
  try {
    sealOldBackups();
    encryptError = null;
  } catch (e) {
    encryptError = e instanceof Error ? e.message : String(e);
  }
}

/** Reads the keyring (making one on first run) and unlocks it if there's no password. */
async function prepareSecurity() {
  try {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(KEYRING_FILE, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw new Error(`keyring.json can't be read (${e.message})`);
    }
    if (raw && !keyring.validKeyring(raw)) throw new Error("keyring.json is damaged");
    if (!raw) {
      // Never make a new key for data that already has one: it couldn't open it.
      if (fs.existsSync(DB_FILE)) throw new Error("keyring.json, which holds the key to this computer's payroll data, is missing");
      const { protect } = await device();
      const made = await keyring.createKeyring(protect);
      if (protect) await windowsKeySaved();
      saveKeyring(made.ring);
      dataKey = made.dataKey;
    } else {
      ring = raw;
      try {
        dataKey = await keyring.unlockWithDevice(ring, (await device()).unprotect);
      } catch {
        deviceFailed = true;
      }
      if (dataKey && rewrapDevice) saveKeyring(await keyring.removePassword(ring, dataKey, (await device()).protect));
    }
    if (dataKey) afterUnlock();
  } catch (e) {
    securityError = e instanceof Error ? e.message : String(e);
  }
}

/**
 * Windows' protection (safeStorage) encrypts with a key Chromium keeps in the "Local State" file, which it writes some
 * seconds after first use. A keyring saved before that, then a crash or power cut, would leave a device wrap nothing can
 * open (and with no password yet, no recovery key either): the data would be locked for good. So the first keyring
 * waits until that key is on the disk. Dying while waiting loses nothing: no keyring or data exists yet.
 */
async function windowsKeySaved(timeoutMs = 120_000) {
  const file = path.join(app.getPath("userData"), "Local State");
  for (const started = Date.now(); Date.now() - started < timeoutMs; await wait(250)) {
    try {
      if (JSON.parse(fs.readFileSync(file, "utf8"))?.os_crypt?.encrypted_key) return;
    } catch { /* not written yet, or mid-write */ }
  }
  throw new Error("Windows didn't finish setting up the protection for this computer's key. Close the app and open it again.");
}

/** Set up once the app is ready (safeStorage needs that); every database and backup call waits for it. */
let securityReady = null;
async function requireUnlocked() {
  await securityReady;
  if (securityError) throw new Error(securityError);
  if (!dataKey) throw new Error("The app is locked");
  return dataKey;
}

function securityStatus() {
  return {
    state: securityError ? "error" : dataKey ? "unlocked" : "locked",
    error: securityError,
    ...(ring ? keyring.keyringStatus(ring) : { password: false, recovery: false, cloud: false, keyringId: null }),
    deviceFailed,
    encrypted: true,
    justEncrypted: false,
    encryptError,
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** A wrong guess makes the next answer slower (up to 30 s), so guessing through the app takes forever. */
async function guarded(check) {
  try {
    return await check();
  } catch (e) {
    if (!(e instanceof keyring.WrongKeyError)) throw e;
    failures++;
    await wait(Math.min(30_000, 500 * 2 ** (failures - 1)));
    throw e;
  }
}

/**
 * Unlocks with `open` (checking a password, recovery key or escrow key). After a forgotten password,
 * `newPassword` replaces it (null: no password from now on).
 */
async function unlockWith(open, newPassword) {
  await securityReady;
  if (securityError) throw new Error(securityError);
  if (dataKey) return securityStatus();
  if (newPassword) checkedPassword(newPassword);
  const key = await guarded(open);
  if (newPassword !== undefined) {
    saveKeyring(newPassword ? await keyring.setPassword(ring, key, newPassword) : await keyring.removePassword(ring, key, (await device()).protect));
  }
  dataKey = key;
  deviceFailed = false;
  afterUnlock();
  return securityStatus();
}

const MIN_PASSWORD_LENGTH = 8; // as backup-crypto.ts
function checkedPassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) throw new Error(`The password needs at least ${MIN_PASSWORD_LENGTH} characters`);
  return password;
}

/** Changes need the current password, if there is one: someone at an unlocked computer can't quietly change it. */
async function confirmCurrent(current) {
  const key = await requireUnlocked();
  if (ring.wraps.password) await guarded(() => keyring.unlockWithPassword(ring, String(current ?? "")));
  failures = 0;
  return key;
}

handle("security:status", async () => {
  await securityReady;
  return securityStatus();
});
handle("security:unlock", (_e, password) => unlockWith(() => keyring.unlockWithPassword(ring, String(password))));
handle("security:recover", (_e, text, newPassword) => unlockWith(() => keyring.unlockWithRecovery(ring, String(text)), newPassword ?? null));
handle("security:recover-cloud", (_e, escrowKey, newPassword) => unlockWith(() => keyring.unlockWithEscrow(ring, String(escrowKey)), newPassword ?? null));
/** Sets or changes the password. The first time, also makes the recovery key, returned to show once. */
handle("security:set-password", async (_e, current, next) => {
  checkedPassword(next);
  const key = await confirmCurrent(current);
  let updated = await keyring.setPassword(ring, key, next);
  let recoveryKey = null;
  if (!updated.wraps.recovery) ({ ring: updated, text: recoveryKey } = keyring.newRecoveryKey(updated, key));
  saveKeyring(updated);
  return { status: securityStatus(), recoveryKey };
});
handle("security:remove-password", async (_e, current) => {
  const key = await confirmCurrent(current);
  saveKeyring(await keyring.removePassword(ring, key, (await device()).protect));
  return securityStatus();
});
handle("security:new-recovery-key", async (_e, current) => {
  const key = await confirmCurrent(current);
  const { ring: updated, text } = keyring.newRecoveryKey(ring, key);
  saveKeyring(updated);
  return { status: securityStatus(), recoveryKey: text };
});
/** Email reset on: returns the escrow key for the page to put in the cloud account, filed under the keyring's id. */
handle("security:enable-cloud-reset", async (_e, current) => {
  const key = await confirmCurrent(current);
  const { ring: updated, escrowKey } = keyring.enableEscrow(ring, key);
  saveKeyring(updated);
  return { status: securityStatus(), escrowKey };
});
/**
 * When the key can't be had (keyring.json lost or damaged, or the password and recovery key both forgotten):
 * moves the database and keyring aside, never deleting them, and starts again with a new key and no data, to
 * restore a backup file into. With the old keyring.json and its password, the old folder can still be opened.
 */
handle("security:start-over", async () => {
  await securityReady;
  if (dataKey) throw new Error("The app is already unlocked");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  if (fs.existsSync(DATA_DIR)) fs.renameSync(DATA_DIR, path.join(path.dirname(DATA_DIR), `database-locked-${stamp}`));
  if (fs.existsSync(KEYRING_FILE)) fs.renameSync(KEYRING_FILE, path.join(path.dirname(KEYRING_FILE), `keyring-${stamp}.json`));
  securityError = null;
  deviceFailed = false;
  ring = null;
  await prepareSecurity();
  return securityStatus();
});
handle("security:disable-cloud-reset", async () => {
  await requireUnlocked();
  saveKeyring(keyring.disableEscrow(ring));
  return securityStatus();
});

// ---------------------------------------------------------------- backups
// One file per backup: <id>.json holding { id, created_at, reason, counts, snapshot }, sealed with the data key
// (keyring.mjs): everything but the snapshot stays readable, so listing needs no decryption.

/** A backup record, sealed: its details readable, its snapshot not. */
function sealBackup(record) {
  const { snapshot: _skip, ...header } = record;
  return keyring.seal(dataKey, header, record);
}

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

handle("backups:add", async (_e, record) => {
  await requireUnlocked();
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const id = (backupIds().at(-1) ?? 0) + 1;
  writeDurably(backupFile(id), JSON.stringify(sealBackup({ id, ...record })));
  return id;
});
handle("backups:get", async (_e, id) => {
  const key = await requireUnlocked();
  const file = backupFile(id);
  if (!fs.existsSync(file)) return undefined;
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return keyring.isSealed(raw) ? keyring.unseal(key, raw) : raw;
});
// Each file's details (everything but the snapshot), read once per file version. The folder is the
// truth: files added, changed or removed outside the app show up on the next listing.
const infoCache = new Map();
handle("backups:list", async () => (await requireUnlocked(), backupIds()).map((id) => {
  const file = backupFile(id);
  try {
    const stamp = fs.statSync(file).mtimeMs;
    const hit = infoCache.get(file);
    if (hit?.stamp === stamp) return hit.info;
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const { snapshot: _skip, ...info } = keyring.isSealed(raw) ? keyring.sealedHeader(raw) : raw;
    infoCache.set(file, { stamp, info });
    return info;
  } catch {
    return null; // a damaged file is left alone and skipped
  }
}).filter(Boolean));
handle("backups:delete", async (_e, ids) => {
  await requireUnlocked();
  for (const id of ids) {
    fs.rmSync(backupFile(id), { force: true });
    infoCache.delete(backupFile(id));
  }
  return null;
});

handle("desktop:info", () => ({ dataDir: DATA_DIR, backupDir: BACKUP_DIR, computerName: os.hostname() }));
handle("desktop:session", () => ({ uncleanSince: lastSession?.open ? lastSession.startedAt ?? null : null, movedOldDatabase }));
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
    if (!url.startsWith(PAGE_ORIGIN)) { e.preventDefault(); openOutside(url); }
  });
  contents.on("did-start-navigation", (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    rollbackFor(id);
    pageWatchesClose = false; // the new page registers again once its data is open
  });
  contents.on("render-process-gone", () => rollbackFor(id));
  contents.on("destroyed", () => rollbackFor(id));
  void win.loadURL(`${DEV_URL ?? ORIGIN}/dashboard`);
}

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  securityReady = Promise.resolve().then(prepareSecurity);
  if (app.isPackaged) Menu.setApplicationMenu(null);
  serveApp();
  createWindow();
});

app.on("window-all-closed", () => app.quit());

// Close the database cleanly before exiting: SQLite folds its write-ahead log back into the file.
app.on("will-quit", () => {
  if (!opened) return;
  rollbackAll();
  try {
    opened.db.close();
    opened = null;
    writeDurably(SESSION_FILE, JSON.stringify({ open: false, closedAt: new Date().toISOString() }));
  } catch { /* the next start checks the file anyway */ }
});
