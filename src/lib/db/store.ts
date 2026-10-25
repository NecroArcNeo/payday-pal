import type { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/types";
import { supabase } from "@/integrations/supabase/client";
import { localDb } from "./local";
import { tableColumns, type Row, type Sql, type SqlDb } from "./snapshot";
import type { TableName } from "./schema";

type Employee = Tables<"employees">;
type RecordWithEmp = Tables<"time_records"> & {
  employees: Pick<Employee, "first_name" | "last_name" | "employee_code" | "hourly_rate"> | null;
};
type EditableTable = Exclude<TableName, "payroll_settings">;
export type SettingsInput = { ot_threshold: number; ot_multiplier: number; weekend_overtime: boolean; visible_columns: string[] };
type Result = { error: Error | null };
/** Narrows a records list. `employeeIds: []` matches nothing; leave it out to match everyone. */
export type RecordFilter = { from?: string | undefined; to?: string | undefined; mode?: "clock" | "hours" | undefined; employeeIds?: string[] | undefined };
export type RecordKey = Pick<Tables<"time_records">, "employee_id" | "work_date" | "entry_mode" | "clock_in" | "clock_out" | "hours">;
const RECORD_KEY_COLUMNS = "employee_id, work_date, entry_mode, clock_in, clock_out, hours";

/** Everything the pages read or write. One implementation per place the data can live. */
export interface DataStore {
  kind: "local" | "cloud";
  listEmployees(): Promise<Employee[]>;
  listRecords(from?: string, to?: string): Promise<RecordWithEmp[]>;
  listFieldDefs(): Promise<Tables<"employee_field_defs">[]>;
  listShifts(): Promise<Tables<"shifts">[]>;
  listAdjustments(from?: string, to?: string): Promise<Tables<"pay_adjustments">[]>;
  /** One page of records matching the filter, newest first, plus how many match in total. */
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
}

/** The cap the pages have always used for record lists. */
const RECORD_LIMIT = 1000;

const toError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));
async function attempt(fn: () => Promise<unknown>): Promise<Result> {
  try { await fn(); return { error: null }; } catch (e) { return { error: toError(e) }; }
}

// ---------------------------------------------------------------- local

const RECORD_WHERE = `($1::date is null or r.work_date >= $1::date) and ($2::date is null or r.work_date <= $2::date)
  and ($3::text is null or r.entry_mode = $3) and ($4::uuid[] is null or r.employee_id = any($4::uuid[]))`;
const recordParams = (f: RecordFilter) => [f.from || null, f.to || null, f.mode ?? null, f.employeeIds ?? null];

async function knownColumns(sql: Sql, table: TableName, keys: string[]) {
  const cols = await tableColumns(sql, table);
  const bad = keys.filter((k) => !cols.includes(k));
  if (bad.length) throw new Error(`Unknown column(s) for ${table}: ${bad.join(", ")}`);
  return keys.map((k) => `"${k}"`).join(", ");
}

/** Inserts rows grouped by which columns they set, so omitted columns get their defaults. */
async function insertRows(sql: Sql, table: TableName, rows: Row[], conflictColumn?: string) {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const key = Object.keys(r).filter((k) => r[k] !== undefined).sort().join(",");
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const [key, group] of groups) {
    const keys = key.split(",");
    const list = await knownColumns(sql, table, keys);
    let conflict = "";
    if (conflictColumn) {
      const sets = keys.filter((k) => k !== "id" && k !== conflictColumn).map((k) => `"${k}" = excluded."${k}"`);
      conflict = `on conflict ("${conflictColumn}") ${sets.length ? `do update set ${sets.join(", ")}` : "do nothing"}`;
    }
    await sql.query(
      `insert into ${table} (${list}) select ${list} from jsonb_populate_recordset(null::${table}, $1::jsonb) ${conflict}`,
      [JSON.stringify(group)],
    );
  }
}

