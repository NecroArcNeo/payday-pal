import * as XLSX from "xlsx";
import type { Employee, FieldDef } from "@/lib/payroll";
import { withDefaults, type EmployeeDefaults } from "@/lib/employee-fields";
import { fieldType, toType } from "@/lib/field-types";
import { readTypedDate } from "@/lib/typed-date";
import { readAmount } from "@/lib/amount";

// File import: the user maps sheet columns to app fields and picks a row range;
// these functions read the workbook, guess a starting mapping, and turn the
// chosen rows into employees and time records.

/** One spreadsheet cell: its displayed text, plus the raw number when Excel stored a date/time. */
export type Cell = { text: string; serial?: number };

export type Sheet = {
  name: string;
  /** Excel row/column of grid[0][0] (0-based), so row numbers and letters match the spreadsheet. */
  rowOffset: number;
  colOffset: number;
  grid: Cell[][];
  width: number;
};

export type Role = "people" | "records" | "ignore";
export type DateOrder = "mdy" | "dmy" | "ymd";

/** What a column feeds: a field key, `custom:<def id>`, `new:<label>` (create a category), or "" (ignore). */
export type Target = string;

export type SheetSetup = {
  role: Role;
  /** Index into grid, or null when the sheet has no header row. */
  headerRow: number | null;
  /** Inclusive grid indexes of the rows to import. */
  firstRow: number;
  lastRow: number;
  columns: Target[];
  dateOrder: DateOrder;
  /** Hours sheets with no employee column: whose hours these are. */
  sheetEmployeeId: string;
};

type Field = { key: string; label: string; aliases: string[] };

export const PEOPLE_FIELDS: Field[] = [
  { key: "code", label: "Employee ID", aliases: ["employeeid", "employeecode", "empid", "empno", "employeenumber", "employeeno", "staffid", "id", "code"] },
  { key: "name", label: "Full name", aliases: ["name", "fullname", "employee", "employeename", "staffname"] },
  { key: "first", label: "First name", aliases: ["firstname", "first", "givenname", "forename"] },
  { key: "last", label: "Last name", aliases: ["lastname", "last", "surname", "familyname"] },
  { key: "email", label: "Email", aliases: ["email", "emailaddress", "mail", "workemail"] },
  { key: "rate", label: "Hourly rate", aliases: ["hourlyrate", "rate", "payrate", "wage", "hourlywage", "perhour"] },
  { key: "dept", label: "Department", aliases: ["department", "dept", "team", "division"] },
  { key: "shift", label: "Shift", aliases: ["shift", "shifttype", "shiftname", "schedule"] },
  { key: "title", label: "Job title", aliases: ["jobtitle", "title", "position", "role"] },
  { key: "phone", label: "Phone", aliases: ["phone", "phonenumber", "mobile", "cell", "telephone", "tel"] },
  { key: "addr1", label: "Street address", aliases: ["address", "address1", "addressline1", "street", "streetaddress"] },
  { key: "addr2", label: "Apt / suite", aliases: ["address2", "addressline2", "apt", "suite", "unit"] },
  { key: "city", label: "City", aliases: ["city", "town"] },
  { key: "state", label: "State / region", aliases: ["state", "province", "region", "stateregion"] },
  { key: "zip", label: "Postal code", aliases: ["zip", "zipcode", "postalcode", "postcode", "postal"] },
  { key: "country", label: "Country", aliases: ["country"] },
  { key: "gender", label: "Gender", aliases: ["gender", "sex"] },
  { key: "nationality", label: "Nationality", aliases: ["nationality", "citizenship", "citizen"] },
  { key: "passport", label: "Passport no.", aliases: ["passport", "passportno", "passportnumber", "passportid"] },
  { key: "ssn", label: "Social security no.", aliases: ["ssn", "socialsecurity", "socialsecurityno", "socialsecuritynumber", "sin", "nino", "nationalinsurance"] },
  { key: "residency", label: "Residential status", aliases: ["residentialstatus", "residencystatus", "residency", "residentstatus", "visastatus", "immigrationstatus"] },
  { key: "dob", label: "Date of birth", aliases: ["dateofbirth", "dob", "birthdate", "birthday"] },
  { key: "hire", label: "Hire date", aliases: ["hiredate", "startdate", "datehired", "joined", "joindate"] },
  { key: "ecName", label: "Emergency contact", aliases: ["emergencycontact", "emergencycontactname", "emergencyname"] },
  { key: "ecPhone", label: "Emergency phone", aliases: ["emergencyphone", "emergencycontactphone"] },
  { key: "notes", label: "Notes", aliases: ["notes", "note", "comments"] },
];

