import type { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/types";
import { localDb } from "./local";
import { decodeRow, encodeRow } from "./codec";
import { insertEncoded, tableColumns, type Row, type Sql, type SqlDb } from "./snapshot";
import type { TableName } from "./schema";
import type { FrozenPay } from "@/lib/pay";
import { localUndo, undoableStore } from "./undo";
import type { Sort, StoreSortKey } from "@/lib/record-sort";

type Employee = Tables<"employees">;
type RecordWithEmp = Tables<"time_records"> & {
  employees: Pick<Employee, "first_name" | "last_name" | "employee_code" | "hourly_rate"> | null;
};
type EditableTable = Exclude<TableName, "payroll_settings">;
/** The settings a save changes; the ones left out stay as they are. */
export type SettingsInput = Partial<{
  ot_threshold: number; ot_multiplier: number; weekend_overtime: boolean; visible_columns: string[];
  deductions_on: boolean; pay_runs_on: boolean; history_keep_days: number | null;
}>;
type Result = { error: Error | null };
/** A record's pay to save as it's locked. */
export type FrozenRow = { id: string; pay: FrozenPay };
/**
 * Narrows a records list. `employeeIds: []` matches nothing; leave it out to match everyone.
 * `shifts` keeps records on any of those shifts: ones set to one of `ids`, plus ones with no shift of their own whose employee is
 * usually on one (`employeeIds`, worked out by the caller with `shiftFor`, since an employee with no shift is on the first one).
 * Excluding shifts is the same as keeping the rest, so the caller passes the shifts left.
 */
export type RecordFilter = { from?: string | undefined; to?: string | undefined; mode?: "clock" | "hours" | undefined; employeeIds?: string[] | undefined; shifts?: { ids: string[]; employeeIds: string[] } | undefined;
  /** How a page is ordered (listRecordsPage only). Newest first by default; ties go newest first. */
  sort?: Sort<StoreSortKey> | undefined };
export type RecordKey = Pick<Tables<"time_records">, "employee_id" | "work_date" | "entry_mode" | "clock_in" | "clock_out" | "hours">;
const RECORD_KEY_COLUMNS = "employee_id, work_date, entry_mode, clock_in, clock_out, hours";

/** Everything the pages read or write: this computer's database. The cloud is reached only by push and pull (sync.ts). */
export interface DataStore {
  listEmployees(): Promise<Employee[]>;
  listRecords(from?: string, to?: string): Promise<RecordWithEmp[]>;
  listFieldDefs(): Promise<Tables<"employee_field_defs">[]>;
  listShifts(): Promise<Tables<"shifts">[]>;
  listAdjustments(from?: string, to?: string): Promise<Tables<"pay_adjustments">[]>;
  /** Every employee's pay rate history, oldest first. */
  listPayRates(): Promise<Tables<"pay_rates">[]>;
  /** Every employee's deductions, in their order. */
  listDeductions(): Promise<Tables<"deductions">[]>;
  /** Public holidays (schema 14), by date. */
  listHolidays(): Promise<Tables<"holidays">[]>;
  /** Saved weekly patterns (schema 14), in their order. */
  listPatterns(): Promise<Tables<"work_patterns">[]>;
  /** Every pay run, newest period first, with each run's lines. */
  listPayRuns(): Promise<{ runs: Tables<"pay_runs">[]; lines: Tables<"pay_run_lines">[] }>;
  /** One page of records matching the filter, ordered by `filter.sort` (newest first by default), plus how many match in total. */
  listRecordsPage(filter: RecordFilter, offset: number, limit: number): Promise<{ rows: RecordWithEmp[]; total: number }>;
  /** Every record matching the filter (no cap), for "edit all". */
  listRecordsMatching(filter: RecordFilter): Promise<Tables<"time_records">[]>;
  /** Every record's identifying fields in a date range (no row cap), for spotting duplicates on import. */
  listRecordKeys(from: string, to: string): Promise<RecordKey[]>;
  getSettings(): Promise<Tables<"payroll_settings"> | null>;
  insert<T extends EditableTable>(table: T, rows: TablesInsert<T> | TablesInsert<T>[]): Promise<Result>;
  update<T extends EditableTable>(table: T, id: string, patch: TablesUpdate<T>): Promise<Result>;
  remove(table: EditableTable, id: string): Promise<Result>;
  /** Applies a different patch to each row. Local: all or nothing. Cloud: one request per row, stopping at the first failure. */
  updateMany<T extends EditableTable>(table: T, rows: { id: string; patch: TablesUpdate<T> }[]): Promise<Result & { updated: number }>;
  /** Deletes all the rows in one statement, so it either fully happens or not at all. */
  removeMany(table: EditableTable, ids: string[]): Promise<Result>;
  /** Insert or update employees matched on employee_code (used by file import). */
  upsertEmployeesByCode(rows: TablesInsert<"employees">[]): Promise<Result>;
  saveSettings(s: SettingsInput): Promise<Result>;
  /** Replaces the default profile new employees start with. Leaves the other settings alone. */
  saveEmployeeDefaults(d: Record<string, unknown>): Promise<Result>;
  /**
   * Locks days up to and including `date` as paid (null unlocks everything), all or nothing: saves `freeze` (the pay of
   * each record being locked, worked out by src/lib/pay-freeze.ts), locks again records unlocked one by one, and clears
   * the saved pay of records the lock no longer covers, so the current rules apply to them. Leaves the other settings alone.
   */
  setLockedThrough(date: string | null, freeze?: FrozenRow[]): Promise<Result>;
  /** Unlocks records on locked days one by one, clearing their saved pay; or locks them again, saving `freeze`. */
  setRecordsUnlocked(ids: string[], unlocked: boolean, freeze?: FrozenRow[]): Promise<Result>;
  /** How many records are unlocked one by one. */
  countUnlockedRecords(): Promise<number>;
}

/** The cap the pages have always used for record lists. */
const RECORD_LIMIT = 1000;

const toError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));
async function attempt(fn: () => Promise<unknown>): Promise<Result> {
  try { await fn(); return { error: null }; } catch (e) { return { error: toError(e) }; }
}