export function createLocalStore(getDb: () => Promise<SqlDb>): DataStore {
  return {
    kind: "local",
    async listEmployees() {
      const db = await getDb();
      return (await db.query<Employee>("select * from employees order by last_name")).rows;
    },
    async listRecords(from, to) {
      const db = await getDb();
      const { rows } = await db.query<RecordWithEmp>(
        `select r.*, case when e.id is null then null else jsonb_build_object(
            'first_name', e.first_name, 'last_name', e.last_name, 'employee_code', e.employee_code, 'hourly_rate', e.hourly_rate) end as employees
         from time_records r left join employees e on e.id = r.employee_id
         where ($1::date is null or r.work_date >= $1::date) and ($2::date is null or r.work_date <= $2::date)
         order by r.work_date desc limit ${RECORD_LIMIT}`,
        [from ?? null, to ?? null],
      );
      return rows;
    },
    async listRecordsPage(filter, offset, limit) {
      const db = await getDb();
      return db.transaction(async (tx) => {
        const { rows } = await tx.query<RecordWithEmp>(
          `select r.*, case when e.id is null then null else jsonb_build_object(
              'first_name', e.first_name, 'last_name', e.last_name, 'employee_code', e.employee_code, 'hourly_rate', e.hourly_rate) end as employees
           from time_records r left join employees e on e.id = r.employee_id
           where ${RECORD_WHERE} order by r.work_date desc, r.created_at desc, r.id limit $5 offset $6`,
          [...recordParams(filter), limit, offset],
        );
        const { rows: n } = await tx.query<{ n: number }>(`select count(*)::int as n from time_records r where ${RECORD_WHERE}`, recordParams(filter));
        return { rows, total: n[0]?.n ?? 0 };
      });
    },
    async listRecordsMatching(filter) {
      const db = await getDb();
      return (await db.query<Tables<"time_records">>(`select r.* from time_records r where ${RECORD_WHERE} order by r.work_date desc, r.id`, recordParams(filter))).rows;
    },
    async listFieldDefs() {
      const db = await getDb();
      return (await db.query<Tables<"employee_field_defs">>("select * from employee_field_defs order by sort_order, created_at")).rows;
    },
    async listShifts() {
      const db = await getDb();
      return (await db.query<Tables<"shifts">>("select * from shifts order by sort_order, created_at")).rows;
    },
    async listAdjustments(from, to) {
      const db = await getDb();
      return (await db.query<Tables<"pay_adjustments">>(
        `select * from pay_adjustments where ($1::date is null or pay_date >= $1::date) and ($2::date is null or pay_date <= $2::date)
         order by pay_date desc`,
        [from ?? null, to ?? null],
      )).rows;
    },
    async listRecordKeys(from, to) {
      const db = await getDb();
      return (await db.query<RecordKey>(`select ${RECORD_KEY_COLUMNS} from time_records where work_date between $1::date and $2::date`, [from, to])).rows;
    },
    async getSettings() {
      const db = await getDb();
      return (await db.query<Tables<"payroll_settings">>("select * from payroll_settings limit 1")).rows[0] ?? null;
    },
    insert: (table, rows) => attempt(async () => {
      const db = await getDb();
      // All-or-nothing, like a bulk insert to the cloud.
      await db.transaction((tx) => insertRows(tx, table, (Array.isArray(rows) ? rows : [rows]) as Row[]));
    }),
    update: (table, id, patch) => attempt(async () => {
      const db = await getDb();
      const keys = Object.keys(patch).filter((k) => k !== "id" && (patch as Row)[k] !== undefined);
      if (!keys.length) return;
      const list = await knownColumns(db, table, keys);
      await db.query(`update ${table} set (${list}) = (select ${list} from jsonb_populate_record(null::${table}, $1::jsonb)) where id = $2`, [JSON.stringify(patch), id]);
    }),
    remove: (table, id) => attempt(async () => {
      const db = await getDb();
      await db.query(`delete from ${table} where id = $1`, [id]);
    }),
    async updateMany(table, rows) {
      const r = await attempt(async () => {
        const db = await getDb();
        await db.transaction(async (tx) => {
          for (const { id, patch } of rows) {
            const keys = Object.keys(patch).filter((k) => k !== "id" && (patch as Row)[k] !== undefined);
            if (!keys.length) continue;
            const list = await knownColumns(tx, table, keys);
            await tx.query(`update ${table} set (${list}) = (select ${list} from jsonb_populate_record(null::${table}, $1::jsonb)) where id = $2`, [JSON.stringify(patch), id]);
          }
        });
      });
      return { ...r, updated: r.error ? 0 : rows.length };
    },
    removeMany: (table, ids) => attempt(async () => {
      const db = await getDb();
      await db.query(`delete from ${table} where id = any($1::uuid[])`, [ids]);
    }),
    upsertEmployeesByCode: (rows) => attempt(async () => {
      const db = await getDb();
      await db.transaction((tx) => insertRows(tx, "employees", rows as Row[], "employee_code"));
    }),
    saveSettings: (s) => attempt(async () => {
      const db = await getDb();
      await db.query(
        `insert into payroll_settings (id, ot_threshold, ot_multiplier, weekend_overtime, visible_columns, updated_at) values (true, $1, $2, $4, $3, now())
         on conflict (id) do update set ot_threshold = excluded.ot_threshold, ot_multiplier = excluded.ot_multiplier, weekend_overtime = excluded.weekend_overtime,
           visible_columns = excluded.visible_columns, updated_at = excluded.updated_at`,
        [s.ot_threshold, s.ot_multiplier, s.visible_columns, s.weekend_overtime],
      );
    }),
  };
}

export const localStore = createLocalStore(localDb);

// ---------------------------------------------------------------- cloud
// Rows carry owner_id (defaulted to the signed-in user); RLS limits every query to that user's rows.

