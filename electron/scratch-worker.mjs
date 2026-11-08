// A worker thread holding a scratch database in memory, for checking that a backup restores (src/lib/db/backup-check.ts).
// It runs apart from the main process's thread, so the real database never waits on it. Opened the same way as the
// real one (electron/database.mjs: the same SQL functions and transaction gate), unencrypted, since it's only in memory
// and gone when closed.
import { parentPort } from "node:worker_threads";
import { openDatabase, runQuery, transactionGate } from "./database.mjs";

let conn = null;
let gate = null;

const calls = {
  open() {
    conn?.db.close();
    conn = openDatabase(":memory:");
    gate = transactionGate(() => conn);
    return null;
  },
  query: (sql, params, txId) => gate.run(txId, (d) => runQuery(d, sql, params ?? [])),
  exec: (sql, txId) => gate.run(txId, (d) => { d.exec(sql); return null; }),
  begin: () => gate.begin("check"),
  end(txId, commit) { gate.end(txId, commit); return null; },
  close() {
    gate?.rollback();
    conn?.db.close();
    conn = gate = null;
    return null;
  },
};

parentPort.on("message", async ({ id, call, args }) => {
  try {
    if (call !== "open" && call !== "close" && !conn) throw new Error("The check's database isn't open");
    parentPort.postMessage({ id, ok: true, value: await calls[call](...args) });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, message: e instanceof Error ? e.message : String(e) });
  }
});