// ---------------------------------------------------------------- local
// SQLite (electron/database.mjs). Values go in through the codec (codec.ts: true → 1, objects → JSON text, money
// rounded to the cent…) and rows come back through it, in the same shapes the cloud and the snapshots use. Lists of
// ids are bound as JSON arrays and read with json_each.

const ids = (list: string[] | undefined | null) => (list ? JSON.stringify(list) : null);
const RECORD_WHERE = `($1 is null or r.work_date >= $1) and ($2 is null or r.work_date <= $2)
  and ($3 is null or r.entry_mode = $3) and ($4 is null or r.employee_id in (select value from json_each($4)))
  and ($5 is null or r.shift_id in (select value from json_each($5)) or (r.shift_id is null and r.employee_id in (select value from json_each($6))))`;
/** ORDER BY for a page of records (`r` joined to its employee `e`): the asked key, then newest first, then id so pages never overlap. */
function recordOrder(sort: Sort<StoreSortKey> | undefined) {
  const dir = sort?.desc === false ? "asc" : "desc";
  const newest = "r.work_date desc, r.created_at desc, r.id";
  switch (sort?.by ?? "date") {
    case "date": return `r.work_date ${dir}, r.created_at ${dir}, r.id`;
    // As names show ("First Last"), ignoring case; records of deleted employees go last.
    case "employee": return `lower(e.first_name) ${dir} nulls last, lower(e.last_name) ${dir} nulls last, ${newest}`;
    case "hours": return `r.hours ${dir} nulls last, ${newest}`;
  }
}
const recordParams = (f: RecordFilter) => [f.from || null, f.to || null, f.mode ?? null, ids(f.employeeIds), ids(f.shifts?.ids), ids(f.shifts?.employeeIds ?? [])];

/** A record with its employee's name and rate, as the cloud's `employees(...)` join gave it. */
const WITH_EMPLOYEE = `select r.*, e.id as e_id, e.first_name as e_first_name, e.last_name as e_last_name,
  e.employee_code as e_employee_code, e.hourly_rate as e_hourly_rate
  from time_records r left join employees e on e.id = r.employee_id`;
function withEmployee(row: Row): RecordWithEmp {
  const { e_id, e_first_name, e_last_name, e_employee_code, e_hourly_rate, ...record } = row;
  return {
    ...decodeRow<Tables<"time_records">>("time_records", record),
    employees: e_id == null ? null : { first_name: e_first_name, last_name: e_last_name, employee_code: e_employee_code, hourly_rate: e_hourly_rate } as RecordWithEmp["employees"],
  };
}

