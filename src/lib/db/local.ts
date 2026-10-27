import type { PGlite, Transaction } from "@electric-sql/pglite";
import { desktop, type DesktopBridge } from "../desktop";
import { saveBackup } from "./backups";
import { LOCAL_MIGRATIONS } from "./schema";
import { exportSnapshot, type Snapshot, type Sql, type SqlDb } from "./snapshot";

export const LOCAL_DB_NAME = "meridian-payroll";
const LOCK_NAME = "meridian-payroll-db";

export class OtherTabError extends Error {
  constructor() {
    super("The payroll app is already open in another tab or window. Close it there, then reload this tab.");
  }
}

/** What the app uses of the on-device database, in the browser and in the desktop app alike. */
export type LocalDb = SqlDb & { exec(sql: string): Promise<unknown> };

let dbPromise: Promise<LocalDb> | undefined;

/**
 * The on-device database: Postgres compiled to WebAssembly. In the browser it runs in this tab and is
 * stored in IndexedDB, and only one tab may hold it open (two writers on the same IndexedDB store can
 * corrupt it). In the desktop app it runs in the app's main process on a real data folder.
 */
export function localDb(): Promise<LocalDb> {
  if (typeof window === "undefined") return Promise.reject(new Error("The local database only runs in the browser"));
  dbPromise ??= (desktop ? openDesktopDb(desktop) : openLocalDb()).catch((e) => {
    dbPromise = undefined;
    throw e;
  });
  return dbPromise;
}

async function openLocalDb(): Promise<PGlite> {
  await acquireTabLock();
  const { PGlite, types } = await import("@electric-sql/pglite");
  const db = new PGlite(`idb://${LOCAL_DB_NAME}`, {
    // Match what Supabase/PostgREST returns: numbers for numeric, strings for dates and times.
    parsers: {
      [types.NUMERIC]: (v: string) => Number(v),
      [types.DATE]: (v: string) => v,
      [types.TIMESTAMPTZ]: (v: string) => v,
      [types.TIMESTAMP]: (v: string) => v,
    },
  });
  await db.waitReady;
  saveAfterTransactions(db);
  await migrate(db, backupBeforeUpdate);
  void requestPersistentStorage();
  return db;
}

async function openDesktopDb(bridge: DesktopBridge): Promise<LocalDb> {
  const sql = (txId?: number) => ({
    query: <T>(text: string, params?: unknown[]) => bridge.db.query<T>(text, params, txId),
    exec: (text: string) => bridge.db.exec(text, txId),
  });
  const db: LocalDb = {
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
  await migrate(db, backupBeforeUpdate);
  // After a crash or power cut, read every table before trusting the database; damage shows up here
  // (and sends the user to the recovery screen) rather than halfway through some later page.
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
 * PGlite copies the database to IndexedDB after each statement, except inside a transaction, and (as of
 * 0.5.8) it still counts COMMIT as inside, so a transaction's changes only reached IndexedDB when some later
 * query happened to run; closing the tab before that lost them. Save explicitly once every transaction
 * commits, so a write is on disk before the app reports it saved.
 */
function saveAfterTransactions(db: PGlite) {
  const transaction = db.transaction.bind(db);
  db.transaction = (async <T>(fn: (tx: Transaction) => Promise<T>) => {
    const result = await transaction(fn);
    await db.syncToFs();
    return result;
  }) as PGlite["transaction"];
}

/**
 * Runs pending LOCAL_MIGRATIONS. Each one commits atomically with its version number. When an existing
 * database is about to change, `backup` saves a copy of it first (stamped with its current version,
 * which equals the number of migrations applied); if that fails, nothing is changed.
 */
export async function migrate(db: LocalDb, backup?: (snapshot: Snapshot) => Promise<unknown>) {
  await db.exec(`set time zone 'UTC'; create table if not exists _migrations (version integer primary key, applied_at timestamptz not null default now())`);
  const { rows } = await db.query<{ v: number | null }>("select max(version) as v from _migrations");
  const current = rows[0]?.v ?? 0;
  if (backup && current > 0 && current < LOCAL_MIGRATIONS.length) await backup(await exportSnapshot(db, current));
  for (let v = current + 1; v <= LOCAL_MIGRATIONS.length; v++) {
    await db.transaction(async (tx) => {
      await (tx as Sql & { exec(sql: string): Promise<unknown> }).exec(LOCAL_MIGRATIONS[v - 1]!);
      await tx.query("insert into _migrations (version) values ($1)", [v]);
    });
  }
}

function acquireTabLock(): Promise<void> {
  if (!("locks" in navigator)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    navigator.locks
      .request(LOCK_NAME, { ifAvailable: true }, (lock) => {
        if (!lock) { reject(new OtherTabError()); return; }
        resolve();
        // Hold the lock for the life of the tab.
        return new Promise<void>(() => {});
      })
      .catch(reject);
  });
}

/** Asks the browser not to evict this site's storage under disk pressure. (The desktop app's data is ordinary files.) */
export async function requestPersistentStorage(): Promise<boolean | null> {
  if (desktop) return true;
  if (!navigator.storage?.persist) return null;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}

// _meta holds sync bookkeeping. It has no change trigger, so writing it never counts as a data change.
export async function getMeta(sql: Sql, key: string): Promise<string | null> {
  const { rows } = await sql.query<{ value: string }>("select value from _meta where key = $1", [key]);
  return rows[0]?.value ?? null;
}

export async function setMeta(sql: Sql, key: string, value: string | null) {
  if (value === null) await sql.query("delete from _meta where key = $1", [key]);
  else await sql.query("insert into _meta (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value", [key, value]);
}

export async function changeSeq(sql: Sql): Promise<number> {
  return Number((await getMeta(sql, "change_seq")) ?? 0);
}
