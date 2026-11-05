import { COLUMNS } from "./codec";
import { TABLES, type TableName } from "./schema";

// The desktop database's schema in SQLite: the same tables and rules as the Postgres schema at version 12
// (schema.ts), written once as a starting point instead of replaying Postgres' twelve migrations. Later changes are
// appended to SQLITE_MIGRATIONS. Column types follow codec.ts: ids, text, dates ("YYYY-MM-DD"), times ("HH:MM:SS") and
// timestamps (ISO) are text, true/false is 0/1, JSON is text; checks refuse anything else, as Postgres' types did
// (with `is`, not `=`: a check that comes out NULL passes in SQLite, and date() of a non-date is NULL).

/** A random version-4 uuid, for rows the database adds itself (the app sends its own ids). */
const UUID = `(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))))`;
const NOW = `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
const isDate = (col: string) => `check (date(${col}) is ${col})`;
const isTime = (col: string) => `check (time(${col}) is ${col})`;
const isBool = (col: string) => `check (${col} in (0, 1))`;
const isJson = (col: string) => `check (json_valid(${col}))`;

const TABLES_SQL = `
create table _meta (key text primary key, value text not null);
insert into _meta values ('change_seq', '0');

-- Undo (src/lib/db/undo.ts): while the undo_log flag is on, every row written is logged before and after.
create table _undo_log (seq integer primary key autoincrement, tbl text not null, op text not null, old text, new text);

create table employee_field_defs (
  id text primary key default ${UUID},
  label text not null,
  field_type text not null default 'text',
  sort_order integer not null default 0,
  created_at text not null default ${NOW},
  section text
);

create table shifts (
  id text primary key default ${UUID},
  name text not null,
  multiplier real not null default 1 check (multiplier > 0 and multiplier <= 10),
  sort_order integer not null default 0,
  created_at text not null default ${NOW},
  default_clock_in text ${isTime("default_clock_in")},
  default_clock_out text ${isTime("default_clock_out")},
  default_lunch_minutes integer check (default_lunch_minutes between 0 and 600)
);
insert into shifts (name, multiplier, sort_order) values ('Day', 1, 0), ('Night', 1, 1);

create table employees (
  id text primary key default ${UUID},
  user_id text,
  employee_code text not null unique,
  first_name text not null,
  last_name text not null,
  email text,
  department text,
  hourly_rate real not null default 0,
  active integer not null default 1 ${isBool("active")},
  created_at text not null default ${NOW},
  phone text, job_title text, address_line1 text, address_line2 text, city text, state text, postal_code text, country text,
  date_of_birth text ${isDate("date_of_birth")},
  hire_date text ${isDate("hire_date")},
  emergency_contact_name text, emergency_contact_phone text, notes text,
  custom_fields text not null default '{}' ${isJson("custom_fields")},
  -- Deleting a shift moves its employees back to the default (first) shift.
  shift_id text references shifts(id) on delete set null,
  -- Salaried employees are paid a full week (the overtime threshold) at their rate for every week they work.
  pay_type text not null default 'hourly' check (pay_type in ('hourly', 'salary')),
  gender text, nationality text, passport_no text, ssn text, residential_status text
);
create unique index employees_email_unique on employees (lower(email)) where email is not null;

-- "From this day, this rate." A day is paid at the latest rate starting on or before it; days before the first entry
-- at the first entry's rate. employees.hourly_rate is always the latest entry's rate.
create table pay_rates (
  id text primary key default ${UUID},
  employee_id text not null references employees(id) on delete cascade,
  effective_from text not null ${isDate("effective_from")},
  hourly_rate real not null check (hourly_rate >= 0),
  created_at text not null default ${NOW},
  unique (employee_id, effective_from)
);

create table time_records (
  id text primary key default ${UUID},
  employee_id text not null references employees(id) on delete cascade,
  work_date text not null ${isDate("work_date")},
  entry_mode text not null default 'clock' check (entry_mode in ('clock', 'hours')),
  clock_in text ${isTime("clock_in")},
  clock_out text ${isTime("clock_out")},
  lunch_minutes integer not null default 0 check (lunch_minutes >= 0),
  hours real not null default 0 check (hours >= 0),
  note text,
  created_at text not null default ${NOW},
  -- When set, the day is paid exactly this amount instead of the calculated pay.
  pay_override real check (pay_override >= 0),
  -- Null = the employee's own shift. Deleting a shift puts its days back on the employee's shift.
  shift_id text references shifts(id) on delete set null,
  -- A record on a locked day the user unlocked by itself: it can change until the lock moves (which locks it again).
  unlocked integer not null default 0 ${isBool("unlocked")},
  -- Its pay line as worked out when it was locked, so later rule or rate changes don't change what it paid.
  frozen_pay text ${isJson("frozen_pay")}
);
create index time_records_emp_date on time_records (employee_id, work_date);