export const HOURS_FIELDS: Field[] = [
  { key: "code", label: "Employee ID", aliases: PEOPLE_FIELDS[0]!.aliases },
  { key: "name", label: "Employee name", aliases: PEOPLE_FIELDS[1]!.aliases },
  { key: "first", label: "First name", aliases: PEOPLE_FIELDS[2]!.aliases },
  { key: "last", label: "Last name", aliases: PEOPLE_FIELDS[3]!.aliases },
  { key: "email", label: "Employee email", aliases: PEOPLE_FIELDS[4]!.aliases },
  { key: "date", label: "Date", aliases: ["date", "workdate", "day", "shiftdate", "dateworked"] },
  { key: "cin", label: "Clock in", aliases: ["clockin", "timein", "in", "start", "starttime", "punchin", "begin", "shiftstart", "arrival"] },
  { key: "cout", label: "Clock out", aliases: ["clockout", "timeout", "out", "end", "endtime", "punchout", "finish", "finishtime", "stop", "shiftend", "departure"] },
  { key: "lunch", label: "Break", aliases: ["lunchminutes", "lunch", "break", "breakminutes", "lunchmins", "breaktime", "unpaidbreak"] },
  { key: "hours", label: "Hours worked", aliases: ["hours", "totalhours", "hoursworked", "hrs", "total", "regularhours"] },
  { key: "pay", label: "Manual day pay", aliases: ["pay", "daypay", "dailypay", "manualpay", "payamount", "payoverride"] },
  { key: "note", label: "Note", aliases: ["notes", "note", "comments", "memo"] },
];

export const fieldsFor = (role: Role) => (role === "people" ? PEOPLE_FIELDS : role === "records" ? HOURS_FIELDS : []);

export const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
export const columnLetter = (sheet: Sheet, j: number) => XLSX.utils.encode_col(sheet.colOffset + j);
export const rowNumber = (sheet: Sheet, i: number) => sheet.rowOffset + i + 1;
export const MAX_ROWS = 25000;

// ---------------------------------------------------------------- reading

export function readWorkbook(data: ArrayBuffer, fileName: string): Sheet[] {
  const csv = /\.(csv|txt)$/i.test(fileName);
  // CSV stays plain text (we parse dates ourselves with the chosen order); Excel keeps raw serials for dates/times.
  const wb = XLSX.read(data, { raw: csv, cellDates: false, cellNF: true });
  return wb.SheetNames.map((name) => readSheet(name, wb.Sheets[name]!));
}

function readSheet(name: string, ws: XLSX.WorkSheet): Sheet {
  const ref = ws["!ref"];
  if (!ref) return { name, rowOffset: 0, colOffset: 0, grid: [], width: 0 };
  const range = XLSX.utils.decode_range(ref);
  const lastRow = Math.min(range.e.r, range.s.r + MAX_ROWS + 50);
  const grid: Cell[][] = [];
  for (let r = range.s.r; r <= lastRow; r++) {
    const row: Cell[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
      if (!cell || cell.v == null) { row.push({ text: "" }); continue; }
      const text = String(cell.w ?? cell.v).trim();
      const isDate = cell.t === "n" && typeof cell.v === "number" && !!cell.z && XLSX.SSF.is_date(String(cell.z));
      row.push(isDate ? { text, serial: cell.v as number } : { text });
    }
    grid.push(row);
  }
  while (grid.length && grid[grid.length - 1]!.every((c) => !c.text)) grid.pop();
  // Drop empty trailing columns so the preview stays narrow.
  let width = 0;
  for (const row of grid) row.forEach((c, j) => { if (c.text) width = Math.max(width, j + 1); });
  return { name, rowOffset: range.s.r, colOffset: range.s.c, grid: grid.map((r) => r.slice(0, width)), width };
}

