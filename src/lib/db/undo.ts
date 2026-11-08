import { decodeRow, encodeRow } from "./codec";
import { addHistory, replayedOps } from "./history";
import { localDb } from "./local";
import { TABLES, type TableName } from "./schema";
import { canonical, tableColumns, type Row, type Sql, type SqlDb } from "./snapshot";
import type { DataStore } from "./store";

/** One row written: what it was before (null for an insert) and after (null for a delete), as the database logged it. */
export type UndoOp = { tbl: TableName; op: "INSERT" | "UPDATE" | "DELETE"; old: Row | null; new: Row | null };
/** Everything one action wrote, triggers and cascades included, undone or redone as one. */
export type UndoStep = { label: string; ops: UndoOp[] };

/** The data has changed since the step was recorded, so putting it back would overwrite something else. */
export class StaleUndoError extends Error {
  constructor(what: "undo" | "redo", label: string) {
    super(`Can't ${what} "${label}": that data has changed since (for example by a restore or sync), so nothing was changed.`);
  }
}

/** Steps kept per session. Older ones are dropped; the automatic backups cover anything further back. */
const LIMIT = 100;

/**
 * Session-only undo/redo for the local database. Each action runs with the `_undo_log` triggers on, so the
 * step holds every row it changed, before and after. Undo writes the "before" rows back, newest first; redo writes the
 * "after" rows again. Each row is checked to still be exactly what the step left (or found) first, and the whole step
 * runs in one transaction, so it either fully happens or not at all. The lock triggers apply as to any write.
 */
export class UndoHistory {
  private undoStack: UndoStep[] = [];
  private redoStack: UndoStep[] = [];
  private depth = 0;
  private listeners = new Set<() => void>();
  private version = 0;

  constructor(private getDb: () => Promise<SqlDb>) {}

  /**
   * Runs `fn` as one undoable step. Steps started inside it join it (the outermost label wins). If `fn` throws after
   * writing something (a rate's history saved, then the lock refusing the next entry), what it wrote is undone at
   * once, so an action made of several writes either fully happens or not at all.
   */
  async record<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (this.depth > 0) return fn();
    this.depth++;
    const sql = await this.getDb().catch((e) => { this.depth--; throw e; });
    let ops: UndoOp[] = [];
    let failed = false;
    try {
      await sql.query("delete from _undo_log");
      await sql.query("select meridian_set('undo_log', 'on')");
      return await fn();
    } catch (e) {
      failed = true;
      throw e;
    } finally {
      try {
        await sql.query("select meridian_set('undo_log', '')");
        ops = (await sql.query<{ tbl: TableName; op: UndoOp["op"]; old: string | null; new: string | null }>("select tbl, op, old, new from _undo_log order by seq")).rows
          .map((r) => ({ tbl: r.tbl, op: r.op, old: logged(r.tbl, r.old), new: logged(r.tbl, r.new) }));
        await sql.query("delete from _undo_log");
        // Put back what a failed action wrote; if even that fails, keep it as a step so Ctrl+Z can try again.
        if (failed && ops.length) {
          try { await this.replay({ label, ops }, "undo"); ops = []; } catch { /* kept below */ }
        }
      } finally {
        this.depth--;
      }
      if (ops.length) {
        // The permanent record (history.ts). A failure there is reported but never undoes the change itself.
        await addHistory(sql, "edit", label, ops).catch((e: unknown) => console.error("Edit history not saved:", e));
        this.undoStack.push({ label, ops });
        if (this.undoStack.length > LIMIT) this.undoStack.shift();
        this.redoStack = [];
        this.changed();
      }
    }
  }

  get nextUndo(): string | null { return this.undoStack.at(-1)?.label ?? null; }
  get nextRedo(): string | null { return this.redoStack.at(-1)?.label ?? null; }

  /** Undoes the latest step; its label, or null when there's nothing to undo. */
  undo(): Promise<string | null> { return this.move("undo"); }
  redo(): Promise<string | null> { return this.move("redo"); }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.changed();
  }

  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  /** Changes whenever the stacks do (for useSyncExternalStore). */
  getVersion = () => this.version;

  private changed() {
    this.version++;
    for (const l of this.listeners) l();
  }

  private async move(what: "undo" | "redo"): Promise<string | null> {
    if (this.depth > 0) throw new Error("Wait for the change in progress to finish first.");
    const from = what === "undo" ? this.undoStack : this.redoStack;
    const step = from.at(-1);
    if (!step) return null;
    this.depth++;
    try {
      await this.replay(step, what);
    } catch (e) {
      // Stale history can't come right again; anything else (a lock, say) may, so the step stays.
      if (e instanceof StaleUndoError) this.clear();
      throw e;
    } finally {
      this.depth--;
    }
    from.pop();
    await addHistory(await this.getDb(), what, step.label, replayedOps(step.ops, what)).catch((e: unknown) => console.error("Edit history not saved:", e));
    (what === "undo" ? this.redoStack : this.undoStack).push(step);
    this.changed();
    return step.label;
  }

  /** Writes a step's rows back ("undo") or again ("redo"), in one transaction. */
  private async replay(step: UndoStep, what: "undo" | "redo") {
    const sql = await this.getDb();
    await sql.transaction(async (tx) => {
      await tx.query("select meridian_set('replaying', 'on')");
      // A run can depend on one that comes later (undoing a shift's delete restores the employees moved off it,
      // which needs the shift back first), so a run that fails on a key or a row's state waits for a later pass;
      // only when a whole pass makes no progress has the data really changed since.
      let pending = runs(plan(step, what));
      while (pending.length) {
        const waiting: Change[][] = [];
        let reason: unknown = new StaleUndoError(what, step.label);
        for (const run of pending) {
          await tx.query("savepoint undo_run");
          try {
            if (await apply(tx, run)) { await tx.query("release savepoint undo_run"); continue; }
          } catch (e) {
            if (!/foreign key|unique constraint/i.test((e as Error).message)) throw e;
            reason = e;
          }
          await tx.query("rollback to savepoint undo_run");
          await tx.query("release savepoint undo_run");
          waiting.push(run);
        }
        if (waiting.length === pending.length) throw reason instanceof StaleUndoError ? reason : new StaleUndoError(what, step.label);
        pending = waiting;
      }
    });
  }
}

