// The payroll data's shape, shared by the on-device database (SQLite: sqlite-schema.ts, columns in codec.ts), the
// snapshots (backups, sync) and the cloud. Bump SCHEMA_VERSION, with a new entry in SQLITE_MIGRATIONS (and a step in
// snapshot.ts `upgrade` if old backups need one), whenever a table's columns change.
export const SCHEMA_VERSION = 13;

/** Tables in foreign-key order: parents first. Deletes run in reverse. */
export const TABLES = [
  "employee_field_defs", "shifts", "employees", "pay_rates", "time_records", "pay_adjustments",
  "deductions", "pay_runs", "pay_run_lines", "payroll_settings",
] as const;
export type TableName = (typeof TABLES)[number];