async function list<T>(sql: Sql, table: TableName, query: string, params: unknown[] = []): Promise<T[]> {
  return (await sql.query<Row>(query, params)).rows.map((r) => decodeRow<T>(table, r));
}

function knownColumns(table: TableName, keys: string[]) {
  const cols = tableColumns(table);
  const bad = keys.filter((k) => !cols.includes(k));
  if (bad.length) throw new Error(`Unknown column(s) for ${table}: ${bad.join(", ")}`);
  return keys;
}

/** Inserts rows grouped by which columns they set, so omitted columns get their defaults. */
async function insertRows(sql: Sql, table: TableName, rows: Row[], conflictColumn?: string) {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const key = Object.keys(r).filter((k) => r[k] !== undefined).sort().join(",");
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const [key, group] of groups) {
    const keys = knownColumns(table, key.split(","));
    let conflict = "";
    if (conflictColumn) {
      const sets = keys.filter((k) => k !== "id" && k !== conflictColumn).map((k) => `"${k}" = excluded."${k}"`);
      conflict = `on conflict ("${conflictColumn}") ${sets.length ? `do update set ${sets.join(", ")}` : "do nothing"}`;
    }
    await insertEncoded(sql, table, keys, group, conflict);
  }
}

async function updateRow(sql: Sql, table: TableName, id: string, patch: Row) {
  const keys = knownColumns(table, Object.keys(patch).filter((k) => k !== "id" && patch[k] !== undefined));
  if (!keys.length) return;
  const enc = encodeRow(table, patch);
  await sql.query(`update ${table} set ${keys.map((k, i) => `"${k}" = $${i + 1}`).join(", ")} where id = $${keys.length + 1}`, [...keys.map((k) => enc[k] ?? null), id]);
}

async function saveFrozen(sql: Sql, rows: FrozenRow[]) {
  if (!rows.length) return;
  await sql.query(
    `update time_records set frozen_pay = f.pay
     from (select json_extract(value, '$.id') as id, json(json_extract(value, '$.pay')) as pay from json_each($1)) f
     where time_records.id = f.id`,
    [JSON.stringify(rows)],
  );
}

const now = () => new Date().toISOString();
/** The settings row's upsert, setting only `cols` (the rest keep their values, or their defaults on a new row). */
async function saveSettingsColumns(sql: Sql, values: Row) {
  const enc = encodeRow("payroll_settings", { ...values, updated_at: now() });
  const cols = Object.keys(enc);
  await sql.query(
    `insert into payroll_settings (id, ${cols.join(", ")}) values (1, ${cols.map((_, i) => `$${i + 1}`).join(", ")})
     on conflict (id) do update set ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}`,
    cols.map((c) => enc[c]),
  );
}