create table pay_adjustments (
  id text primary key default ${UUID},
  employee_id text not null references employees(id) on delete cascade,
  pay_date text not null ${isDate("pay_date")},
  category text not null,
  amount real not null default 0,
  note text,
  created_at text not null default ${NOW}
);

-- One row (id 1, true in snapshots).
create table payroll_settings (
  id integer primary key default 1 check (id = 1),
  ot_threshold real not null default 40,
  ot_multiplier real not null default 1.5,
  visible_columns text not null default '["employee_code","days"]' ${isJson("visible_columns")},
  updated_at text not null default ${NOW},
  weekend_overtime integer not null default 1 ${isBool("weekend_overtime")},
  -- Values every new employee starts with: employee columns plus custom_fields, keyed like the employees row.
  employee_defaults text not null default '{}' ${isJson("employee_defaults")},
  -- Days up to here are locked as paid.
  locked_through text ${isDate("locked_through")}
);
`;

const OPS = ["insert", "update", "delete"] as const;
const flagOn = (name: string) => `coalesce(meridian_flag('${name}'), '') = 'on'`;
const LOCKED = `(select locked_through from payroll_settings limit 1)`;
/** "Mon 2026-11-02", as Postgres' to_char(…, 'Dy YYYY-MM-DD') gave. */
const DAY = `substr('SunMonTueWedThuFriSat', 1 + 3 * strftime('%w', ${LOCKED}), 3) || ' ' || ${LOCKED}`;

/** Any write bumps change_seq, so sync can tell whether local data changed since the last push or pull. */
function changeSeqTriggers(t: TableName) {
  return OPS.map((op) => `create trigger ${t}_seq_${op} after ${op} on ${t}
  begin update _meta set value = cast(value as integer) + 1 where key = 'change_seq'; end;`).join("\n");
}

/**
 * Every row written while the undo_log flag is on, before and after, as JSON with every column. A migration that adds
 * columns to a table drops and makes these again (`remakeUndoTriggers`), so the images keep every column.
 */
function undoTriggers(t: TableName, columns: readonly { name: string }[] = COLUMNS[t]) {
  const image = (row: "old" | "new") => `json_object(${columns.map((col) => `'${col.name}', ${row}.${col.name}`).join(", ")})`;
  return OPS.map((op) => `create trigger ${t}_undo_${op} after ${op} on ${t} when ${flagOn("undo_log")}
  begin insert into _undo_log (tbl, op, old, new) values ('${t}', '${op.toUpperCase()}',
    ${op === "insert" ? "null" : image("old")}, ${op === "delete" ? "null" : image("new")}); end;`).join("\n");
}

/** `new` and `old` agree on every column but these. */
function sameExcept(t: TableName, except: string[]) {
  return COLUMNS[t].filter((col) => !except.includes(col.name)).map((col) => `new.${col.name} is old.${col.name}`).join(" and ");
}

/**
 * Refuses a write touching a locked day (on or before payroll_settings.locked_through). Restores replace everything
 * with the settings inserted last, so they never meet a lock; the bypass_lock flag lets a trigger write what changes
 * no paid day. A record unlocked by itself may change, and switching that flag or saving frozen pay is always allowed.
 */
function lockTriggers(t: "time_records" | "pay_adjustments", dateCol: string) {
  const unlocked = t === "time_records";
  const locked = (row: "old" | "new") => `${row}.${dateCol} <= ${LOCKED}${unlocked ? ` and not ${row}.unlocked` : ""}`;
  const where = { insert: locked("new"), delete: locked("old"),
    update: `not (${sameExcept(t, ["unlocked", "frozen_pay"])}) and (${locked("old")} or ${locked("new")})` };
  return OPS.map((op) => `create trigger ${t}_lock_${op} before ${op} on ${t}
  when ${LOCKED} is not null and not ${flagOn("bypass_lock")} and ${where[op]}
  begin select raise(abort, 'Days up to ' || ${DAY} || ' are locked as paid. Unlock them on the Payroll or Time records page to change them.'); end;`).join("\n");
}

/**
 * Worked hours for clock records, the same formula as the cloud's: clock out minus clock in (past midnight adds a
 * day), minus the break, rounded to the cent of an hour half up. Worked out in whole seconds so the rounding is
 * exact. Hours records drop their times. Checked before the write, filled in after it (SQLite can't change a row in
 * a BEFORE trigger), so every path that writes a record gets the same hours. Undo and redo write back exactly the
 * rows logged, the fill-in's own step included, so it stays out of them (or undoing it would fill the hours in again).
 */
const shiftSeconds = (r: string) =>
  `((strftime('%s', '2000-01-01 ' || ${r}.clock_out) - strftime('%s', '2000-01-01 ' || ${r}.clock_in) + 86400) % 86400 - ${r}.lunch_minutes * 60)`;
const hoursOf = (r: string) => `(cast((${shiftSeconds(r)} * 2 + 36) / 72 as integer) / 100.0)`;
const HOURS_TRIGGERS = ["insert", "update"].map((op) => `
create trigger time_records_hours_check_${op} before ${op} on time_records when new.entry_mode = 'clock'
begin
  select raise(abort, 'Clock in and clock out are required') where new.clock_in is null or new.clock_out is null;
  select raise(abort, 'Lunch break longer than shift') where ${shiftSeconds("new")} < 0;
