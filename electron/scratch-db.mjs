// The scratch database the page restores a backup into to check it (src/lib/db/backup-check.ts), kept in a worker
// thread (scratch-worker.mjs) so the real database's thread never waits on it. The worker starts when a check opens
// it and ends when the check closes it, so nothing is held between checks. Should a worker fail to start, the same
// calls run on this thread instead: the check still runs, it just shares the thread for its fraction of a second.
import { Worker } from "node:worker_threads";
import { openDatabase, runQuery, transactionGate } from "./database.mjs";

let worker = null;
let nextId = 1;
const waiting = new Map();
/** The same calls on this thread, used only when the worker can't start. */
let inThread = null;

function startWorker() {
  const w = new Worker(new URL("./scratch-worker.mjs", import.meta.url));
  w.on("message", ({ id, ok, value, message }) => {
    const p = waiting.get(id);
    waiting.delete(id);
    if (ok) p?.resolve(value); else p?.reject(new Error(message));
  });
  const fail = (e) => {
    for (const p of waiting.values()) p.reject(e instanceof Error ? e : new Error(String(e)));
    waiting.clear();
    if (worker === w) worker = null;
  };
  w.on("error", fail);
  w.on("exit", () => fail(new Error("The check stopped")));
  return w;
}

function viaWorker(call, args) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, call, args });
  });
}

function threadCalls() {
  let conn = null;
  let gate = null;
  return {
    open() { conn?.db.close(); conn = openDatabase(":memory:"); gate = transactionGate(() => conn); return null; },
    query: (sql, params, txId) => gate.run(txId, (d) => runQuery(d, sql, params ?? [])),
    exec: (sql, txId) => gate.run(txId, (d) => { d.exec(sql); return null; }),
    begin: () => gate.begin("check"),
    end(txId, commit) { gate.end(txId, commit); return null; },
    close() { gate?.rollback(); conn?.db.close(); conn = gate = null; return null; },
  };
}

/** Runs one call on the scratch database. "open" starts it (a worker if it can), "close" ends it. */
export async function scratch(call, ...args) {
  if (call === "open") {
    await scratch("close");
    try {
      worker = startWorker();
      return await viaWorker("open", []);
    } catch (e) {
      console.warn("Backup check: no worker thread, running on the main thread:", e);
      await worker?.terminate().catch(() => {});
      worker = null;
      inThread = threadCalls();
      return inThread.open();
    }
  }
  if (call === "close") {
    if (inThread) { inThread.close(); inThread = null; }
    const w = worker;
    worker = null;
    if (w) await w.terminate().catch(() => {});
    return null;
  }
  if (inThread) return inThread[call](...args);
  if (!worker) throw new Error("The check's database isn't open");
  return viaWorker(call, args);
}