/** One row to put back, change or remove: what it must be now (null: absent) and what it becomes (null: gone). */
type Change = { tbl: TableName; kind: "put" | "change" | "remove"; now: Row | null; then: Row | null };

/**
 * A step's rows in the order to write them: undo goes newest first, from each row's "after" back to its "before"; redo
 * goes oldest first. The log doesn't follow foreign keys (deleting an employee logs them before the records that went
 * with them), so within a stretch of only put-backs, parents go first, and within one of only removals, children do.
 */
function plan(step: UndoStep, what: "undo" | "redo"): Change[] {
  const changes: Change[] = (what === "undo" ? [...step.ops].reverse() : step.ops).map((o) => {
    const [now, then] = what === "undo" ? [o.new, o.old] : [o.old, o.new];
    return { tbl: o.tbl, kind: now === null ? "put" : then === null ? "remove" : "change", now, then };
  });
  const out: Change[] = [];
  for (let i = 0; i < changes.length;) {
    const kind = changes[i]!.kind;
    let j = i + 1;
    if (kind !== "change") while (j < changes.length && changes[j]!.kind === kind) j++;
    const rank = (c: Change) => TABLES.indexOf(c.tbl) * (kind === "put" ? 1 : -1);
    out.push(...changes.slice(i, j).sort((a, b) => rank(a) - rank(b)));
    i = j;
  }
  return out;
}

/** Consecutive changes of the same kind to the same table, each row at most once, so each run is one statement. */
function runs(changes: Change[]): Change[][] {
  const out: Change[][] = [];
  let ids = new Set<string>();
  for (const c of changes) {
    const last = out.at(-1);
    const id = String((c.then ?? c.now)!["id"]);
    if (last && last[0]!.tbl === c.tbl && last[0]!.kind === c.kind && !ids.has(id)) { last.push(c); ids.add(id); continue; }
    out.push([c]);
    ids = new Set([id]);
  }
  return out;
}

/** A row image from the log (the triggers' json_object of every column), as the app's values. */
function logged(t: TableName, json: string | null): Row | null {
  return json === null ? null : decodeRow(t, JSON.parse(json) as Row);
}