end;
create trigger time_records_hours_fill_${op} after ${op} on time_records when not ${flagOn("replaying")}
begin
  update time_records set hours = ${hoursOf("time_records")}
    where id = new.id and entry_mode = 'clock' and hours is not ${hoursOf("time_records")};
  update time_records set clock_in = null, clock_out = null, lunch_minutes = 0
    where id = new.id and entry_mode = 'hours' and (clock_in is not null or clock_out is not null or lunch_minutes <> 0);
end;`).join("\n");

/**
 * However a rate is changed (profile, bulk edit, import), the old one is kept for the days before: the first change
 * keeps the old rate for every earlier day (with the lock lifted, since that changes no paid day), and a change the
 * app didn't already date starts today. Undo and redo put back exactly the rows logged, so it stays out of them.
 */
const LATEST_RATE = `(select hourly_rate from pay_rates where employee_id = new.id order by effective_from desc limit 1)`;
const RATE_HISTORY = `
create trigger employees_rate_history after update of hourly_rate on employees
when new.hourly_rate is not old.hourly_rate and not ${flagOn("replaying")}
begin
  select meridian_bypass(1);
  insert into pay_rates (employee_id, effective_from, hourly_rate)
    select old.id, '0001-01-01', old.hourly_rate where not exists (select 1 from pay_rates where employee_id = old.id);
  select meridian_bypass(-1);
  update pay_rates set hourly_rate = new.hourly_rate
    where employee_id = new.id and effective_from = date('now', 'localtime') and ${LATEST_RATE} is not new.hourly_rate;
  insert into pay_rates (employee_id, effective_from, hourly_rate)
    select new.id, date('now', 'localtime'), new.hourly_rate where ${LATEST_RATE} is not new.hourly_rate;
end;

-- A rate entry starting on or before the lock changes what locked days paid, except the first change of a rate
-- keeping the current one "since the start" (rate unchanged for every locked day). Deleting an employee takes their
-- history with them: it paid nothing by itself, and their records on locked days are refused by those records' own
-- lock. Undo and redo stay out: steps are undone newest first, so a step is only undone once every later one (a lock
-- change included) has been, which puts back rates the same lock already had; and they write rows in an order the
-- per-row rule can't follow (undoing a first change deletes the "since the start" entry while the employee's rate
-- is still the new one). Their records' locks still apply.
${OPS.map((op) => `create trigger pay_rates_lock_${op} before ${op} on pay_rates
  when ${LOCKED} is not null and not ${flagOn("bypass_lock")} and not ${flagOn("replaying")}
  ${op === "delete" ? "and exists (select 1 from employees where id = old.employee_id)" : ""}
  ${op === "insert" ? `and not (new.effective_from = '0001-01-01' and new.hourly_rate = (select hourly_rate from employees where id = new.employee_id)
    and not exists (select 1 from pay_rates where employee_id = new.employee_id))` : ""}
  and (${op === "insert" ? "new.effective_from <= " + LOCKED : op === "delete" ? "old.effective_from <= " + LOCKED
    : `(old.effective_from <= ${LOCKED} or new.effective_from <= ${LOCKED}) and not (${sameExcept("pay_rates", [])})`})
  begin select raise(abort, 'Days up to ' || ${DAY} || ' are locked as paid, so their pay rate can''t change. Unlock them on the Payroll page first.'); end;`).join("\n")}
