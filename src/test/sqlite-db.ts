// An in-memory payroll database for tests, opened the way the desktop app opens its file (electron/database.mjs: the
// same pragmas, SQL functions and transaction gate) and reached the way the page reaches it (bridgeDb, with the IPC
// left out), then brought to the current schema by the app's own migrate().
// @ts-expect-error: the Electron main process's plain-JS module
import { openDatabase, runQuery, transactionGate } from "../../electron/database.mjs";
import { bridgeDb, migrate, type LocalDb } from "@/lib/db/local";
import type { DesktopBridge } from "@/lib/desktop";

type Raw = { exec(sql: string): void };
type Gate = {
  run<T>(txId: number | null | undefined, fn: (db: Raw) => T): Promise<T>;
  begin(owner: unknown): Promise<number>;
  end(txId: number, commit: boolean): void;
};

export function rawMemoryDb(): LocalDb {
  const conn = openDatabase(":memory:");
  const gate = transactionGate(() => conn) as Gate;
  // As main.mjs's db:* handlers answer the page: each call settles later (as IPC does), errors included.
  const db = {
    query: (sql: string, params?: unknown[], txId?: number) => gate.run(txId, (d) => runQuery(d, sql, params ?? [])),
    exec: (sql: string, txId?: number) => gate.run(txId, (d) => { d.exec(sql); return null; }),
    begin: () => gate.begin("test"),
    end: async (txId: number, commit: boolean) => { gate.end(txId, commit); },
  };
  return bridgeDb({ db } as unknown as DesktopBridge);
}

/** A new, empty payroll database at the current schema. */
export async function memoryDb(): Promise<LocalDb> {
  const db = rawMemoryDb();
  await migrate(db);
  return db;
}
