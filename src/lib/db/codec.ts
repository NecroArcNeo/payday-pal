import type { TableName } from "./schema";

// Every payroll table's columns and what each holds. SQLite stores only text, integers and reals, so this map is what
// turns the app's values into stored ones (encode) and back into the shapes the app and the snapshots use (decode):
// numbers, true/false, "YYYY-MM-DD" dates, "HH:MM:SS" times, ISO timestamps, objects and arrays. The SQLite schema
// (sqlite-schema.ts) is checked against it by a test, so the two can't drift apart.

export type Kind = "text" | "uuid" | "int" | "real" | "bool" | "date" | "time" | "timestamp" | "json";
export type Column = { readonly name: string; readonly kind: Kind; /** Decimal places a real is rounded to. */ readonly scale?: number };

const c = (name: string, kind: Kind, scale?: number): Column => (scale === undefined ? { name, kind } : { name, kind, scale });
const text = (...names: string[]) => names.map((n) => c(n, "text"));

/** In the same order as the tables' columns. */
export const COLUMNS: Record<TableName, readonly Column[]> = {
  employee_field_defs: [c("id", "uuid"), c("label", "text"), c("field_type", "text"), c("sort_order", "int"), c("created_at", "timestamp"), c("section", "text")],
  shifts: [
    c("id", "uuid"), c("name", "text"), c("multiplier", "real", 3), c("sort_order", "int"), c("created_at", "timestamp"),
    c("default_clock_in", "time"), c("default_clock_out", "time"), c("default_lunch_minutes", "int"),
  ],
  employees: [
    c("id", "uuid"), c("user_id", "uuid"), ...text("employee_code", "first_name", "last_name", "email", "department"),
    c("hourly_rate", "real", 2), c("active", "bool"), c("created_at", "timestamp"),
    ...text("phone", "job_title", "address_line1", "address_line2", "city", "state", "postal_code", "country"),
    c("date_of_birth", "date"), c("hire_date", "date"), ...text("emergency_contact_name", "emergency_contact_phone", "notes"),
    c("custom_fields", "json"), c("shift_id", "uuid"), ...text("pay_type", "gender", "nationality", "passport_no", "ssn", "residential_status"),
  ],
  pay_rates: [c("id", "uuid"), c("employee_id", "uuid"), c("effective_from", "date"), c("hourly_rate", "real", 2), c("created_at", "timestamp")],
  time_records: [
    c("id", "uuid"), c("employee_id", "uuid"), c("work_date", "date"), c("entry_mode", "text"), c("clock_in", "time"), c("clock_out", "time"),
    c("lunch_minutes", "int"), c("hours", "real", 2), c("note", "text"), c("created_at", "timestamp"), c("pay_override", "real", 2),
    c("shift_id", "uuid"), c("unlocked", "bool"), c("frozen_pay", "json"),
  ],
  pay_adjustments: [c("id", "uuid"), c("employee_id", "uuid"), c("pay_date", "date"), c("category", "text"), c("amount", "real"), c("note", "text"), c("created_at", "timestamp")],
  // Schema 13: what's taken from gross pay, and the saved record of each period paid.
  deductions: [
    c("id", "uuid"), c("employee_id", "uuid"), c("name", "text"), c("kind", "text"), c("amount", "real", 2), c("repeats", "text"),
    c("starts_on", "date"), c("ends_on", "date"), c("note", "text"), c("sort_order", "int"), c("created_at", "timestamp"),
  ],
  pay_runs: [c("id", "uuid"), c("period_from", "date"), c("period_to", "date"), c("paid_on", "date"), c("note", "text"), c("created_at", "timestamp")],
  pay_run_lines: [
    c("id", "uuid"), c("pay_run_id", "uuid"), c("employee_id", "uuid"), c("employee_name", "text"), c("employee_code", "text"),
    c("hours", "real", 2), c("regular_hours", "real", 2), c("overtime_hours", "real", 2), c("extra_pay", "real", 2), c("gross", "real", 2),
    c("deductions", "json"), c("deductions_total", "real", 2), c("net", "real", 2),
  ],
  payroll_settings: [
    c("id", "bool"), c("ot_threshold", "real"), c("ot_multiplier", "real"), c("visible_columns", "json"), c("updated_at", "timestamp"),
    c("weekend_overtime", "bool"), c("employee_defaults", "json"), c("locked_through", "date"),
    c("deductions_on", "bool"), c("pay_runs_on", "bool"), c("history_keep_days", "int"),
  ],
};