`;

/** The tables and columns of schema 12, which SQLITE_SCHEMA makes; later ones come from SQLITE_MIGRATIONS. */
const V12_TABLES: readonly TableName[] = ["employee_field_defs", "shifts", "employees", "pay_rates", "time_records", "pay_adjustments", "payroll_settings"];
const ADDED_LATER: Partial<Record<TableName, readonly string[]>> = { payroll_settings: ["deductions_on", "pay_runs_on", "history_keep_days"] };
const v12Columns = (t: TableName) => COLUMNS[t].filter((col) => !ADDED_LATER[t]?.includes(col.name));

/** The whole schema as of version 12, for a new database (the migrations then bring it up to date). */
export const SQLITE_SCHEMA = [
  TABLES_SQL,
  HOURS_TRIGGERS,
  RATE_HISTORY,
  lockTriggers("time_records", "work_date"),
  lockTriggers("pay_adjustments", "pay_date"),
  ...V12_TABLES.map(changeSeqTriggers),
  ...V12_TABLES.map((t) => undoTriggers(t, v12Columns(t))),
].join("\n");

/** Makes a table's undo triggers again with all of its columns, after a migration added some. */
const remakeUndoTriggers = (t: TableName) => [...OPS.map((op) => `drop trigger ${t}_undo_${op};`), undoTriggers(t)].join("\n");

/**
 * Schema 13: deductions (what's taken from gross pay, per employee), pay runs (the saved record of each period paid,
 * one line per person, written once), the settings that turn both on, and the edit history. `_history` is this
 * device's own (like `_undo_log`, not a payroll table): it holds the rows every change wrote, private details included,
 * so it's never sent to the cloud; local backups carry it (snapshot.ts).
 */
const V13 = `
alter table payroll_settings add column deductions_on integer not null default 0 ${isBool("deductions_on")};
alter table payroll_settings add column pay_runs_on integer not null default 0 ${isBool("pay_runs_on")};
-- Edit history older than this many days is removed at start; null keeps it all.
alter table payroll_settings add column history_keep_days integer check (history_keep_days is null or history_keep_days > 0);

create table deductions (
  id text primary key default ${UUID},
  employee_id text not null references employees(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  -- A fixed amount, or a percent of gross pay.
  kind text not null default 'fixed' check (kind in ('fixed', 'percent')),
  amount real not null default 0 check (amount >= 0 and (kind <> 'percent' or amount <= 100)),
  -- Fixed amounts: once per pay period, once per Mon–Sun week in it, or once (in the period holding starts_on).
  repeats text not null default 'period' check (repeats in ('period', 'week', 'once')),
  starts_on text ${isDate("starts_on")},
  ends_on text ${isDate("ends_on")},
  note text,
  sort_order integer not null default 0,
  created_at text not null default ${NOW},
  check (repeats <> 'once' or starts_on is not null),
  check (ends_on is null or starts_on is null or ends_on >= starts_on)
);
create index deductions_employee on deductions (employee_id);

create table pay_runs (
  id text primary key default ${UUID},
  period_from text not null ${isDate("period_from")},
  period_to text not null ${isDate("period_to")},
  paid_on text not null ${isDate("paid_on")},
  note text,
  created_at text not null default ${NOW},
  check (period_to >= period_from)
);

-- What each person was paid in a run, as the Payroll page worked it out then. The name and ID are kept so a run
-- still reads after the employee is deleted (employee_id then goes null).
create table pay_run_lines (
  id text primary key default ${UUID},
  pay_run_id text not null references pay_runs(id) on delete cascade,
  employee_id text references employees(id) on delete set null,
  employee_name text not null,
  employee_code text not null default '',
  hours real not null default 0,
  regular_hours real not null default 0,
  overtime_hours real not null default 0,
  extra_pay real not null default 0,
  gross real not null default 0,
  deductions text not null default '[]' ${isJson("deductions")},
  deductions_total real not null default 0,
  net real not null default 0
);
create index pay_run_lines_run on pay_run_lines (pay_run_id);
create index pay_run_lines_employee on pay_run_lines (employee_id);

create table _history (
  id text primary key default ${UUID},
  at text not null default ${NOW},
  device text,
  kind text not null check (kind in ('edit', 'undo', 'redo', 'restore')),
  label text not null,
  -- The rows written, before and after (undo.ts UndoOp[]); empty for a restore, which replaces everything.
  changes text not null default '[]' ${isJson("changes")},
  -- The employees and rows it touched, so a profile or record can list its own history.
  employees text not null default '[]' ${isJson("employees")},
  rows text not null default '[]' ${isJson("rows")}
);
create index _history_at on _history (at);

${remakeUndoTriggers("payroll_settings")}
${(["deductions", "pay_runs", "pay_run_lines"] as const).map((t) => `${changeSeqTriggers(t)}\n${undoTriggers(t)}`).join("\n")}
`;

/** The schema version SQLITE_SCHEMA is. */
export const SQLITE_BASE_VERSION = 12;

/** Changes after the starting schema, each run once in order. Never edit a shipped entry — append a new one. */
export const SQLITE_MIGRATIONS: string[] = [V13];
