import { PGlite } from "@electric-sql/pglite";

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

let _db: PGlite | null = null;

async function getDb(): Promise<PGlite> {
  if (_db) return _db;
  _db = await new PGlite("idb://meridian-payroll");
  await initSchema(_db);
  return _db;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  employee_code TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  department TEXT,
  hourly_rate NUMERIC(10,2) NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  phone TEXT,
  job_title TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  country TEXT,
  date_of_birth TEXT,
  hire_date TEXT,
  emergency_contact_name TEXT,
  emergency_contact_phone TEXT,
  notes TEXT,
  custom_fields TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS employees_email_unique
  ON employees (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS time_records (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date TEXT NOT NULL,
  entry_mode TEXT NOT NULL DEFAULT 'clock' CHECK (entry_mode IN ('clock','hours')),
  clock_in TEXT,
  clock_out TEXT,
  lunch_minutes INTEGER NOT NULL DEFAULT 0 CHECK (lunch_minutes >= 0),
  hours NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (hours >= 0),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);
CREATE INDEX IF NOT EXISTS time_records_emp_date ON time_records (employee_id, work_date);

CREATE TABLE IF NOT EXISTS employee_field_defs (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL DEFAULT 'text',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);

CREATE TABLE IF NOT EXISTS pay_adjustments (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  pay_date TEXT NOT NULL,
  category TEXT NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);

CREATE TABLE IF NOT EXISTS payroll_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  ot_threshold NUMERIC NOT NULL DEFAULT 40,
  ot_multiplier NUMERIC NOT NULL DEFAULT 1.5,
  visible_columns TEXT NOT NULL DEFAULT '["employee_code","days"]',
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);

CREATE TABLE IF NOT EXISTS sync_meta (
  id TEXT PRIMARY KEY DEFAULT 'singleton',
  last_sync TEXT,
  last_sync_direction TEXT
);
`;

async function initSchema(db: PGlite) {
  const stmts = SCHEMA.split(";").map((s) => s.trim()).filter(Boolean);
  for (const s of stmts) await db.exec(s);
}

function uuid(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function now(): string {
  return new Date().toISOString();
}

function parseJsonField(val: unknown): Json {
  if (val == null) return {};
  if (typeof val === "string") {
    try { return JSON.parse(val) as Json; } catch { return {}; }
  }
  return val as Json;
}

function toJsonString(val: unknown): string {
  if (val == null) return "{}";
  if (typeof val === "string") {
    try { JSON.parse(val); return val; } catch { return "{}"; }
  }
  return JSON.stringify(val);
}

function parseArrayField(val: unknown): string[] {
  if (val == null) return [];
  if (Array.isArray(val)) return val as string[];
  if (typeof val === "string") {
    if (val.startsWith("[") || val.startsWith("{")) {
      try { return JSON.parse(val.replace(/^\{/, "[").replace(/\}$/, "]")) as string[]; } catch { return []; }
    }
    return val.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

// ─── Row types ──────────────────────────────────────────────

export interface EmployeeRow {
  id: string;
  user_id: string | null;
  employee_code: string;
  first_name: string;
  last_name: string;
  email: string | null;
  department: string | null;
  hourly_rate: number;
  active: boolean;
  created_at: string;
  phone: string | null;
  job_title: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  date_of_birth: string | null;
  hire_date: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  notes: string | null;
  custom_fields: Json;
}

export interface TimeRecordRow {
  id: string;
  employee_id: string;
  work_date: string;
  entry_mode: string;
  clock_in: string | null;
  clock_out: string | null;
  lunch_minutes: number;
  hours: number;
  note: string | null;
  created_at: string;
}

export interface FieldDefRow {
  id: string;
  label: string;
  field_type: string;
  sort_order: number;
  created_at: string;
}

export interface AdjustmentRow {
  id: string;
  employee_id: string;
  pay_date: string;
  category: string;
  amount: number;
  note: string | null;
  created_at: string;
}

export interface PayrollSettingsRow {
  id: boolean;
  ot_threshold: number;
  ot_multiplier: number;
  visible_columns: string[];
  updated_at: string;
}

export interface RecordWithEmp extends TimeRecordRow {
  employees: Pick<EmployeeRow, "first_name" | "last_name" | "employee_code" | "hourly_rate"> | null;
}

// ─── Helpers ────────────────────────────────────────────────

function mapEmployee(row: Record<string, unknown>): EmployeeRow {
  return {
    id: String(row.id),
    user_id: row.user_id as string | null,
    employee_code: String(row.employee_code),
    first_name: String(row.first_name),
    last_name: String(row.last_name),
    email: row.email as string | null,
    department: row.department as string | null,
    hourly_rate: Number(row.hourly_rate),
    active: Boolean(row.active),
    created_at: String(row.created_at),
    phone: row.phone as string | null,
    job_title: row.job_title as string | null,
    address_line1: row.address_line1 as string | null,
    address_line2: row.address_line2 as string | null,
    city: row.city as string | null,
    state: row.state as string | null,
    postal_code: row.postal_code as string | null,
    country: row.country as string | null,
    date_of_birth: row.date_of_birth as string | null,
    hire_date: row.hire_date as string | null,
    emergency_contact_name: row.emergency_contact_name as string | null,
    emergency_contact_phone: row.emergency_contact_phone as string | null,
    notes: row.notes as string | null,
    custom_fields: parseJsonField(row.custom_fields),
  };
}

function mapTimeRecord(row: Record<string, unknown>): TimeRecordRow {
  return {
    id: String(row.id),
    employee_id: String(row.employee_id),
    work_date: String(row.work_date),
    entry_mode: String(row.entry_mode),
    clock_in: row.clock_in as string | null,
    clock_out: row.clock_out as string | null,
    lunch_minutes: Number(row.lunch_minutes),
    hours: Number(row.hours),
    note: row.note as string | null,
    created_at: String(row.created_at),
  };
}

function computeHours(clockIn: string, clockOut: string, lunch: number): number {
  const [ih = 0, im = 0] = clockIn.split(":").map(Number);
  const [oh = 0, om = 0] = clockOut.split(":").map(Number);
  let mins = oh * 60 + om - (ih * 60 + im);
  if (mins < 0) mins += 1440;
  return Math.max(0, Math.round((mins - lunch) / 60 * 100) / 100);
}

// ─── Public API ─────────────────────────────────────────────

export const localDb = {
  async getEmployees(): Promise<EmployeeRow[]> {
    const db = await getDb();
    const result = await db.query("SELECT * FROM employees ORDER BY last_name, first_name");
    return result.rows.map((r) => mapEmployee(r as Record<string, unknown>));
  },

  async getEmployee(id: string): Promise<EmployeeRow | null> {
    const db = await getDb();
    const result = await db.query("SELECT * FROM employees WHERE id = $1", [id]);
    return result.rows.length ? mapEmployee(result.rows[0] as Record<string, unknown>) : null;
  },

  async insertEmployee(data: Partial<EmployeeRow> & { employee_code: string; first_name: string; last_name: string }): Promise<void> {
    const db = await getDb();
    const id = data.id ?? uuid();
    await db.query(
      `INSERT INTO employees (id, user_id, employee_code, first_name, last_name, email, department, hourly_rate, active,
        phone, job_title, address_line1, address_line2, city, state, postal_code, country,
        date_of_birth, hire_date, emergency_contact_name, emergency_contact_phone, notes, custom_fields, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [
        id, data.user_id ?? null, data.employee_code, data.first_name, data.last_name,
        data.email ?? null, data.department ?? null, data.hourly_rate ?? 0, data.active ?? true,
        data.phone ?? null, data.job_title ?? null, data.address_line1 ?? null, data.address_line2 ?? null,
        data.city ?? null, data.state ?? null, data.postal_code ?? null, data.country ?? null,
        data.date_of_birth ?? null, data.hire_date ?? null,
        data.emergency_contact_name ?? null, data.emergency_contact_phone ?? null,
        data.notes ?? null, toJsonString(data.custom_fields), now(),
      ],
    );
  },

  async updateEmployee(id: string, data: Partial<EmployeeRow>): Promise<void> {
    const db = await getDb();
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    const colMap: Record<string, string> = {
      user_id: "user_id", employee_code: "employee_code", first_name: "first_name", last_name: "last_name",
      email: "email", department: "department", hourly_rate: "hourly_rate", active: "active",
      phone: "phone", job_title: "job_title", address_line1: "address_line1", address_line2: "address_line2",
      city: "city", state: "state", postal_code: "postal_code", country: "country",
      date_of_birth: "date_of_birth", hire_date: "hire_date",
      emergency_contact_name: "emergency_contact_name", emergency_contact_phone: "emergency_contact_phone",
      notes: "notes", custom_fields: "custom_fields",
    };
    for (const [key, col] of Object.entries(colMap)) {
      if (key in data) {
        fields.push(`${col} = $${idx++}`);
        if (key === "custom_fields") values.push(toJsonString(data.custom_fields));
        else values.push(data[key as keyof EmployeeRow]);
      }
    }
    if (!fields.length) return;
    values.push(id);
    await db.query(`UPDATE employees SET ${fields.join(", ")} WHERE id = $${idx}`, values);
  },

  async upsertEmployee(data: Partial<EmployeeRow> & { employee_code: string; first_name: string; last_name: string }): Promise<void> {
    const db = await getDb();
    const existing = await db.query("SELECT id FROM employees WHERE employee_code = $1", [data.employee_code]);
    if (existing.rows.length) {
      await this.updateEmployee(String(existing.rows[0].id), data);
    } else {
      await this.insertEmployee(data);
    }
  },

  async deleteEmployee(id: string): Promise<void> {
    const db = await getDb();
    await db.query("DELETE FROM employees WHERE id = $1", [id]);
  },

  async getRecords(from?: string, to?: string): Promise<RecordWithEmp[]> {
    const db = await getDb();
    let sql = `SELECT t.*, e.first_name, e.last_name, e.employee_code, e.hourly_rate
               FROM time_records t LEFT JOIN employees e ON t.employee_id = e.id`;
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (from) { conditions.push(`t.work_date >= $${params.length + 1}`); params.push(from); }
    if (to) { conditions.push(`t.work_date <= $${params.length + 1}`); params.push(to); }
    if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
    sql += " ORDER BY t.work_date DESC, t.created_at DESC LIMIT 1000";
    const result = await db.query(sql, params);
    return result.rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        ...mapTimeRecord(row),
        employees: row.first_name
          ? { first_name: String(row.first_name), last_name: String(row.last_name), employee_code: String(row.employee_code), hourly_rate: Number(row.hourly_rate) }
          : null,
      };
    });
  },

  async insertRecord(data: { employee_id: string; work_date: string; entry_mode?: string; clock_in?: string | null; clock_out?: string | null; lunch_minutes?: number; hours?: number; note?: string | null }): Promise<void> {
    const db = await getDb();
    const id = uuid();
    const mode = data.entry_mode ?? "clock";
    let hours = 0;
    let clockIn = data.clock_in ?? null;
    let clockOut = data.clock_out ?? null;
    let lunch = data.lunch_minutes ?? 0;
    if (mode === "clock" && clockIn && clockOut) {
      hours = computeHours(clockIn, clockOut, lunch);
    } else if (mode === "hours") {
      hours = data.hours ?? 0;
      clockIn = null;
      clockOut = null;
      lunch = 0;
    }
    await db.query(
      `INSERT INTO time_records (id, employee_id, work_date, entry_mode, clock_in, clock_out, lunch_minutes, hours, note, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, data.employee_id, data.work_date, mode, clockIn, clockOut, lunch, hours, data.note ?? null, now()],
    );
  },

  async insertRecords(records: { employee_id: string; work_date: string; entry_mode?: string; clock_in?: string | null; clock_out?: string | null; lunch_minutes?: number; hours?: number; note?: string | null }[]): Promise<void> {
    for (const r of records) await this.insertRecord(r);
  },

  async deleteRecord(id: string): Promise<void> {
    const db = await getDb();
    await db.query("DELETE FROM time_records WHERE id = $1", [id]);
  },

  async getFieldDefs(): Promise<FieldDefRow[]> {
    const db = await getDb();
    const result = await db.query("SELECT * FROM employee_field_defs ORDER BY sort_order, created_at");
    return result.rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        id: String(row.id),
        label: String(row.label),
        field_type: String(row.field_type),
        sort_order: Number(row.sort_order),
        created_at: String(row.created_at),
      };
    });
  },

  async insertFieldDef(data: { label: string; field_type?: string; sort_order?: number }): Promise<void> {
    const db = await getDb();
    await db.query(
      "INSERT INTO employee_field_defs (id, label, field_type, sort_order, created_at) VALUES ($1,$2,$3,$4,$5)",
      [uuid(), data.label, data.field_type ?? "text", data.sort_order ?? 0, now()],
    );
  },

  async updateFieldDef(id: string, data: { label?: string; field_type?: string; sort_order?: number }): Promise<void> {
    const db = await getDb();
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    if (data.label !== undefined) { fields.push(`label = $${idx++}`); values.push(data.label); }
    if (data.field_type !== undefined) { fields.push(`field_type = $${idx++}`); values.push(data.field_type); }
    if (data.sort_order !== undefined) { fields.push(`sort_order = $${idx++}`); values.push(data.sort_order); }
    if (!fields.length) return;
    values.push(id);
    await db.query(`UPDATE employee_field_defs SET ${fields.join(", ")} WHERE id = $${idx}`, values);
  },

  async deleteFieldDef(id: string): Promise<void> {
    const db = await getDb();
    await db.query("DELETE FROM employee_field_defs WHERE id = $1", [id]);
  },

  async getAdjustments(from?: string, to?: string): Promise<AdjustmentRow[]> {
    const db = await getDb();
    let sql = "SELECT * FROM pay_adjustments";
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (from) { conditions.push(`pay_date >= $${params.length + 1}`); params.push(from); }
    if (to) { conditions.push(`pay_date <= $${params.length + 1}`); params.push(to); }
    if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
    sql += " ORDER BY pay_date DESC, created_at DESC";
    const result = await db.query(sql, params);
    return result.rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        id: String(row.id),
        employee_id: String(row.employee_id),
        pay_date: String(row.pay_date),
        category: String(row.category),
        amount: Number(row.amount),
        note: row.note as string | null,
        created_at: String(row.created_at),
      };
    });
  },

  async insertAdjustment(data: { employee_id: string; category: string; amount: number; pay_date: string; note?: string | null }): Promise<void> {
    const db = await getDb();
    await db.query(
      "INSERT INTO pay_adjustments (id, employee_id, pay_date, category, amount, note, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [uuid(), data.employee_id, data.pay_date, data.category, data.amount, data.note ?? null, now()],
    );
  },

  async deleteAdjustment(id: string): Promise<void> {
    const db = await getDb();
    await db.query("DELETE FROM pay_adjustments WHERE id = $1", [id]);
  },

  async getPayrollSettings(): Promise<PayrollSettingsRow> {
    const db = await getDb();
    const result = await db.query("SELECT * FROM payroll_settings WHERE id = TRUE");
    if (!result.rows.length) {
      return { id: true, ot_threshold: 40, ot_multiplier: 1.5, visible_columns: ["employee_code", "days"], updated_at: now() };
    }
    const row = result.rows[0] as Record<string, unknown>;
    return {
      id: true,
      ot_threshold: Number(row.ot_threshold),
      ot_multiplier: Number(row.ot_multiplier),
      visible_columns: parseArrayField(row.visible_columns),
      updated_at: String(row.updated_at),
    };
  },

  async upsertPayrollSettings(data: { ot_threshold: number; ot_multiplier: number; visible_columns: string[] }): Promise<void> {
    const db = await getDb();
    await db.query(
      `INSERT INTO payroll_settings (id, ot_threshold, ot_multiplier, visible_columns, updated_at)
       VALUES (TRUE, $1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET ot_threshold = $1, ot_multiplier = $2, visible_columns = $3, updated_at = $4`,
      [data.ot_threshold, data.ot_multiplier, JSON.stringify(data.visible_columns), now()],
    );
  },

  // ─── Sync helpers ───────────────────────────────────────

  async exportAll(): Promise<{
    employees: EmployeeRow[];
    time_records: TimeRecordRow[];
    employee_field_defs: FieldDefRow[];
    pay_adjustments: AdjustmentRow[];
    payroll_settings: PayrollSettingsRow | null;
  }> {
    const [emp, rec, defs, adj, settings] = await Promise.all([
      this.getEmployees(),
      (async () => { const db = await getDb(); const r = await db.query("SELECT * FROM time_records ORDER BY work_date"); return r.rows.map(mapTimeRecord); })(),
      this.getFieldDefs(),
      this.getAdjustments(),
      (async () => { const db = await getDb(); const r = await db.query("SELECT * FROM payroll_settings WHERE id = TRUE"); if (!r.rows.length) return null; const row = r.rows[0] as Record<string, unknown>; return { id: true, ot_threshold: Number(row.ot_threshold), ot_multiplier: Number(row.ot_multiplier), visible_columns: parseArrayField(row.visible_columns), updated_at: String(row.updated_at) }; })(),
    ]);
    return { employees: emp, time_records: rec, employee_field_defs: defs, pay_adjustments: adj, payroll_settings: settings };
  },

  async replaceAll(data: {
    employees: EmployeeRow[];
    time_records: TimeRecordRow[];
    employee_field_defs: FieldDefRow[];
    pay_adjustments: AdjustmentRow[];
    payroll_settings: PayrollSettingsRow | null;
  }): Promise<void> {
    const db = await getDb();
    await db.exec("DELETE FROM time_records");
    await db.exec("DELETE FROM pay_adjustments");
    await db.exec("DELETE FROM employee_field_defs");
    await db.exec("DELETE FROM employees");
    await db.exec("DELETE FROM payroll_settings");

    for (const e of data.employees) {
      await db.query(
        `INSERT INTO employees (id, user_id, employee_code, first_name, last_name, email, department, hourly_rate, active,
          phone, job_title, address_line1, address_line2, city, state, postal_code, country,
          date_of_birth, hire_date, emergency_contact_name, emergency_contact_phone, notes, custom_fields, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
        [e.id, e.user_id, e.employee_code, e.first_name, e.last_name, e.email, e.department, e.hourly_rate, e.active,
         e.phone, e.job_title, e.address_line1, e.address_line2, e.city, e.state, e.postal_code, e.country,
         e.date_of_birth, e.hire_date, e.emergency_contact_name, e.emergency_contact_phone, e.notes,
         typeof e.custom_fields === "string" ? e.custom_fields : JSON.stringify(e.custom_fields), e.created_at],
      );
    }
    for (const r of data.time_records) {
      await db.query(
        `INSERT INTO time_records (id, employee_id, work_date, entry_mode, clock_in, clock_out, lunch_minutes, hours, note, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [r.id, r.employee_id, r.work_date, r.entry_mode, r.clock_in, r.clock_out, r.lunch_minutes, r.hours, r.note, r.created_at],
      );
    }
    for (const d of data.employee_field_defs) {
      await db.query(
        "INSERT INTO employee_field_defs (id, label, field_type, sort_order, created_at) VALUES ($1,$2,$3,$4,$5)",
        [d.id, d.label, d.field_type, d.sort_order, d.created_at],
      );
    }
    for (const a of data.pay_adjustments) {
      await db.query(
        "INSERT INTO pay_adjustments (id, employee_id, pay_date, category, amount, note, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [a.id, a.employee_id, a.pay_date, a.category, a.amount, a.note, a.created_at],
      );
    }
    if (data.payroll_settings) {
      await db.query(
        `INSERT INTO payroll_settings (id, ot_threshold, ot_multiplier, visible_columns, updated_at)
         VALUES (TRUE, $1, $2, $3, $4)`,
        [data.payroll_settings.ot_threshold, data.payroll_settings.ot_multiplier,
         JSON.stringify(data.payroll_settings.visible_columns), data.payroll_settings.updated_at],
      );
    }
  },

  async setSyncMeta(direction: string): Promise<void> {
    const db = await getDb();
    await db.query(
      `INSERT INTO sync_meta (id, last_sync, last_sync_direction) VALUES ('singleton', $1, $2)
       ON CONFLICT (id) DO UPDATE SET last_sync = $1, last_sync_direction = $2`,
      [now(), direction],
    );
  },

  async getSyncMeta(): Promise<{ last_sync: string | null; last_sync_direction: string | null }> {
    const db = await getDb();
    const result = await db.query("SELECT last_sync, last_sync_direction FROM sync_meta WHERE id = 'singleton'");
    if (!result.rows.length) return { last_sync: null, last_sync_direction: null };
    const row = result.rows[0] as Record<string, unknown>;
    return { last_sync: row.last_sync as string | null, last_sync_direction: row.last_sync_direction as string | null };
  },
};
