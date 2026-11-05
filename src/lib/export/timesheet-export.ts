import * as XLSX from "xlsx";
import { strToU8 } from "fflate";
import type { PayLine } from "@/lib/pay";
import { colLetters, colNumber, fillTemplate, parseAddress, TemplateError, templateSheets, type CellValue } from "./xlsx-template";
import { centsAddingUp, readAmount } from "@/lib/amount";

// What a timesheet export holds, and the user's own Excel templates: which cell gets each value, and
// which columns the day-by-day rows fill. Templates are kept on this device (template-store.ts), not in the
// payroll database; the user still has the original file.

/** One-off values, each into one cell of a template. */
export const SHEET_FIELDS = {
  employee_name: "Employee name", first_name: "First name", last_name: "Last name", employee_code: "Employee ID",
  department: "Department", job_title: "Position", email: "Email", phone: "Phone", hire_date: "Hire date",
  shift: "Shift", pay_type: "Pay type", hourly_rate: "Hourly rate",
  period_from: "Period start", period_to: "Period end", period: "Period (from – to)", days_worked: "Days worked",
  total_hours: "Total hours", regular_hours: "Regular hours", overtime_hours: "Overtime hours", weekend_hours: "Weekend hours",
  regular_pay: "Regular pay", overtime_pay: "Overtime pay", set_pay: "Pay for days with a set amount", hours_pay: "Pay from hours", extra_pay: "Extra pay", total_pay: "Total pay",
  today: "Today's date",
  // Payslip values: only listed (and filled) while deductions or pay runs are on (Settings → Features).
  deductions_total: "Deductions (total)", net_pay: "Net pay",
  paid_on: "Paid on (pay run)", ytd_gross: "Year to date: gross pay", ytd_deductions: "Year to date: deductions", ytd_net: "Year to date: net pay",
} as const;
/** The payslip fields each feature adds to the template editor. */
export const DEDUCTION_FIELDS = ["deductions_total", "net_pay"] as const;
export const PAY_RUN_FIELDS = ["paid_on", "ytd_gross", "ytd_deductions", "ytd_net"] as const;
/** The day-by-day columns: one row per record (or per day). */
export const ROW_FIELDS = {
  date: "Date", weekday: "Weekday", week_of: "Week of (Monday)", weekend: "Weekend (shows \"Weekend\")", entry_type: "Entry type",
  shift: "Shift", clock_in: "Clock in", clock_out: "Clock out", break_minutes: "Break (minutes)",
  break_hours: "Break (hours)", hours: "Hours", regular_hours: "Regular hours", overtime_hours: "Overtime hours", rate: "Rate",
  regular_pay: "Regular pay", overtime_pay: "Overtime pay", pay: "Day pay", note: "Note",
} as const;
/** A built-in value, or one of the user's own categories (`custom:<category id>`). */
export type SheetField = keyof typeof SHEET_FIELDS | `custom:${string}` | `deduction:${string}`;
/** The user's categories a template can show: not ones under Personal, which stay on the profile. */
export type TemplateCategory = { id: string; label: string; field_type: string };
export const fieldLabel = (k: SheetField, categories: TemplateCategory[] = []) =>
  k.startsWith("custom:") ? categories.find((c) => `custom:${c.id}` === k)?.label ?? "A deleted category"
    : k.startsWith("deduction:") ? `Deduction: ${k.slice(10)}`
    : SHEET_FIELDS[k as keyof typeof SHEET_FIELDS];
/**
 * What a payslip adds to a timesheet: the period's deductions (worked out, or as a recorded pay run saved them), and
 * when the period was paid in a pay run, its date and the year-to-date totals.
 */