// ---------------------------------------------------------------- guessing a starting setup

const aliasIndex = (fields: Field[]) => {
  const m = new Map<string, string>();
  for (const f of fields) for (const a of f.aliases) if (!m.has(a)) m.set(a, f.key);
  return m;
};
const peopleAliases = aliasIndex(PEOPLE_FIELDS);
const hoursAliases = aliasIndex(HOURS_FIELDS);
const knownAliases = new Set([...peopleAliases.keys(), ...hoursAliases.keys()]);

export function guessHeaderRow(sheet: Sheet): number | null {
  let best: number | null = null, bestScore = 0;
  sheet.grid.slice(0, 30).forEach((row, i) => {
    const hits = row.filter((c) => knownAliases.has(norm(c.text))).length;
    const filled = row.filter((c) => c.text).length;
    const score = hits * 10 + filled;
    if (hits > 0 && score > bestScore) { bestScore = score; best = i; }
  });
  return best;
}

export function guessColumns(sheet: Sheet, headerRow: number | null, role: Role, defs: FieldDef[]): Target[] {
  const aliases = role === "people" ? peopleAliases : role === "records" ? hoursAliases : new Map<string, string>();
  const defByLabel = new Map(defs.map((d) => [norm(d.label), d.id]));
  const used = new Set<string>();
  return Array.from({ length: sheet.width }, (_, j) => {
    if (headerRow === null) return "";
    const h = norm(sheet.grid[headerRow]?.[j]?.text ?? "");
    if (!h) return "";
    const key = aliases.get(h);
    if (key && !used.has(key)) { used.add(key); return key; }
    const def = role === "people" ? defByLabel.get(h) : undefined;
    return def ? `custom:${def}` : "";
  });
}

export function guessRole(sheet: Sheet, headerRow: number | null): Role {
  if (headerRow === null) return sheet.grid.length ? "records" : "ignore";
  const n = (sheet.grid[headerRow] ?? []).map((c) => norm(c.text));
  const hoursOnly = new Set(HOURS_FIELDS.slice(5).flatMap((f) => f.aliases));
  const peopleOnly = new Set(PEOPLE_FIELDS.slice(5).flatMap((f) => f.aliases).filter((a) => !hoursOnly.has(a)));
  const p = n.filter((h) => peopleOnly.has(h)).length;
  const r = n.filter((h) => hoursOnly.has(h)).length;
  if (!p && !r) return "ignore";
  return r >= p ? "records" : "people";
}

export function lastFilledRow(sheet: Sheet) {
  for (let i = sheet.grid.length - 1; i >= 0; i--) if (sheet.grid[i]!.some((c) => c.text)) return i;
  return -1;
}

export function guessSetup(sheet: Sheet, defs: FieldDef[]): SheetSetup {
  const headerRow = guessHeaderRow(sheet);
  const role = sheet.grid.length ? guessRole(sheet, headerRow) : "ignore";
  return {
    role,
    headerRow,
    firstRow: headerRow === null ? 0 : headerRow + 1,
    lastRow: Math.max(lastFilledRow(sheet), 0),
    columns: guessColumns(sheet, headerRow, role, defs),
    dateOrder: guessDateOrder(sheet, headerRow),
    sheetEmployeeId: "",
  };
}

/** Day-first if any slash date has a first part above 12 (e.g. 25/10/2026). */
function guessDateOrder(sheet: Sheet, headerRow: number | null): DateOrder {
  for (const row of sheet.grid.slice((headerRow ?? -1) + 1, 500)) {
    for (const c of row) {
      const m = c.serial === undefined && c.text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}$/);
      if (m && Number(m[1]) > 12) return "dmy";
    }
  }
  return "mdy";
}

// ---------------------------------------------------------------- value parsing

const pad = (n: number) => String(n).padStart(2, "0");
const validYmd = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return y >= 1900 && y <= 2200 && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
};

