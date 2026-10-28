import * as XLSX from "xlsx";
import { getPref, setPref, usePref } from "@/lib/prefs";
import type { PayLine } from "@/lib/pay";
import { colLetters, colNumber, parseAddress, TemplateError, type CellValue } from "./xlsx-template";

// What a timesheet export holds, and the user's own Excel templates: which cell gets each value, and
// which columns the day-by-day rows fill. Templates are kept on this device (with display preferences),
// not in the payroll database; the user still has the original file.

/** One-off values, each into one cell of a template. */
export const SHEET_FIELDS = {
  employee_name: "Employee name", first_name: "First name", last_name: "Last name", employee_code: "Employee ID",
  department: "Department", job_title: "Position", email: "Email", phone: "Phone", hire_date: "Hire date",
  shift: "Shift", pay_type: "Pay type", hourly_rate: "Hourly rate",
  period_from: "Period start", period_to: "Period end", period: "Period (from – to)", days_worked: "Days worked",
  total_hours: "Total hours", regular_hours: "Regular hours", overtime_hours: "Overtime hours", weekend_hours: "Weekend hours",
  regular_pay: "Regular pay", overtime_pay: "Overtime pay", set_pay: "Pay for days with a set amount", hours_pay: "Pay from hours", extra_pay: "Extra pay", total_pay: "Total pay",
  today: "Today's date",
} as const;
/** The day-by-day columns: one row per record (or per day). */
export const ROW_FIELDS = {
  date: "Date", weekday: "Weekday", week_of: "Week of (Monday)", weekend: "Weekend (shows \"Weekend\")", entry_type: "Entry type",
  shift: "Shift", clock_in: "Clock in", clock_out: "Clock out", break_minutes: "Break (minutes)",
  break_hours: "Break (hours)", hours: "Hours", regular_hours: "Regular hours", overtime_hours: "Overtime hours", rate: "Rate",
  regular_pay: "Regular pay", overtime_pay: "Overtime pay", pay: "Day pay", note: "Note",
} as const;
/** A built-in value, or one of the user's own categories (`custom:<category id>`). */
export type SheetField = keyof typeof SHEET_FIELDS | `custom:${string}`;
/** The user's categories a template can show: not ones under Personal, which stay on the profile. */
export type TemplateCategory = { id: string; label: string; field_type: string };
export const fieldLabel = (k: SheetField, categories: TemplateCategory[] = []) =>
  k.startsWith("custom:") ? categories.find((c) => `custom:${c.id}` === k)?.label ?? "A deleted category" : SHEET_FIELDS[k as keyof typeof SHEET_FIELDS];
export type RowField = keyof typeof ROW_FIELDS;

export type TimesheetData = { values: Partial<Record<SheetField, CellValue>>; rows: Record<RowField, CellValue>[] };

export type TimesheetTemplate = {
  id: string; name: string; fileName: string;
  /** The Excel file, base64. */
  file: string;
  /** The worksheet to fill (null: the first). */
  sheet: string | null;
  cells: Partial<Record<SheetField, string>>;
  table: {
    /** Column letters per row field. */
    columns: Partial<Record<RowField, string>>;
    /** The first day-by-day row. */
    startRow: number | null;
    /** How many rows the template has room for (null: no limit). */
    rows: number | null;
    /** One row per record, or one per calendar day of the period (days off left blank, a day's records combined). */
    per: "record" | "day";
  };
};

// ---------------------------------------------------------------- the values

export type SheetRecord = {
  id: string; work_date: string; entry_mode: string; clock_in: string | null; clock_out: string | null;
  lunch_minutes: number; hours: number | string; note: string | null; shiftName: string; rate: number; pay_override?: number | string | null;
};