/** The row as it is now, or null. */
async function current(tx: Sql, t: TableName, id: unknown): Promise<Row | null> {
  const { rows } = await tx.query<Row>(`select * from ${t} where id = $1`, [id]);
  return rows[0] ? decodeRow(t, rows[0]) : null;
}
const same = (a: Row | null, b: Row | null) => a !== null && b !== null && canonical(a) === canonical(b);

/**
 * Writes one run, and says whether every row ended up as the step makes it. Only rows still exactly as the step left
 * them are changed or removed, and only missing rows are put back; a row already in its new state counts as done
 * (redoing a shift's delete clears its employees' shift on its own, before their logged change comes up).
 */
async function apply(tx: Sql, run: Change[]): Promise<boolean> {
  const t = run[0]!.tbl;
  if (!TABLES.includes(t)) throw new Error(`Unknown table in undo history: ${t}`);
  const kind = run[0]!.kind;
  const cols = tableColumns(t);
  for (const { now, then } of run) {
    const id = (then ?? now)!["id"];
    const row = await current(tx, t, id);
    if (kind === "put") {
      if (row) continue;
      const enc = encodeRow(t, then!);
      await tx.query(`insert into ${t} (${cols.map((c) => `"${c}"`).join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, cols.map((c) => enc[c] ?? null));
    } else if (kind === "change") {
      if (!same(row, now)) continue;
      const enc = encodeRow(t, then!);
      const set = cols.filter((c) => c !== "id");
      await tx.query(`update ${t} set ${set.map((c, i) => `"${c}" = $${i + 1}`).join(", ")} where id = $${set.length + 1}`, [...set.map((c) => enc[c] ?? null), id]);
    } else {
      if (same(row, now)) await tx.query(`delete from ${t} where id = $1`, [id]);
    }
  }
  for (const { now, then } of run) {
    const row = await current(tx, t, (then ?? now)!["id"]);
    if (kind === "remove" ? row !== null : !same(row, then)) return false;
  }
  return true;
}

const NOUNS: Record<TableName, [string, string]> = {
  employee_field_defs: ["a category", "categories"], shifts: ["a shift", "shifts"], employees: ["an employee", "employees"],
  pay_rates: ["a pay rate", "pay rates"], time_records: ["a record", "records"], pay_adjustments: ["an extra-pay entry", "extra-pay entries"],
  deductions: ["a deduction", "deductions"], pay_runs: ["a pay run", "pay runs"], pay_run_lines: ["a pay run line", "pay run lines"],
  holidays: ["a holiday", "holidays"], work_patterns: ["a weekly pattern", "weekly patterns"],
  payroll_settings: ["the settings", "the settings"],
};
const count = (t: TableName, n: number) => (n === 1 ? NOUNS[t][0] : `${n} ${NOUNS[t][1]}`);

/** The store with every write recorded as one undoable step, labelled after what it did ("deleted 3 records"). */
export function undoableStore(store: DataStore, history: UndoHistory): DataStore {
  const r = history.record.bind(history);
  return {
    ...store,
    insert: (t, rows) => r(`added ${count(t, Array.isArray(rows) ? rows.length : 1)}`, () => store.insert(t, rows)),
    update: (t, id, patch) => r(`edited ${count(t, 1)}`, () => store.update(t, id, patch)),
    remove: (t, id) => r(`deleted ${count(t, 1)}`, () => store.remove(t, id)),
    updateMany: (t, rows) => r(`edited ${count(t, rows.length)}`, () => store.updateMany(t, rows)),
    removeMany: (t, ids) => r(`deleted ${count(t, ids.length)}`, () => store.removeMany(t, ids)),
    upsertEmployeesByCode: (rows) => r(`imported ${count("employees", rows.length)}`, () => store.upsertEmployeesByCode(rows)),
    saveSettings: (s) => r("changed the payroll settings", () => store.saveSettings(s)),
    saveEmployeeDefaults: (d) => r("changed the new-employee defaults", () => store.saveEmployeeDefaults(d)),
    setLockedThrough: (date, freeze) => r(date ? `locked days through ${date}` : "unlocked every day", () => store.setLockedThrough(date, freeze)),
    setRecordsUnlocked: (ids, unlocked, freeze) => r(`${unlocked ? "unlocked" : "locked again"} ${count("time_records", ids.length)}`, () => store.setRecordsUnlocked(ids, unlocked, freeze)),
  };
}

/** This device's undo history (the cloud, edited directly, has none). */
export const localUndo = new UndoHistory(localDb);