const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/** A date cell as YYYY-MM-DD, or null. Text without a year ("Oct 5", "5/10") is the nearest such day to `today`. */
export function parseDate(cell: Cell | undefined, order: DateOrder, today = localToday()): string | null {
  if (!cell) return null;
  if (cell.serial !== undefined && cell.serial >= 1) {
    const p = XLSX.SSF.parse_date_code(cell.serial);
    return validYmd(p.y, p.m, p.d);
  }
  // Drop a leading weekday ("Mon 10/5/2026", "Monday, Oct 5").
  const v = cell.text.trim().replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i, "");
  if (!v) return null;
  let m = v.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/);
  if (m) return validYmd(+m[1]!, +m[2]!, +m[3]!);
  m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const y = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!;
    if (order === "ymd") return null;
    return order === "dmy" ? validYmd(y, +m[2]!, +m[1]!) : validYmd(y, +m[1]!, +m[2]!);
  }
  // Month and day without a year ("10/5"), or with the month named ("Oct 5", "5 October 2026"): read the way a typed
  // date is. Never the browser's own date parser, which reads "Oct 5" as 2001, "5" or "Week 3" as a date, and
  // "2026-11" a day early west of UTC.
  if (order !== "ymd" && (/^\d{1,2}[/.-]\d{1,2}$/.test(v) || /[a-z]{3}/i.test(v))) {
    const named = /[a-z]{3}/i.test(v);
    const hasYear = /\d{4}/.test(v) || (v.match(/\d+/g) ?? []).length >= (named ? 2 : 3);
    // Without a year, only the month and day are wanted: read against a leap year, so Feb 29 reads too.
    const read = readTypedDate(v, hasYear ? today : "2024-07-01", order);
    if (!read) return null;
    const [m, d] = [+read.slice(5, 7), +read.slice(8, 10)];
    if (hasYear) return validYmd(+read.slice(0, 4), m, d);
    // No year: a timesheet records work done, so the latest such day on or before today (Jan 2, read in November, is
    // this January's; Feb 29 the last leap year's).
    for (let y = +today.slice(0, 4); y > +today.slice(0, 4) - 8; y--) {
      const iso = validYmd(y, m, d);
      if (iso && iso <= today) return iso;
    }
    return null;
  }
  return null;
}

/** A custom category's value from a cell, converted to its type where possible (else the text as it is). */
export function categoryValue(type: string | null | undefined, cell: Cell, order: DateOrder): string {
  const t = fieldType(type);
  if (t === "date") return parseDate(cell, order) ?? cell.text.trim();
  if (t === "time") return parseTime(cell) ?? cell.text.trim();
  return toType(t, cell.text);
}

export function parseTime(cell: Cell | undefined): string | null {
  if (!cell) return null;
  if (cell.serial !== undefined) {
    const mins = Math.round((cell.serial - Math.floor(cell.serial)) * 1440) % 1440;
    return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
  }
  const v = cell.text.trim().toLowerCase().replace(/\s+/g, "");
  if (!v) return null;
  let h: number, min: number, ap: string | undefined;
  let m = v.match(/^(\d{1,2})(?::|\.|h)(\d{2})(?::\d{2})?([ap])?\.?m?\.?$/);
  if (m) { h = +m[1]!; min = +m[2]!; ap = m[3]; }
  else if ((m = v.match(/^(\d{1,2})([ap])\.?m?\.?$/))) { h = +m[1]!; min = 0; ap = m[2]; }
  else if ((m = v.match(/^(\d{2})(\d{2})$/))) { h = +m[1]!; min = +m[2]!; }
  else return null;
  if ((ap ? h < 1 || h > 12 : h > 23) || min > 59) return null;
  if (ap === "p" && h < 12) h += 12;
  if (ap === "a" && h === 12) h = 0;
  return `${pad(h)}:${pad(min)}`;
}

const toNumber = readAmount;

