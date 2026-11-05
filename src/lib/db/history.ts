import { getMeta } from "./meta";
import type { Row, Sql } from "./snapshot";
import type { UndoOp } from "./undo";

// The edit history: a permanent record of every change made on this device, kept in the database's own `_history`
// table (schema 13). It's built on the undo log: every write already runs as an undo step that knows each row it
// changed, before and after (undo.ts), so after each step that step is saved here too, and undo and redo add their
// own entries. Restores add an entry without row images (a whole database is too big to keep each time).
// It holds private details' before/after values, so it never goes to the cloud; local backups and drive copies carry
// it (snapshot.ts `history`), and restoring adds the backup's entries to this device's (by id, so none twice).

export type HistoryKind = "edit" | "undo" | "redo" | "restore";
export type HistoryEntry = {
  id: string; at: string; device: string | null; kind: HistoryKind; label: string;
  changes: UndoOp[]; employees: string[]; rows: string[];
};

/** The employee a row belongs to: an employee's own id, or the employee_id of their records, rates, deductions… */
const employeeOf = (tbl: string, row: Row | null) => (!row ? null : tbl === "employees" ? row["id"] : row["employee_id"]);

/** What an entry touched, for "this employee's history" and "this record's history". */
export function touched(ops: UndoOp[]) {
  const employees = new Set<string>();
  const rows = new Set<string>();
  for (const o of ops) {
    for (const r of [o.old, o.new]) {
      const e = employeeOf(o.tbl, r);
      if (typeof e === "string") employees.add(e);
      if (r && typeof r["id"] === "string") rows.add(r["id"]);
    }
  }
  return { employees: [...employees], rows: [...rows] };
}

/** Saves one entry. `ops` in the order they were applied, so an undo's are the step's, reversed and swapped. */
export async function addHistory(sql: Sql, kind: HistoryKind, label: string, ops: UndoOp[] = []) {
  const { employees, rows } = touched(ops);
  await sql.query(
    "insert into _history (device, kind, label, changes, employees, rows) values ($1, $2, $3, $4, $5, $6)",
    [await getMeta(sql, "device_name"), kind, label, JSON.stringify(ops), JSON.stringify(employees), JSON.stringify(rows)],
  );
}

/** What an undo or redo of a step wrote, as it was applied: undo runs the step backwards, from each row's after to its before. */
export const replayedOps = (ops: UndoOp[], what: "undo" | "redo"): UndoOp[] =>
  what === "redo" ? ops : [...ops].reverse().map((o) => ({
    tbl: o.tbl, op: o.op === "INSERT" ? "DELETE" : o.op === "DELETE" ? "INSERT" : "UPDATE", old: o.new, new: o.old,
  }));

export type HistoryFilter = {
  employeeId?: string | undefined; rowId?: string | undefined; from?: string | undefined; to?: string | undefined;
  kinds?: HistoryKind[] | undefined; text?: string | undefined;
};

type Stored = Omit<HistoryEntry, "changes" | "employees" | "rows"> & { changes: string; employees: string; rows: string };
const parse = (r: Stored): HistoryEntry => ({ ...r, changes: JSON.parse(r.changes) as UndoOp[], employees: JSON.parse(r.employees) as string[], rows: JSON.parse(r.rows) as string[] });

/**
 * Entries matching the filter, newest first, one page at a time. `from`/`to` are local calendar days. `text` matches
 * the label or any value written (a name, an amount), ignoring case.
 */
export async function listHistory(sql: Sql, filter: HistoryFilter = {}, offset = 0, limit = 50): Promise<{ entries: HistoryEntry[]; total: number }> {
  const where = [
    "($1 is null or exists (select 1 from json_each(_history.employees) where value = $1))",
    "($2 is null or exists (select 1 from json_each(_history.rows) where value = $2))",
    "($3 is null or date(at, 'localtime') >= $3)",
    "($4 is null or date(at, 'localtime') <= $4)",
    "($5 is null or kind in (select value from json_each($5)))",
    "($6 is null or instr(lower(label), lower($6)) > 0 or instr(lower(changes), lower($6)) > 0)",
  ].join(" and ");
  const params = [filter.employeeId ?? null, filter.rowId ?? null, filter.from ?? null, filter.to ?? null,
    filter.kinds?.length ? JSON.stringify(filter.kinds) : null, filter.text?.trim() || null];
  const { rows } = await sql.query<Stored>(`select * from _history where ${where} order by at desc, rowid desc limit ${Number(limit)} offset ${Number(offset)}`, params);
  const { rows: n } = await sql.query<{ n: number }>(`select count(*) as n from _history where ${where}`, params);
  return { entries: rows.map(parse), total: Number(n[0]?.n ?? 0) };
}

/** Every entry, oldest first, for a backup. Empty for a database from before the history existed. */
export async function allHistory(sql: Sql): Promise<HistoryEntry[]> {
  const { rows: has } = await sql.query("select 1 from sqlite_master where type = 'table' and name = '_history'");
  if (!has.length) return [];
  return (await sql.query<Stored>("select * from _history order by at, rowid")).rows.map(parse);
}

/** Adds a backup's entries this device doesn't have yet (by id), so restoring never loses or doubles history. */
export async function mergeHistory(sql: Sql, entries: unknown) {
  if (!Array.isArray(entries)) return;
  for (const e of entries as Partial<HistoryEntry>[]) {
    if (!e || typeof e.id !== "string" || typeof e.at !== "string" || typeof e.label !== "string") continue;
    const kind = (["edit", "undo", "redo", "restore"] as const).includes(e.kind as HistoryKind) ? e.kind : "edit";
    await sql.query(
      "insert into _history (id, at, device, kind, label, changes, employees, rows) values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (id) do nothing",
      [e.id, e.at, e.device ?? null, kind, e.label, JSON.stringify(e.changes ?? []), JSON.stringify(e.employees ?? []), JSON.stringify(e.rows ?? [])],
    );
  }
}

/** Removes entries older than `keepDays` days (null keeps everything). Returns how many went. */
export async function pruneHistory(sql: Sql, keepDays: number | null, now = Date.now()): Promise<number> {
  if (!keepDays) return 0;
  const cutoff = new Date(now - keepDays * 86_400_000).toISOString();
  const { rows } = await sql.query<{ n: number }>("select count(*) as n from _history where at < $1", [cutoff]);
  if (Number(rows[0]?.n ?? 0)) await sql.query("delete from _history where at < $1", [cutoff]);
  return Number(rows[0]?.n ?? 0);
}
