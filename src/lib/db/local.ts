import { desktop, type DesktopBridge } from "../desktop";
import { saveBackup } from "./backups";
import { exportSnapshot, type Snapshot, type SqlDb } from "./snapshot";
import { SCHEMA_VERSION } from "./schema";
import { SQLITE_BASE_VERSION, SQLITE_MIGRATIONS, SQLITE_SCHEMA } from "./sqlite-schema";

/** The app only runs as the desktop app: the database is in its main process, reached through the bridge. */
export class NotDesktopError extends Error {
  constructor() {
    super("Meridian Payroll runs in its desktop window. Start it with `npm run dev` (or the installed app), not in a browser tab.");
  }
}

/** What the app uses of the on-device database. */
export type LocalDb = SqlDb & { exec(sql: string): Promise<unknown> };

let dbPromise: Promise<LocalDb> | undefined;

/** The on-device database: an encrypted SQLite file in the desktop app's main process (electron/database.mjs). */
export function localDb(): Promise<LocalDb> {
  if (typeof window === "undefined") return Promise.reject(new Error("The local database only runs in the app"));
  if (!desktop) return Promise.reject(new NotDesktopError());
  dbPromise ??= openDesktopDb(desktop).catch((e) => {
    dbPromise = undefined;
    throw e;
  });
  return dbPromise;
}

/** The bridge as a LocalDb: queries go to the main process; a transaction holds the database until it ends. */
export function bridgeDb(bridge: DesktopBridge): LocalDb {
  const sql = (txId?: number) => ({
    query: <T>(text: string, params?: unknown[]) => bridge.db.query<T>(text, params, txId),
    exec: (text: string) => bridge.db.exec(text, txId),
  });
  return {
    ...sql(),
    transaction: async (fn) => {
      const id = await bridge.db.begin();
      let result;
      try {
        result = await fn(sql(id));
      } catch (e) {
        await bridge.db.end(id, false).catch(() => {});
        throw e;
      }
      await bridge.db.end(id, true);
      return result;
    },
  };
}

async function openDesktopDb(bridge: DesktopBridge): Promise<LocalDb> {
  const db = bridgeDb(bridge);
  await migrate(db, backupBeforeUpdate);
  // After a crash or power cut, read every table before trusting the database (the main process has already checked
  // every page); damage shows up here, on the recovery screen, rather than halfway through some later page.
  if ((await bridge.session()).uncleanSince) {
    try {
      await exportSnapshot(db);
    } catch (e) {
      throw new Error(`The app didn't close normally last time, and the data can't be read completely: ${(e as Error).message}`);
    }
  }
  return db;
}

const backupBeforeUpdate = (snapshot: Snapshot) => saveBackup("before-update", snapshot);

/**
 * Brings the database to SCHEMA_VERSION. A new one gets the whole schema at once (SQLITE_SCHEMA, version 12); later
 * changes are SQLITE_MIGRATIONS, each committed atomically with its version number. When an existing database is
 * about to change, `backup` saves a copy of it first (stamped with its current version); if that fails, nothing is
 * changed.
 */
export async function migrate(db: LocalDb, backup?: (snapshot: Snapshot) => Promise<unknown>) {
  await db.exec(`create table if not exists _migrations (version integer primary key, applied_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`);
  const { rows } = await db.query<{ v: number | null }>("select max(version) as v from _migrations");
  const current = rows[0]?.v ?? 0;
  if (current === 0) {
    await db.transaction(async (tx) => {
      await (tx as LocalDb).exec(SQLITE_SCHEMA);
      await tx.query("insert into _migrations (version) values ($1)", [SQLITE_BASE_VERSION]);
    });
  } else if (current < SCHEMA_VERSION && backup) {
    await backup(await exportSnapshot(db, current));
  }
  for (let v = Math.max(current, SQLITE_BASE_VERSION) + 1; v <= SCHEMA_VERSION; v++) {
    await db.transaction(async (tx) => {
      await (tx as LocalDb).exec(SQLITE_MIGRATIONS[v - SQLITE_BASE_VERSION - 1]!);
      await tx.query("insert into _migrations (version) values ($1)", [v]);
    });
  }
  // Undo history lives in memory, so any log a closed session left behind (the database outlives the page) goes.
  await db.query("select meridian_set('undo_log', '')");
  await db.query("delete from _undo_log");
}

// Kept here too for existing imports; they live in meta.ts so privacy.ts and snapshot.ts can use them without a cycle.
export { changeSeq, getMeta, setMeta } from "./meta";