/** Hours worked: "7.5", "7,5", "7:30", "7h 30m", or an Excel time/duration cell. */
export function parseHours(cell: Cell | undefined): number | null {
  if (!cell || !cell.text) return null;
  if (cell.serial !== undefined) return Math.round(cell.serial * 24 * 100) / 100;
  const v = cell.text.trim().toLowerCase();
  let m = v.match(/^(\d{1,3}):([0-5]\d)$/);
  if (m) return +m[1]! + +m[2]! / 60;
  m = v.match(/^(\d{1,3})\s*h(?:rs?|ours?)?\s*(?:(\d{1,2})\s*m(?:in)?s?)?$/);
  if (m) return +m[1]! + (m[2] ? +m[2] / 60 : 0);
  const n = toNumber(v.replace(/h(rs?|ours?)?$/, ""));
  return Number.isFinite(n) ? n : null;
}

/** Break length in minutes: "30", "30 min", "0:30", or an Excel time cell. */
export function parseMinutes(cell: Cell | undefined): number | null {
  if (!cell || !cell.text) return 0;
  if (cell.serial !== undefined) return Math.round(cell.serial * 1440);
  const v = cell.text.trim().toLowerCase();
  const m = v.match(/^(\d{1,2}):([0-5]\d)$/);
  if (m) return +m[1]! * 60 + +m[2]!;
  const n = toNumber(v.replace(/m(in(ute)?s?)?$/, ""));
  return Number.isFinite(n) ? Math.round(n) : null;
}

export const parseMoney = (cell: Cell | undefined) => (cell?.text ? toNumber(cell.text) : null);

// ---------------------------------------------------------------- turning rows into data

type Mapped = { line: string; cells: Map<Target, Cell> };

/** The chosen rows, each as target → first non-empty cell mapped to it. Rows with nothing mapped are dropped. */
export function mappedRows(sheet: Sheet, setup: SheetSetup): Mapped[] {
  const out: Mapped[] = [];
  const end = Math.min(setup.lastRow, sheet.grid.length - 1, setup.firstRow + MAX_ROWS - 1);
  for (let i = Math.max(setup.firstRow, 0); i <= end; i++) {
    if (i === setup.headerRow) continue;
    const cells = new Map<Target, Cell>();
    setup.columns.forEach((t, j) => {
      const c = sheet.grid[i]?.[j];
      if (t && c?.text && !cells.has(t)) cells.set(t, c);
    });
    if (cells.size) out.push({ line: `${sheet.name} row ${rowNumber(sheet, i)}`, cells });
  }
  return out;
}

export type PersonRow = { [K in keyof Employee]?: Employee[K] | undefined } & { employee_code: string; first_name: string; last_name: string };
type Problem = string;

const text = (r: Mapped, key: string, max = 200) => r.cells.get(key)?.text.slice(0, max) ?? "";

function splitName(full: string) {
  if (full.includes(",")) { const [last = "", first = ""] = full.split(",").map((s) => s.trim()); return { first, last }; }
  const parts = full.trim().split(/\s+/);
  return { first: parts[0] ?? "", last: parts.slice(1).join(" ") };
}

/**
 * Employees from a people sheet. Rows matching an existing employee (by ID,
 * email, then name) update it, changing only the fields that were mapped and filled.
 */