const byName = new Map(Object.entries(COLUMNS).map(([t, cols]) => [t, new Map(cols.map((col) => [col.name, col]))]));

/** The column, or undefined if the table has none by that name. */
export function columnOf(table: TableName, name: string): Column | undefined {
  return byName.get(table)?.get(name);
}

/**
 * Rounds half away from zero at `scale` decimal places, on the decimal digits (as Postgres' numeric does): 2.675 → 2.68,
 * where Math.round(2.675 * 100) gives 2.67 because 2.675 isn't exact in binary.
 */
export function roundDecimal(n: number, scale: number) {
  const abs = Math.abs(n);
  const text = String(abs);
  // Tiny or huge numbers print with an exponent ("1e-7", "1e+21"): tiny ones round to 0, huge ones have no decimals.
  if (text.includes("e")) return abs < 1 ? 0 : n;
  const [whole, frac = ""] = text.split(".");
  if (frac.length <= scale) return n || 0;
  // Rounded on the digits themselves, as text: shifting the point in a double first (29.974999999999998 × 100)
  // can land exactly on .5 and round the wrong way.
  const kept = BigInt(whole! + frac.slice(0, scale)) + (frac[scale]! >= "5" ? 1n : 0n);
  return Math.sign(n) * Number(`${kept}e-${scale}`) || 0;
}

/** A value as stored. Throws on one that can't be, as Postgres refused them (so bad input never reaches the file). */
export function encodeValue(col: Column, value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  switch (col.kind) {
    case "bool":
      if (value === true || value === 1 || value === "true") return 1;
      if (value === false || value === 0 || value === "false") return 0;
      throw new Error(`${col.name}: "${String(value)}" isn't yes or no`);
    case "int": {
      const n = Number(value);
      if (value === "" || !Number.isInteger(n)) throw new Error(`${col.name}: "${String(value)}" isn't a whole number`);
      return n;
    }
    case "real": {
      const n = Number(value);
      if (value === "" || !Number.isFinite(n)) throw new Error(`${col.name}: "${String(value)}" isn't a number`);
      return col.scale === undefined ? n : roundDecimal(n, col.scale);
    }
    case "time": {
      // "8:00" and "08:00" are kept as "08:00:00", as Postgres' time type did; anything else is left for the
      // schema's check to refuse.
      const m = /^(\d{1,2}):(\d\d)(?::(\d\d))?$/.exec(String(value));
      return m ? `${m[1]!.padStart(2, "0")}:${m[2]}:${m[3] ?? "00"}` : String(value);
    }
    case "timestamp": {
      // ISO, or Postgres' text form ("2026-11-03 12:00:00.123+00") from older backups.
      const s = String(value).replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
      const t = Date.parse(s);
      if (Number.isNaN(t)) throw new Error(`${col.name}: "${String(value)}" isn't a date and time`);
      return new Date(t).toISOString();
    }
    case "json":
      return JSON.stringify(value);
    default:
      return String(value);
  }
}

/** The row's known columns, encoded. Unknown keys are left out (the caller decides whether that's an error). */
export function encodeRow(table: TableName, row: Record<string, unknown>): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const [k, v] of Object.entries(row)) {
    const col = columnOf(table, k);
    if (col) out[k] = encodeValue(col, v);
  }
  return out;
}

/** A stored value as the app uses it. Values already decoded (from JSON the database built) pass through. */
export function decodeValue(col: Column, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (col.kind === "bool") return value === 1 || value === true;
  if (col.kind === "json") return typeof value === "string" ? JSON.parse(value) : value;
  return value;
}

/** A stored row as the app uses it. Columns not in the map (aliases, joins) pass through unchanged. */
export function decodeRow<T = Record<string, unknown>>(table: TableName, row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    const col = columnOf(table, k);
    out[k] = col ? decodeValue(col, v) : v;
  }
  return out as T;
}