/** Employee ids go in the request URL, so very broad employee searches are refused rather than failing obscurely. */
const MAX_CLOUD_EMPLOYEE_FILTER = 200;
function filterRecords<Q extends { gte: (c: string, v: string) => Q; lte: (c: string, v: string) => Q; eq: (c: string, v: string) => Q; in: (c: string, v: string[]) => Q }>(q: Q, f: RecordFilter): Q {
  if (f.from) q = q.gte("work_date", f.from);
  if (f.to) q = q.lte("work_date", f.to);
  if (f.mode) q = q.eq("entry_mode", f.mode);
  if (f.employeeIds) {
    if (f.employeeIds.length > MAX_CLOUD_EMPLOYEE_FILTER) throw new Error(`The search matches ${f.employeeIds.length} employees; narrow it to ${MAX_CLOUD_EMPLOYEE_FILTER} or fewer when editing the cloud.`);
    q = q.in("employee_id", f.employeeIds.length ? f.employeeIds : ["00000000-0000-0000-0000-000000000000"]);
  }
  return q;
}

const check = <T>({ data, error }: { data: T | null; error: { message: string } | null }): T => {
  if (error) throw new Error(error.message);
  return data as T;
};
const wrap = (p: PromiseLike<{ error: { message: string } | null }>): Promise<Result> =>
  Promise.resolve(p).then(({ error }) => ({ error: error ? new Error(error.message) : null }), (e) => ({ error: toError(e) }));

export const cloudStore: DataStore = {
  kind: "cloud",
  async listEmployees() {
    return check(await supabase.from("employees").select("*").order("last_name"));
  },
  async listRecords(from, to) {
    let q = supabase
      .from("time_records")
      .select("*, employees(first_name,last_name,employee_code,hourly_rate)")
      .order("work_date", { ascending: false })
      .limit(RECORD_LIMIT);
    if (from) q = q.gte("work_date", from);
    if (to) q = q.lte("work_date", to);
    return check(await q) as RecordWithEmp[];
  },
  async listRecordsPage(filter, offset, limit) {
    const q = filterRecords(supabase.from("time_records").select("*, employees(first_name,last_name,employee_code,hourly_rate)", { count: "exact" }), filter);
    const { data, error, count } = await q.order("work_date", { ascending: false }).order("created_at", { ascending: false }).order("id").range(offset, offset + limit - 1);
    if (error) throw new Error(error.message);
    return { rows: (data ?? []) as RecordWithEmp[], total: count ?? 0 };
  },
  async listRecordsMatching(filter) {
    const out: Tables<"time_records">[] = [];
    for (let start = 0; ; start += 1000) {
      const page = check(await filterRecords(supabase.from("time_records").select("*"), filter).order("id").range(start, start + 999)) as Tables<"time_records">[];
      out.push(...page);
      if (page.length < 1000) return out;
    }
  },
  async listFieldDefs() {
    return check(await supabase.from("employee_field_defs").select("*").order("sort_order").order("created_at"));
  },
  async listShifts() {
    return check(await supabase.from("shifts").select("*").order("sort_order").order("created_at"));
  },
  async listAdjustments(from, to) {
    let q = supabase.from("pay_adjustments").select("*").order("pay_date", { ascending: false });
    if (from) q = q.gte("pay_date", from);
    if (to) q = q.lte("pay_date", to);
    return check(await q);
  },
  async listRecordKeys(from, to) {
    // The API returns at most 1000 rows per request, so page through.
    const out: RecordKey[] = [];
    for (let start = 0; ; start += 1000) {
      const page = check(await supabase.from("time_records").select(RECORD_KEY_COLUMNS).gte("work_date", from).lte("work_date", to)
        .order("id").range(start, start + 999)) as RecordKey[];
      out.push(...page);
      if (page.length < 1000) return out;
    }
  },
  async getSettings() {
    return check(await supabase.from("payroll_settings").select("*").maybeSingle());
  },
  insert: (table, rows) => wrap(supabase.from(table).insert(rows as never)),
  update: (table, id, patch) => wrap(supabase.from(table as "employees").update(patch as never).eq("id", id)),
  remove: (table, id) => wrap(supabase.from(table as "employees").delete().eq("id", id)),
  async updateMany(table, rows) {
    let updated = 0;
    for (const { id, patch } of rows) {
      const { error } = await wrap(supabase.from(table as "employees").update(patch as never).eq("id", id));
      if (error) return { error: new Error(`${error.message} (${updated} of ${rows.length} were updated before this)`), updated };
      updated++;
    }
    return { error: null, updated };
  },
  removeMany: (table, ids) => wrap(supabase.from(table as "employees").delete().in("id", ids)),
  upsertEmployeesByCode: (rows) => wrap(supabase.from("employees").upsert(rows as never, { onConflict: "owner_id,employee_code" })),
  saveSettings: (s) => wrap(supabase.from("payroll_settings").upsert({ ...s, updated_at: new Date().toISOString() } as never, { onConflict: "owner_id" })),
};