export function parsePeople(
  sheet: Sheet, setup: SheetSetup, existing: Employee[], taken: Set<string>, categoryId: (target: Target) => string | undefined,
  shifts: { id: string; name: string }[] = [], defaults: EmployeeDefaults = {},
  /** A category's field_type, so values are stored in its form (Excel dates as dates, "Y" as yes…). */
  typeOf: (categoryId: string) => string | null | undefined = () => undefined,
) {
  const defaultShift = shifts.find((x) => x.id === defaults["shift_id"])?.id ?? shifts[0]?.id;
  const shiftByName = new Map(shifts.map((x) => [norm(x.name), x.id]));
  const ok: PersonRow[] = [];
  const errs: Problem[] = [];
  const byCode = new Map(existing.map((e) => [e.employee_code.toLowerCase(), e]));
  const byEmail = new Map(existing.filter((e) => e.email).map((e) => [e.email!.toLowerCase(), e]));
  const byName = new Map(existing.map((e) => [`${e.first_name} ${e.last_name}`.toLowerCase(), e]));
  let n = existing.length + 1;
  for (const r of mappedRows(sheet, setup)) {
    let first = text(r, "first", 80), last = text(r, "last", 80);
    if (!first && !last) ({ first, last } = splitName(text(r, "name", 160)));
    if (!first) { errs.push(`${r.line}: no name`); continue; }
    if (!last) last = "-";
    const email = text(r, "email", 255);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { errs.push(`${r.line}: invalid email "${email}"`); continue; }
    const rate = parseMoney(r.cells.get("rate"));
    if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 10000)) { errs.push(`${r.line}: invalid hourly rate "${text(r, "rate")}"`); continue; }
    const givenCode = text(r, "code", 40);
    const match = (givenCode && byCode.get(givenCode.toLowerCase())) || (email && byEmail.get(email.toLowerCase())) || byName.get(`${first} ${last}`.toLowerCase());
    let code = givenCode || match?.employee_code || "";
    if (!code) { do { code = `E${String(n++).padStart(3, "0")}`; } while (taken.has(code.toLowerCase())); }
    else if (!match && taken.has(code.toLowerCase())) { errs.push(`${r.line}: employee ID ${code} appears twice`); continue; }
    taken.add(code.toLowerCase());

    const custom: Record<string, string> = { ...((match?.custom_fields ?? {}) as Record<string, string>) };
    for (const [t, c] of r.cells) {
      if (!t.startsWith("custom:") && !t.startsWith("new:")) continue;
      const id = categoryId(t);
      if (id) custom[id] = categoryValue(typeOf(id), c, setup.dateOrder).slice(0, 1000);
    }
    const shiftText = text(r, "shift", 40);
    const shiftId = shiftText ? shiftByName.get(norm(shiftText)) ?? shiftByName.get(norm(shiftText.replace(/\s*shift$/i, ""))) : undefined;
    if (shiftText && !shiftId) { errs.push(`${r.line}: no "${shiftText}" shift — add it under Payroll → Customize, or fix the name`); continue; }
    const opt = (key: string, max = 200) => text(r, key, max) || undefined;
    const date = (key: string) => (r.cells.has(key) ? parseDate(r.cells.get(key), setup.dateOrder) ?? undefined : undefined);
    const row: PersonRow = {
      employee_code: code, first_name: first, last_name: last,
      email: email || match?.email || null,
      hourly_rate: rate ?? Number(match?.hourly_rate ?? defaults["hourly_rate"] ?? 0),
      department: opt("dept", 80), phone: opt("phone", 40), job_title: opt("title", 80),
      address_line1: opt("addr1"), address_line2: opt("addr2"), city: opt("city", 80), state: opt("state", 80),
      postal_code: opt("zip", 20), country: opt("country", 80), gender: opt("gender", 80), nationality: opt("nationality", 80),
      passport_no: opt("passport", 40), ssn: opt("ssn", 40), residential_status: opt("residency", 80), date_of_birth: date("dob"), hire_date: date("hire"),
      emergency_contact_name: opt("ecName", 120), emergency_contact_phone: opt("ecPhone", 40), notes: opt("notes", 2000),
      custom_fields: custom,
      // New people without a shift column start on the default profile's shift (else the first); existing people keep theirs.
      shift_id: shiftId ?? (match ? undefined : defaultShift),
    };
    for (const k of Object.keys(row) as (keyof PersonRow)[]) if (row[k] === undefined) delete row[k];
    // New people start from the default profile; the file's values win.
    ok.push(match ? row : withDefaults(row, defaults));
  }
  return { ok, errs };
}

type Person = { id?: string | undefined; employee_code: string; email?: string | null | undefined; first_name: string; last_name: string };
export type RecordRow = {
  employee_id: string | undefined; _code: string; _line: string; work_date: string; note?: string; pay_override?: number;
} & ({ entry_mode: "clock"; clock_in: string; clock_out: string; lunch_minutes: number } | { entry_mode: "hours"; hours: number });

