import type { PGlite } from "@electric-sql/pglite";
import { LOCAL_MIGRATIONS } from "./schema";
import type { Sql, SqlDb } from "./snapshot";

export const LOCAL_DB_NAME = "meridian-payroll";
const LOCK_NAME = "meridian-payroll-db";

export class OtherTabError extends Error {
  constructor() {
    super("The payroll app is already open in another tab or window. Close it there, then reload this tab.");
  }
}

let dbPromise: Promise<PGlite> | undefined;

/**
 * The on-device database (Postgres compiled to WebAssembly, stored in IndexedDB).
 * Only one tab may hold it open: two writers on the same IndexedDB store can corrupt it.
 */
export function localDb(): Promise<PGlite> {
  if (typeof window === "undefined") return Promise.reject(new Error("The local database only runs in the browser"));
  dbPromise ??= openLocalDb().catch((e) => {
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
  await migrate(db);
  void requestPersistentStorage();
  return db;
}

/** Runs pending LOCAL_MIGRATIONS. Each one commits atomically with its version number. */
export async function migrate(db: SqlDb & { exec(sql: string): Promise<unknown> }) {
  await db.exec(`set time zone 'UTC'; create table if not exists _migrations (version integer primary key, applied_at timestamptz not null default now())`);
  const { rows } = await db.query<{ v: number | null }>("select max(version) as v from _migrations");
  const current = rows[0]?.v ?? 0;
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

/** Asks the browser not to evict this site's storage under disk pressure. */
export async function requestPersistentStorage(): Promise<boolean | null> {
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
