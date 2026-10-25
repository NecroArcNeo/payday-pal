import { SCHEMA_VERSION, TABLES, type TableName } from "./schema";

/** The subset of PGlite this module needs (also satisfied by a PGlite transaction). */
export interface Sql {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface SqlDb extends Sql {
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
}

export type Row = Record<string, unknown>;
export const BACKUP_FORMAT = "meridian-payroll-backup";

/** A full copy of every payroll table. Used for backup files, auto-backups, push and pull. */
export type Snapshot = {
  format: typeof BACKUP_FORMAT;
  schema_version: number;
  created_at: string;
  data: Record<TableName, Row[]>;
};

export type SnapshotCounts = Record<TableName, number>;

export function countRows(s: Snapshot): SnapshotCounts {
  return Object.fromEntries(TABLES.map((t) => [t, s.data[t].length])) as SnapshotCounts;
}

/** The shifts every new database starts with. On their own they aren't data anyone entered. */
const DEFAULT_SHIFTS = [["Day", 1], ["Night", 1]];
const onlyDefaultShifts = (rows: Row[]) =>
  rows.length === DEFAULT_SHIFTS.length && rows.every((r, i) => r["name"] === DEFAULT_SHIFTS[i]![0] && Number(r["multiplier"]) === DEFAULT_SHIFTS[i]![1]);

/** True when nothing has been entered: no rows anywhere, apart from the untouched default shifts. */
export function isEmpty(s: Snapshot) {
  return TABLES.every((t) => s.data[t].length === 0 || (t === "shifts" && onlyDefaultShifts(s.data[t])));
}

export function describeCounts(c: SnapshotCounts) {
  return `${c.employees} employees, ${c.time_records} time records, ${c.pay_adjustments} extra-pay entries`;
}

/** Reads every table. jsonb_agg gives ISO timestamps, matching what the cloud returns. */
export async function exportSnapshot(sql: Sql): Promise<Snapshot> {
  const data = {} as Record<TableName, Row[]>;
  for (const t of TABLES) {
    const order = t === "payroll_settings" ? "id" : t === "shifts" ? "sort_order, created_at, id" : "created_at, id";
    const { rows } = await sql.query<{ rows: Row[] }>(
      `select coalesce(jsonb_agg(x order by ${order}), '[]'::jsonb) as rows from ${t} x`,
    );
    data[t] = rows[0]?.rows ?? [];
  }
  return { format: BACKUP_FORMAT, schema_version: SCHEMA_VERSION, created_at: new Date().toISOString(), data };
}

/** Throws a readable error unless `raw` is a complete snapshot this version of the app can load. */
export function validateSnapshot(raw: unknown): Snapshot {
  const fail = (msg: string): never => { throw new Error(`Not a valid payroll backup: ${msg}`); };
  if (!raw || typeof raw !== "object") fail("file is not a JSON object");
  let s = raw as Partial<Snapshot>;
  if (s.format !== BACKUP_FORMAT) fail("missing backup header");
  s = upgrade(s);
  if (s.schema_version !== SCHEMA_VERSION) {
    fail(`it was made by a ${Number(s.schema_version) > SCHEMA_VERSION ? "newer" : "different"} version of the app (schema ${s.schema_version}, this app uses ${SCHEMA_VERSION})`);
  }
  if (!s.data || typeof s.data !== "object") fail("no data section");
  for (const t of TABLES) {
    const rows = (s.data as Record<string, unknown>)[t];
    if (!Array.isArray(rows)) fail(`table "${t}" is missing`);
    for (const r of rows as unknown[]) {
      if (!r || typeof r !== "object" || Array.isArray(r)) fail(`a row in "${t}" is not an object`);
    }
  }
  if (s.data!.payroll_settings.length > 1) fail("more than one payroll settings row");
  return s as Snapshot;
}

/**
 * Brings backups from older app versions up to the current schema, so every
 * backup ever made stays restorable. Columns added since are filled with their
 * defaults on restore; only new tables need adding here.
 */
function upgrade(s: Partial<Snapshot>): Partial<Snapshot> {
  if (s.schema_version === 1 && s.data && typeof s.data === "object") {
    const data = { ...(s.data as Record<string, unknown>) };
    if (!Array.isArray(data["shifts"])) {
      const now = new Date().toISOString();
      data["shifts"] = [
        { id: crypto.randomUUID(), name: "Day", multiplier: 1, sort_order: 0, created_at: now },
        { id: crypto.randomUUID(), name: "Night", multiplier: 1, sort_order: 1, created_at: now },
      ];
    }
    s = { ...s, schema_version: 2, data: data as Snapshot["data"] };
  }
  // 3 only added employees.pay_type, which restores as its default (hourly).
  if (s.schema_version === 2) s = { ...s, schema_version: 3 };
  // 4 only added employees.gender and nationality, which restore empty.
  if (s.schema_version === 3) s = { ...s, schema_version: 4 };
  // 5 only added payroll_settings.employee_defaults, which restores empty.
  if (s.schema_version === 4) s = { ...s, schema_version: 5 };
  // 6 only added employee ID-document columns and employee_field_defs.section, which restore empty.
  if (s.schema_version === 5) s = { ...s, schema_version: 6 };
  // 7 only added time_records.shift_id, which restores empty (the employee's own shift).
  if (s.schema_version === 6) s = { ...s, schema_version: 7 };
  return s;
}

/**
 * Replaces all local data with the snapshot, atomically: if any row fails to
 * insert, the transaction rolls back and the existing data is untouched.
 */
export async function replaceWithSnapshot(
  db: SqlDb,
  snapshot: Snapshot,
  hooks: { before?: (tx: Sql) => Promise<void>; after?: (tx: Sql) => Promise<void> } = {},
) {
  const s = validateSnapshot(snapshot);
  await db.transaction(async (tx) => {
    if (hooks.before) await hooks.before(tx);
    for (const t of [...TABLES].reverse()) await tx.query(`delete from ${t}`);
    for (const t of TABLES) {
      const rows = s.data[t];
      if (!rows.length) continue;
      const cols = await tableColumns(tx, t);
      // Only columns every row has; anything else falls back to the column default.
      const use = cols.filter((c) => rows.every((r) => c in r));
      if (!use.includes("id")) throw new Error(`Not a valid payroll backup: rows in "${t}" have no id`);
      const list = use.map((c) => `"${c}"`).join(", ");
      await tx.query(`insert into ${t} (${list}) select ${list} from jsonb_populate_recordset(null::${t}, $1::jsonb)`, [JSON.stringify(rows)]);
      const { rows: n } = await tx.query<{ n: number }>(`select count(*)::int as n from ${t}`);
      if (n[0]?.n !== rows.length) throw new Error(`Restore check failed for "${t}": expected ${rows.length} rows, found ${n[0]?.n}`);
    }
    if (hooks.after) await hooks.after(tx);
  });
}

const columnCache = new Map<string, string[]>();
export async function tableColumns(sql: Sql, table: TableName): Promise<string[]> {
  const hit = columnCache.get(table);
  if (hit) return hit;
  const { rows } = await sql.query<{ column_name: string }>(
    `select column_name from information_schema.columns where table_schema = current_schema() and table_name = $1 order by ordinal_position`,
    [table],
  );
  const cols = rows.map((r) => r.column_name);
  if (cols.length) columnCache.set(table, cols);
  return cols;
}