const mondayOf = (d: string) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
const weekdayOf = (d: string) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${d}T00:00:00Z`).getUTCDay()]!;
const round2 = (n: number) => Math.round(n * 100) / 100;
const dayList = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
};

/**
 * Everything a timesheet export can show. `records` are the period's records, oldest first; `lines` their pay.
 * `per: "day"` gives one row per calendar day, combining a day's records (first in, last out, hours and pay added).
 */
export function timesheetData(input: {
  employee: {
    first_name: string; last_name: string; employee_code: string; department: string | null; job_title: string | null; pay_type: string;
    email?: string | null; phone?: string | null; hire_date?: string | null; custom_fields?: unknown;
  };
  categories?: TemplateCategory[];
  shiftName: string; rates: number[]; from: string; to: string; today: string;
  records: SheetRecord[]; lines: Map<string, PayLine>; extraPay: number;
}, per: "record" | "day" = "record"): TimesheetData {
  const { employee: e, records, lines } = input;
  const line = (r: SheetRecord) => lines.get(r.id);
  const sum = (rs: SheetRecord[], f: (l: PayLine) => number) => round2(rs.reduce((s, r) => s + (line(r) ? f(line(r)!) : 0), 0));
  const hoursOf = (rs: SheetRecord[]) => round2(rs.reduce((s, r) => s + Number(r.hours), 0));
  const hoursPay = sum(records, (l) => l.pay);
  const custom = (e.custom_fields && typeof e.custom_fields === "object" ? e.custom_fields : {}) as Record<string, unknown>;
  const values: Partial<Record<SheetField, CellValue>> = {
    employee_name: `${e.first_name} ${e.last_name}`, first_name: e.first_name, last_name: e.last_name, employee_code: e.employee_code,
    department: e.department ?? "", job_title: e.job_title ?? "", email: e.email ?? "", phone: e.phone ?? "", hire_date: e.hire_date ? { date: e.hire_date } : "",
    shift: input.shiftName, pay_type: e.pay_type === "salary" ? "Salary" : "Hourly",
    hourly_rate: input.rates.length === 1 ? input.rates[0]! : input.rates.map((r) => r.toFixed(2)).join(" → "),
    period_from: { date: input.from }, period_to: { date: input.to }, period: `${input.from} – ${input.to}`,
    days_worked: new Set(records.map((r) => r.work_date)).size,
    total_hours: hoursOf(records), regular_hours: sum(records, (l) => l.regular), overtime_hours: sum(records, (l) => l.overtime),
    weekend_hours: sum(records, (l) => (l.weekend ? l.regular + l.overtime : 0)),
    regular_pay: sum(records, (l) => l.regPay), overtime_pay: sum(records, (l) => l.otPay), set_pay: sum(records, (l) => (l.manual ? l.pay : 0)), hours_pay: hoursPay,
    extra_pay: round2(input.extraPay), total_pay: round2(hoursPay + input.extraPay), today: { date: input.today },
  };
  for (const c of input.categories ?? []) {
    const raw = custom[c.id];
    const text = raw === undefined || raw === null ? "" : String(raw);
    const n = Number(text.replace(/[$,\s]/g, ""));
    values[`custom:${c.id}`] = c.field_type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(text) ? { date: text }
      : (c.field_type === "number" || c.field_type === "money") && text.trim() && Number.isFinite(n) ? n : text;
  }
  const row = (date: string, rs: SheetRecord[]): Record<RowField, CellValue> => {
    const clock = rs.filter((r) => r.entry_mode === "clock" && r.clock_in && r.clock_out);
    const breaks = rs.reduce((s, r) => s + (r.entry_mode === "clock" ? r.lunch_minutes : 0), 0);
    const rates = [...new Set(rs.map((r) => r.rate))];
    const empty = !rs.length;
    return {
      date: { date }, weekday: weekdayOf(date), week_of: { date: mondayOf(date) }, weekend: [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay()) ? "Weekend" : null,
      entry_type: [...new Set(rs.map((r) => (r.pay_override !== null && r.pay_override !== undefined ? "Set amount" : r.entry_mode === "clock" ? "Clock in/out" : "Daily hours")))].join(", ") || null,
      shift: [...new Set(rs.map((r) => r.shiftName))].join(", "),
      clock_in: clock.length ? { time: clock[0]!.clock_in!.slice(0, 5) } : null,
      clock_out: clock.length ? { time: clock.at(-1)!.clock_out!.slice(0, 5) } : null,
      break_minutes: empty || !clock.length ? null : breaks, break_hours: empty || !clock.length ? null : round2(breaks / 60),
      hours: empty ? null : hoursOf(rs), regular_hours: empty ? null : sum(rs, (l) => l.regular), overtime_hours: empty ? null : sum(rs, (l) => l.overtime),
      rate: rates.length === 1 ? rates[0]! : rates.length ? rates.map((r) => r.toFixed(2)).join(" / ") : null,
      regular_pay: empty ? null : sum(rs, (l) => l.regPay), overtime_pay: empty ? null : sum(rs, (l) => l.otPay), pay: empty ? null : sum(rs, (l) => l.pay),
      note: rs.map((r) => r.note).filter(Boolean).join("; ") || null,
    };
  };
  const rows = per === "record"
    ? records.map((r) => row(r.work_date, [r]))
    : dayList(input.from, input.to).map((d) => row(d, records.filter((r) => r.work_date === d)));
  return { values, rows };
}

/** The cells a template gets. Throws when the period has more rows than the template has room for. */
export function templateCells(t: TimesheetTemplate, data: TimesheetData): Map<string, CellValue> {
  const cells = new Map<string, CellValue>();
  for (const [k, ref] of Object.entries(t.cells) as [SheetField, string][]) {
    if (ref) cells.set(ref.toUpperCase(), data.values[k] ?? "");
  }
  const cols = (Object.entries(t.table.columns) as [RowField, string][]).filter(([, c]) => c);
  if (cols.length && t.table.startRow) {
    if (t.table.rows !== null && data.rows.length > t.table.rows) {
      throw new TemplateError(`The template has room for ${t.table.rows} rows, and this period needs ${data.rows.length}. Pick a shorter period, or give the template more rows.`);
    }
    data.rows.forEach((r, i) => { for (const [k, col] of cols) cells.set(`${col.toUpperCase()}${t.table.startRow! + i}`, r[k]); });
    // Rows the template has room for but this period doesn't use are emptied, so sample entries don't linger.
    for (let i = data.rows.length; i < (t.table.rows ?? 0); i++) for (const [, col] of cols) cells.set(`${col.toUpperCase()}${t.table.startRow + i}`, null);
  }
  return cells;
}

/** Problems that would make a template fill the wrong cells, or nothing. */
export function templateProblems(t: TimesheetTemplate, categories: TemplateCategory[] = []): string[] {
  const out: string[] = [];
  for (const [k, ref] of Object.entries(t.cells) as [SheetField, string][]) if (ref && !parseAddress(ref)) out.push(`${fieldLabel(k, categories)}: "${ref}" isn't a cell like B3`);
  const cols = Object.entries(t.table.columns).filter(([, c]) => c) as [RowField, string][];
  for (const [k, c] of cols) if (!/^[A-Za-z]{1,3}$/.test(c)) out.push(`${ROW_FIELDS[k]}: "${c}" isn't a column letter`);
  if (cols.length && !t.table.startRow) out.push("Say which row the day-by-day rows start on");
  if (!cols.length && !Object.values(t.cells).some(Boolean)) out.push("Nothing is placed on the template yet");
  // Day-by-day rows running into a value placed below them would overwrite it.
  if (t.table.startRow && cols.length) {
    const end = t.table.rows === null ? Infinity : t.table.startRow + t.table.rows - 1;
    const colSet = new Set(cols.map(([, c]) => colNumber(c)));
    for (const [k, ref] of Object.entries(t.cells) as [SheetField, string][]) {
      const a = ref && parseAddress(ref);
      if (a && a.row >= t.table.startRow && a.row <= end && colSet.has(a.col)) out.push(`${fieldLabel(k, categories)} (${ref}) is inside the day-by-day rows${t.table.rows === null ? "; set how many rows the template has" : ""}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- plain files (no template)

/** A plain table: who and when, then a row per record (or day), then the totals. */
function plainTable(data: TimesheetData): (string | number)[][] {
  const v = data.values;
  const show = (c: CellValue | undefined): string | number => (c === null || c === undefined ? "" : typeof c === "object" ? ("date" in c ? c.date : c.time) : c);
  const cols = Object.keys(ROW_FIELDS) as RowField[];
  return [
    ["Timesheet", show(v.employee_name), show(v.employee_code)],
    ["Period", show(v.period_from), show(v.period_to)],
    [],
    cols.map((c) => ROW_FIELDS[c]),
    ...data.rows.map((r) => cols.map((c) => show(r[c]))),
    [],
    ["Total hours", show(v.total_hours)], ["Regular hours", show(v.regular_hours)], ["Overtime hours", show(v.overtime_hours)],
    ["Regular pay", show(v.regular_pay)], ["Overtime pay", show(v.overtime_pay)], ["Extra pay", show(v.extra_pay)], ["Total pay", show(v.total_pay)],
  ];
}

export function plainXlsx(data: TimesheetData): Uint8Array {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(plainTable(data));
  ws["!cols"] = Object.keys(ROW_FIELDS).map(() => ({ wch: 13 }));
  XLSX.utils.book_append_sheet(wb, ws, "Timesheet");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

export function plainCsv(data: TimesheetData): string {
  return plainTable(data).map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
}

// ---------------------------------------------------------------- storage

const KEY = "meridian-timesheet-templates";
/** Kept with the display preferences, whose storage holds a few megabytes in all. */
export const MAX_TEMPLATE_BYTES = 1_500_000;

export const useTemplates = () => usePref<TimesheetTemplate[]>(KEY, [])[0];

/** Saves the list. Throws if this device can't hold it (the storage is full). */
export function saveTemplates(list: TimesheetTemplate[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    throw new Error("There isn't room to keep this template on this device. Delete a template you don't use, or use a smaller file.");
  }
  setPref(KEY, list);
}
export const getTemplates = () => getPref<TimesheetTemplate[]>(KEY, []);

export function toBase64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(b64: string) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export { colLetters };
