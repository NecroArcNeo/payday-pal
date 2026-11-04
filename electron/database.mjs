// The desktop payroll database: one SQLite file encrypted by SQLCipher (better-sqlite3-multiple-ciphers). Every page
// of the file is encrypted and carries its own HMAC, so a page changed on disk (by damage or by hand) is refused
// instead of read. The main process opens it here, and the tests open in-memory copies the same way, so both get
// the same settings and the same SQL functions.
import Database from "better-sqlite3-multiple-ciphers";

/**
 * Opens (or creates) the database. `keyHex` is the 32-byte database key as 64 hex characters; leave it out for an
 * unencrypted database (tests only). Returns the connection and `endTransaction()`, which the owner calls after every
 * commit or rollback to clear the flags that last only for one transaction.
 */
export function openDatabase(file, keyHex) {
  const db = new Database(file);
  if (keyHex !== undefined) {
    if (!/^[0-9a-f]{64}$/i.test(keyHex)) throw new Error("The database key must be 64 hex characters");
    // SQLCipher 4's format: AES-256 with a per-page HMAC-SHA512. A raw key skips the password stretching, since the
    // key is already random (it comes from the keyring).
    db.pragma("cipher = 'sqlcipher'");
    db.pragma("legacy = 4");
    db.pragma(`key = "x'${keyHex}'"`);
    // Reading something proves the key: a wrong one fails here with "file is not a database".
    db.prepare("select count(*) from sqlite_master").get();
  }
  // WAL: a commit appends to the log and is flushed to disk before it's reported (synchronous = FULL), so a power cut
  // never loses a saved change or leaves the file half-written.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  return { db, ...sessionFlags(db) };
}

/**
 * Postgres' session settings (current_setting/set_config), which the triggers read, as SQL functions:
 * - meridian_flag(name) is the flag's value or null; meridian_set(name, value) sets it ('' or null clears it).
 * - meridian_bypass(+1 / -1) nests the lock bypass, so a trigger can lift it for one statement and put back what was
 *   there (the rate history keeps the old rate "since the start" this way).
 * `replaying` and `bypass_lock` last one transaction (endTransaction clears them); `undo_log` lasts until changed.
 */
function sessionFlags(db) {
  const flags = new Map();
  let bypass = 0;
  db.function("meridian_flag", { deterministic: false }, (name) => {
    if (name === "bypass_lock" && bypass > 0) return "on";
    return flags.get(name) ?? null;
  });
  db.function("meridian_set", { deterministic: false }, (name, value) => {
    if (value === null || value === undefined || value === "") flags.delete(name);
    else flags.set(name, String(value));
    return null;
  });
  db.function("meridian_bypass", { deterministic: false }, (step) => {
    bypass = Math.max(0, bypass + step);
    return null;
  });
  return {
    endTransaction() {
      flags.delete("replaying");
      flags.delete("bypass_lock");
      bypass = 0;
    },
  };
}

/**
 * One transaction at a time over one connection: while one is open, every other query and transaction waits for it to
 * end. `connection()` gives the open connection ({ db, endTransaction }); it's called only once something is ready to
 * run. The check "no transaction is open" and what it guards always run in the same tick, with no await between: an
 * await there would let a waiting `begin` start a transaction first, and a query meant to run on its own would then
 * run inside it (and be rolled back with it), or a second `begin` would fail inside the first.
 */
export function transactionGate(connection) {
  /** The open transaction: its id, who began it, and a promise that settles when it ends. */
  let tx = null;
  let nextId = 1;
  const finish = (commit) => {
    const t = tx;
    if (!t) return;
    const conn = connection();
    try {
      if (conn.db.inTransaction) conn.db.exec(commit ? "commit" : "rollback");
    } finally {
      conn.endTransaction();
      tx = null;
      t.end();
    }
  };
  return {
    get owner() { return tx?.owner ?? null; },
    /** Runs `fn(db)` inside transaction `txId`, or (null) on its own once no transaction is open. */
    async run(txId, fn) {
      if (txId == null) while (tx) await tx.ended;
      else if (tx?.id !== txId) throw new Error("The transaction has already finished");
      return fn(connection().db);
    },
    /** Begins a transaction once none is open; `stillWanted()` is asked first (the page may have gone while it waited). */
    async begin(owner, stillWanted = () => true) {
      while (tx) await tx.ended;
      if (!stillWanted()) throw new Error("The page closed");
      connection().db.exec("begin immediate");
      let end;
      const ended = new Promise((r) => { end = r; });
      tx = { id: nextId++, owner, ended, end };
      return tx.id;
    },
    end(txId, commit) {
      if (tx?.id !== txId) throw new Error("The transaction has already finished");
      finish(commit);
    },
    /** Rolls back the open transaction, if any (a page gone mid-transaction, or the database closing). */
    rollback() {
      try { finish(false); } catch { /* the connection is closing anyway */ }
    },
  };
}

/** better-sqlite3 binds only numbers, strings, bigints, buffers and null. */
function bindable(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value !== null && typeof value === "object" && !Buffer.isBuffer(value)) return JSON.stringify(value);
  return value;
}

/**
 * One statement: its rows if it returns any, else how many rows it changed. Parameters are written `$1`, `$2`… as in
 * Postgres (SQLite reads them as names, so they're bound by number from the list) or `?`.
 */
export function runQuery(db, sql, params = []) {
  const stmt = db.prepare(sql);
  const list = params.map(bindable);
  const values = /\$\d/.test(sql) ? [Object.fromEntries(list.map((v, i) => [String(i + 1), v]))] : list;
  if (stmt.reader) return { rows: stmt.all(...values), affectedRows: 0 };
  return { rows: [], affectedRows: stmt.run(...values).changes };
}