/** Time records from an hours sheet. Days with no times and no hours are skipped, not errors. */
export function parseRecords(sheet: Sheet, setup: SheetSetup, people: Person[]) {
  const ok: RecordRow[] = [];
  const errs: Problem[] = [];
  let blankDays = 0;
  const byId = new Map(people.filter((e) => e.id).map((e) => [e.id!, e]));
  const byCode = new Map(people.map((e) => [e.employee_code.toLowerCase(), e]));
  const byEmail = new Map(people.filter((e) => e.email).map((e) => [e.email!.toLowerCase(), e]));
  const byName = new Map<string, Person>();
  for (const e of people) {
    byName.set(`${e.first_name} ${e.last_name}`.toLowerCase(), e);
    byName.set(`${e.last_name}, ${e.first_name}`.toLowerCase(), e);
  }
  const sheetEmp = setup.sheetEmployeeId ? byId.get(setup.sheetEmployeeId) : undefined;

  for (const r of mappedRows(sheet, setup)) {
    const code = text(r, "code").toLowerCase();
    const email = text(r, "email").toLowerCase();
    const name = (text(r, "name") || `${text(r, "first")} ${text(r, "last")}`).trim().toLowerCase();
    let emp = (code && byCode.get(code)) || (email && byEmail.get(email)) || (name && byName.get(name)) || undefined;
    if (!emp && !(code || email || name) && sheetEmp) emp = sheetEmp;
    if (!emp) {
      errs.push(code || email || name ? `${r.line}: no employee matches "${code || email || name}"` : `${r.line}: no employee — map an employee column or pick one for the whole sheet`);
      continue;
    }

    const dateCell = r.cells.get("date");
    const date = parseDate(dateCell, setup.dateOrder);
    if (!date) { errs.push(dateCell ? `${r.line}: can't read date "${dateCell.text}"` : `${r.line}: no date`); continue; }

    const cinCell = r.cells.get("cin"), coutCell = r.cells.get("cout"), hoursCell = r.cells.get("hours");
    const payCell = r.cells.get("pay");
    const manualPay = payCell ? parseMoney(payCell) : null;
    if (payCell && (manualPay === null || !Number.isFinite(manualPay) || manualPay < 0 || manualPay > 100000)) { errs.push(`${r.line}: can't read day pay "${payCell.text}"`); continue; }
    const base = {
      employee_id: emp.id, _code: emp.employee_code, _line: r.line, work_date: date,
      ...(text(r, "note") ? { note: text(r, "note", 300) } : {}),
      ...(manualPay !== null ? { pay_override: Math.round(manualPay * 100) / 100 } : {}),
    };
    if (cinCell || coutCell) {
      const cin = parseTime(cinCell), cout = parseTime(coutCell);
      if (cin && cout) {
        const lunch = parseMinutes(r.cells.get("lunch"));
        if (lunch === null || lunch < 0 || lunch > 600) { errs.push(`${r.line}: can't read break "${text(r, "lunch")}" (minutes or h:mm)`); continue; }
        ok.push({ ...base, entry_mode: "clock", clock_in: cin, clock_out: cout, lunch_minutes: lunch });
        continue;
      }
      if (!hoursCell) { errs.push(`${r.line}: can't read clock ${!cin ? `in "${cinCell?.text ?? ""}"` : `out "${coutCell?.text ?? ""}"`}`); continue; }
    }
    if (!hoursCell) { blankDays++; continue; }
    const hours = parseHours(hoursCell);
    if (hours === null || hours < 0 || hours > 24) { errs.push(`${r.line}: can't read hours "${hoursCell.text}" (0–24)`); continue; }
    if (hours === 0) { blankDays++; continue; }
    ok.push({ ...base, entry_mode: "hours", hours: Math.round(hours * 100) / 100 });
  }
  return { ok, errs, blankDays };
}

/** Identifies a shift, so re-importing the same timesheet doesn't add it twice. */
export function recordKey(r: { employee_id: string | undefined; work_date: string; entry_mode: string; clock_in?: string | null; clock_out?: string | null; hours?: number | string | null }) {
  const what = r.entry_mode === "clock" ? `${r.clock_in?.slice(0, 5)}-${r.clock_out?.slice(0, 5)}` : `h${Number(r.hours).toFixed(2)}`;
  return `${r.employee_id}|${r.work_date}|${what}`;
}