export type Payslip = {
  deductions: { name: string; amount: number }[] | null; deductionsTotal: number | null; net: number | null;
  paidOn: string | null; ytd: { gross: number; deductions: number; net: number } | null;
};
export type RowField = keyof typeof ROW_FIELDS;
export type WeekStart = number | "period";
export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** Builds an export's values for one layout: what the template (or plain file) asks for. */
export type TimesheetSource = (per: "record" | "day", weeks: number | null, weekStart: WeekStart) => TimesheetData;

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
    /** Show this many whole weeks, every day dated even with no records (null or missing: just the period's records, or days). */
    weeks?: number | null;
    /** The day those weeks start on: a weekday (0 Sunday … 6 Saturday; missing: Monday), counting back from the
     *  period's start to the last such day, or "period" for the period's own first day. */
    weekStart?: WeekStart;
  };
};

// ---------------------------------------------------------------- the values

export type SheetRecord = {
  id: string; work_date: string; entry_mode: string; clock_in: string | null; clock_out: string | null;
  lunch_minutes: number; hours: number | string; note: string | null; shiftName: string; rate: number; pay_override?: number | string | null;
};

const mondayOf = (d: string) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
const weekdayOf = (d: string) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${d}T00:00:00Z`).getUTCDay()]!;
/** The day a week of rows starts on: the period's first day, or the last `start` weekday on or before it. */
export const weekStartOf = (from: string, start: WeekStart = 1) => {
  if (start === "period") return from;
  const x = new Date(`${from}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() - start + 7) % 7));
  return x.toISOString().slice(0, 10);
};
const round2 = (n: number) => Math.round(n * 100) / 100;

const dayList = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
};

/**
 * Everything a timesheet export can show. `records` are the period's records, oldest first; `lines` their pay.
 * `per: "day"` gives one row per calendar day, combining a day's records (first in, last out, hours and pay added).
 * `weeks` lays the rows over that many whole weeks from `weekStart` (see `weekStartOf`), so every day shows its
 * date and weekday: a day without records gets one blank row. Throws if the period runs past those weeks.
 */