export function createLocalStore(getDb: () => Promise<SqlDb>): DataStore {
  return {
    async listEmployees() {
      return list<Employee>(await getDb(), "employees", "select * from employees order by last_name");
    },
    async listRecords(from, to) {
      const db = await getDb();
      const { rows } = await db.query<Row>(
        `${WITH_EMPLOYEE} where ($1 is null or r.work_date >= $1) and ($2 is null or r.work_date <= $2)
         order by r.work_date desc limit ${RECORD_LIMIT}`,
        [from ?? null, to ?? null],
      );
      return rows.map(withEmployee);
    },
    async listRecordsPage(filter, offset, limit) {
      const db = await getDb();
      return db.transaction(async (tx) => {
        const { rows } = await tx.query<Row>(
          `${WITH_EMPLOYEE} where ${RECORD_WHERE} order by ${recordOrder(filter.sort)} limit $7 offset $8`,
          [...recordParams(filter), limit, offset],
        );
        const { rows: n } = await tx.query<{ n: number }>(`select count(*) as n from time_records r where ${RECORD_WHERE}`, recordParams(filter));
        return { rows: rows.map(withEmployee), total: n[0]?.n ?? 0 };
      });
    },
    async listRecordsMatching(filter) {
      return list<Tables<"time_records">>(await getDb(), "time_records", `select r.* from time_records r where ${RECORD_WHERE} order by r.work_date desc, r.id`, recordParams(filter));
    },
    async listFieldDefs() {
      return list<Tables<"employee_field_defs">>(await getDb(), "employee_field_defs", "select * from employee_field_defs order by sort_order, created_at");
    },
    async listShifts() {
      return list<Tables<"shifts">>(await getDb(), "shifts", "select * from shifts order by sort_order, created_at");
    },
    async listAdjustments(from, to) {
      return list<Tables<"pay_adjustments">>(await getDb(), "pay_adjustments",
        `select * from pay_adjustments where ($1 is null or pay_date >= $1) and ($2 is null or pay_date <= $2) order by pay_date desc`,
        [from ?? null, to ?? null]);
    },
    async listPayRates() {
      return list<Tables<"pay_rates">>(await getDb(), "pay_rates", "select * from pay_rates order by employee_id, effective_from");
    },
    async listDeductions() {
      return list<Tables<"deductions">>(await getDb(), "deductions", "select * from deductions order by employee_id, sort_order, created_at");
    },
    async listHolidays() {
      return list<Tables<"holidays">>(await getDb(), "holidays", "select * from holidays order by holiday_date, id");
    },
    async listPatterns() {
      return list<Tables<"work_patterns">>(await getDb(), "work_patterns", "select * from work_patterns order by sort_order, created_at, id");
    },
    async listPayRuns() {
      const db = await getDb();
      return {
        runs: await list<Tables<"pay_runs">>(db, "pay_runs", "select * from pay_runs order by period_to desc, created_at desc"),
        lines: await list<Tables<"pay_run_lines">>(db, "pay_run_lines", "select * from pay_run_lines order by employee_name collate nocase, id"),
      };
    },
    async listRecordKeys(from, to) {
      return list<RecordKey>(await getDb(), "time_records", `select ${RECORD_KEY_COLUMNS} from time_records where work_date between $1 and $2`, [from, to]);
    },
    async getSettings() {
      return (await list<Tables<"payroll_settings">>(await getDb(), "payroll_settings", "select * from payroll_settings limit 1"))[0] ?? null;
    },
    insert: (table, rows) => attempt(async () => {
      const db = await getDb();
      // All-or-nothing, like a bulk insert to the cloud.
      await db.transaction((tx) => insertRows(tx, table, (Array.isArray(rows) ? rows : [rows]) as Row[]));
    }),
    update: (table, id, patch) => attempt(async () => updateRow(await getDb(), table, id, patch as Row)),
    remove: (table, id) => attempt(async () => {
      await (await getDb()).query(`delete from ${table} where id = $1`, [id]);
    }),
    async updateMany(table, rows) {
      const r = await attempt(async () => {
        const db = await getDb();
        await db.transaction(async (tx) => {
          for (const { id, patch } of rows) await updateRow(tx, table, id, patch as Row);
        });
      });
      return { ...r, updated: r.error ? 0 : rows.length };
    },
    removeMany: (table, list) => attempt(async () => {
      await (await getDb()).query(`delete from ${table} where id in (select value from json_each($1))`, [JSON.stringify(list)]);
    }),
    upsertEmployeesByCode: (rows) => attempt(async () => {
      const db = await getDb();
      await db.transaction((tx) => insertRows(tx, "employees", rows as Row[], "employee_code"));
    }),
    saveSettings: (s) => attempt(async () => saveSettingsColumns(await getDb(), Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)))),
    saveEmployeeDefaults: (d) => attempt(async () => saveSettingsColumns(await getDb(), { employee_defaults: d })),
    setLockedThrough: (date, freeze = []) => attempt(async () => {
      const db = await getDb();
      await db.transaction(async (tx) => {
        await saveFrozen(tx, freeze);
        await saveSettingsColumns(tx, { locked_through: date });
        await tx.query("update time_records set unlocked = 0 where unlocked");
        await tx.query("update time_records set frozen_pay = null where frozen_pay is not null and ($1 is null or work_date > $1)", [date]);
      });
    }),
    setRecordsUnlocked: (list, unlocked, freeze = []) => attempt(async () => {
      const db = await getDb();
      await db.transaction(async (tx) => {
        if (!unlocked) await saveFrozen(tx, freeze);
        await tx.query("update time_records set unlocked = $2 where id in (select value from json_each($1)) and unlocked <> $2", [JSON.stringify(list), unlocked ? 1 : 0]);
        if (unlocked) await tx.query("update time_records set frozen_pay = null where id in (select value from json_each($1)) and frozen_pay is not null", [JSON.stringify(list)]);
      });
    }),
    async countUnlockedRecords() {
      return (await (await getDb()).query<{ n: number }>("select count(*) as n from time_records where unlocked")).rows[0]?.n ?? 0;
    },
  };
}

export const localStore = undoableStore(createLocalStore(localDb), localUndo);