export function timesheetData(input: {
  employee: {
    first_name: string; last_name: string; employee_code: string; department: string | null; job_title: string | null; pay_type: string;
    email?: string | null; phone?: string | null; hire_date?: string | null; custom_fields?: unknown;
  };
  categories?: TemplateCategory[];
  shiftName: string; rates: number[]; from: string; to: string; today: string;
  records: SheetRecord[]; lines: Map<string, PayLine>; extraPay: number;
  payslip?: Payslip | null | undefined;
}, per: "record" | "day" = "record", weeks: number | null = null, weekStart: WeekStart = 1): TimesheetData {
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
  const slip = input.payslip;
  if (slip?.deductions) {
    values.deductions_total = slip.deductionsTotal ?? 0;
    values.net_pay = slip.net ?? round2(hoursPay + input.extraPay);
    for (const d of slip.deductions) values[`deduction:${d.name}`] = round2(Number(values[`deduction:${d.name}`] ?? 0) + d.amount);
  }
  if (slip?.paidOn) values.paid_on = { date: slip.paidOn };
  if (slip?.ytd) { values.ytd_gross = slip.ytd.gross; values.ytd_deductions = slip.ytd.deductions; values.ytd_net = slip.ytd.net; }
  for (const c of input.categories ?? []) {
    const raw = custom[c.id];
    const text = raw === undefined || raw === null ? "" : String(raw);
    const n = readAmount(text);
    values[`custom:${c.id}`] = c.field_type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(text) ? { date: text }
      : (c.field_type === "number" || c.field_type === "money") && text.trim() && Number.isFinite(n) ? n : text;
  }
  // Each row's exact pay, so the rounded rows can be made to add up to the totals above.
  const exact = new WeakMap<Record<RowField, CellValue>, Record<"regular_pay" | "overtime_pay" | "pay", number>>();
  const exactSum = (rs: SheetRecord[], f: (l: PayLine) => number) => rs.reduce((s, r) => s + (line(r) ? f(line(r)!) : 0), 0);
  const row = (date: string, rs: SheetRecord[]): Record<RowField, CellValue> => {
    const out = cells(date, rs);
    if (rs.length) exact.set(out, { regular_pay: exactSum(rs, (l) => l.regPay), overtime_pay: exactSum(rs, (l) => l.otPay), pay: exactSum(rs, (l) => l.pay) });
    return out;
  };
  const cells = (date: string, rs: SheetRecord[]): Record<RowField, CellValue> => {
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
  let days: string[] | null = per === "day" ? dayList(input.from, input.to) : null;
  if (weeks) {
    const start = weekStartOf(input.from, weekStart);
    const end = new Date(`${start}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + weeks * 7 - 1);
    const last = end.toISOString().slice(0, 10);
    const lastRecord = records.reduce((m, r) => (r.work_date > m ? r.work_date : m), input.to);
    if (lastRecord > last) {
      throw new TemplateError(`The template shows ${weeks} week${weeks === 1 ? "" : "s"} (${start} to ${last}), and this period runs to ${lastRecord}. Pick a shorter period, or show more weeks.`);
    }
    days = dayList(start, last);
  }
  const rows = !days
    ? records.map((r) => row(r.work_date, [r]))
    : days.flatMap((d) => {
      const rs = records.filter((r) => r.work_date === d);
      return per === "day" || !rs.length ? [row(d, rs)] : rs.map((r) => row(d, [r]));
    });
  const totals = { regular_pay: values.regular_pay, overtime_pay: values.overtime_pay, pay: values.hours_pay } as Record<"regular_pay" | "overtime_pay" | "pay", number>;
  for (const k of ["regular_pay", "overtime_pay", "pay"] as const) {
    const filled = rows.filter((r) => exact.has(r));
    const shared = centsAddingUp(filled.map((r) => exact.get(r)![k]), Math.round(totals[k] * 100));
    filled.forEach((r, i) => { r[k] = shared[i]!; });
  }
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
  if (t.table.weeks && t.table.per === "day" && t.table.rows !== null && t.table.weeks * 7 > t.table.rows) {
    out.push(`${t.table.weeks} weeks need ${t.table.weeks * 7} rows, and the template has room for ${t.table.rows}`);
  }
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

/** Where the plain table's header row is, in `plainTable`'s lines. */
export const PLAIN_HEADER_ROW = 3;

/**
 * A plain table: who and when, then a row per record (or day), then the totals. `compact` leaves out the
 * day-by-day columns that are empty all period (for a PDF, where every column costs width).
 */
/** Column headers where the template editor's name explains more than a file's header should. */
const PLAIN_HEADERS: Partial<Record<RowField, string>> = { weekend: "Weekend" };

export function plainTable(data: TimesheetData, compact = false): (string | number)[][] {
  const v = data.values;
  const show = (c: CellValue | undefined): string | number => (c === null || c === undefined ? "" : typeof c === "object" ? ("date" in c ? c.date : c.time) : c);
  const cols = (Object.keys(ROW_FIELDS) as RowField[]).filter((c) => !compact || c === "date" || data.rows.some((r) => show(r[c]) !== ""));
  return [
    ["Timesheet", show(v.employee_name), show(v.employee_code)],
    ["Period", show(v.period_from), show(v.period_to)],
    [],
    cols.map((c) => PLAIN_HEADERS[c] ?? ROW_FIELDS[c]),
    ...data.rows.map((r) => cols.map((c) => show(r[c]))),
    [],
    ["Total hours", show(v.total_hours)], ["Regular hours", show(v.regular_hours)], ["Overtime hours", show(v.overtime_hours)],
    ["Regular pay", show(v.regular_pay)], ["Overtime pay", show(v.overtime_pay)], ["Extra pay", show(v.extra_pay)], ["Total pay", show(v.total_pay)],
    // The payslip part, when deductions or pay runs are on.
    ...(v.net_pay !== undefined ? [
      ...(Object.keys(v) as SheetField[]).filter((k) => k.startsWith("deduction:")).map((k) => [fieldLabel(k), show(v[k])]),
      ["Deductions", show(v.deductions_total)], ["Net pay", show(v.net_pay)],
    ] : []),
    ...(v.paid_on !== undefined ? [["Paid on", show(v.paid_on)]] : []),
    ...(v.ytd_gross !== undefined ? [["Year to date: gross pay", show(v.ytd_gross)], ["Year to date: deductions", show(v.ytd_deductions)], ["Year to date: net pay", show(v.ytd_net)]] : []),
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

// ---------------------------------------------------------------- the finished file

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const safeFileName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "-").trim() || "timesheet";

/** What an export is made as: a plain Excel or CSV file, or one of the user's templates. */
export type ExportFormat = "xlsx" | "csv" | "pdf";
export type ExportKind = { format: ExportFormat; template?: TimesheetTemplate | undefined };
export type ExportedFile = { name: string; type: string; bytes: Uint8Array };

/** Saved as text in routines: "xlsx", "csv", "pdf", or a template's id (as Excel) or "pdf:" and its id. */
export const exportKindKey = (k: ExportKind) => (k.template ? `${k.format === "pdf" ? "pdf:" : ""}${k.template.id}` : k.format);
export function exportKindFrom(key: string, templates: TimesheetTemplate[]): ExportKind | null {
  if (key === "xlsx" || key === "csv" || key === "pdf") return { format: key };
  const pdf = key.startsWith("pdf:");
  const template = templates.find((t) => t.id === (pdf ? key.slice(4) : key));
  return template ? { format: pdf ? "pdf" : "xlsx", template } : null;
}

/**
 * The finished file for one timesheet. `name` has no extension. Throws (TemplateError) when a template can't hold
 * it, or, for a template's PDF, when one of its formulas can't be worked out. PDF code loads only when it's used.
 */
export async function exportFile(kind: ExportKind, data: TimesheetSource, name: string): Promise<ExportedFile> {
  const t = kind.template;
  if (!t) {
    const d = data("record", null, 1);
    if (kind.format === "xlsx") return { name: `${safeFileName(name)}.xlsx`, type: XLSX_TYPE, bytes: plainXlsx(d) };
    if (kind.format === "csv") return { name: `${safeFileName(name)}.csv`, type: "text/csv", bytes: strToU8("﻿" + plainCsv(d)) };
    const { canvasMeasure, plainSheet, sheetPdf } = await import("./pdf");
    return { name: `${safeFileName(name)}.pdf`, type: "application/pdf", bytes: sheetPdf(plainSheet(plainTable(d, true), PLAIN_HEADER_ROW, canvasMeasure()), name) };
  }
  const filled = fillTemplate(fromBase64(t.file), t.sheet, templateCells(t, data(t.table.per, t.table.weeks ?? null, t.table.weekStart ?? 1)));
  if (kind.format === "pdf") {
    const [{ sheetPdf }, { renderSheet }] = await Promise.all([import("./pdf"), import("./sheet-render")]);
    const sheet = t.sheet ?? templateSheets(filled).find((s) => s.fillable && !s.hidden)?.name ?? "";
    // Formulas worked out again (Excel would on opening the file), and only the print area if the sheet has one.
    const drawn = renderSheet(filled, sheet, { minRows: 1, minCols: 1, maxRows: 2000, maxCols: 100, recalculate: new Date(), printArea: true });
    return { name: `${safeFileName(`${t.name} ${name}`)}.pdf`, type: "application/pdf", bytes: sheetPdf(drawn, `${t.name} ${name}`) };
  }
  const macro = /\.xlsm$/i.test(t.fileName);
  return { name: `${safeFileName(`${t.name} ${name}`)}.${macro ? "xlsm" : "xlsx"}`, type: macro ? "application/vnd.ms-excel.sheet.macroEnabled.12" : XLSX_TYPE, bytes: filled };
}

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
