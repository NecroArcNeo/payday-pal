import type { Employee, Shift, TimeRecord } from "@/lib/payroll";
import { shiftForRecord } from "@/lib/pay";
import { rateOn, type RateEntry } from "@/lib/pay-rates";

// Things worth a second look before a period is paid: records that look like typing mistakes, or that would pay
// nothing. Only flags, never changes anything; the Payroll page lists them (RecordWarnings). Pure, so it's tested
// on its own (record-checks.test.ts).

export type CheckKind = "long-day" | "no-break" | "short" | "overlap" | "long-break" | "past-midnight" | "zero-rate" | "zero-pay" | "resigned" | "before-hire";

export const CHECK_NAMES: Record<CheckKind, string> = {
  "long-day": "Very long day",
  "no-break": "No break",
  short: "Very short",
  overlap: "Overlapping",
  "long-break": "Long break",
  "past-midnight": "Past midnight",
  "zero-rate": "Rate is 0",
  "zero-pay": "Paid 0",
  resigned: "Resigned",
  "before-hire": "Before hire date",
};

/** When a check fires. Hours, except `longBreak` (minutes, as breaks are stored). */
export type CheckLimits = { longDay: number; noBreakAfter: number; shortShift: number; longBreak: number };
export const DEFAULT_LIMITS: CheckLimits = { longDay: 12, noBreakAfter: 6, shortShift: 1, longBreak: 120 };
/** Each limit as saved, or its default when missing or not a sensible number. */
export function validLimits(saved: unknown): CheckLimits {
  const s = (saved ?? {}) as Partial<Record<keyof CheckLimits, unknown>>;
  const pick = (k: keyof CheckLimits, max: number) => {
    const v = s[k];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : DEFAULT_LIMITS[k];
  };
  return { longDay: pick("longDay", 24), noBreakAfter: pick("noBreakAfter", 24), shortShift: pick("shortShift", 24), longBreak: pick("longBreak", 1440) };
}

export type RecordWarning = {
  kind: CheckKind;
  employeeId: string;
  /** The first day it's about (the day itself, or the earliest of several). */
  date: string;
  recordIds: string[];
  /** What's odd, in a sentence: "14.5 h worked in one day (over 12 h)". */
  detail: string;
  /** Changes whenever the records it's about change, so "It's fine" only covers what was looked at. */
  key: string;
};

export type CheckInput = {
  records: TimeRecord[];
  employees: Employee[];
  shifts: Shift[];
  rates?: Map<string, RateEntry[]> | undefined;
  limits: CheckLimits;
};

const minutes = (t: string) => { const [h, m] = t.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
const hhmm = (t: string | null) => (t ?? "").slice(0, 5);
const h = (n: number) => `${Number(n.toFixed(2))} h`;
const breakText = (mins: number) => (mins % 60 ? `${mins} min` : h(mins / 60));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

/** Start and end in minutes from the day's midnight; an end before the start is the next morning, as the database counts it. */
function span(r: TimeRecord): [number, number] | null {
  if (r.entry_mode !== "clock" || !r.clock_in || !r.clock_out) return null;
  const a = minutes(r.clock_in), b = minutes(r.clock_out);
  return [a, b < a ? b + 1440 : b];
}

/**
 * A night shift, which may run past midnight: its usual hours do (22:00–06:00), or, when it has none, its name says
 * so ("Night", "Overnight", "Graveyard").
 */
export function isNightShift(s: Pick<Shift, "name" | "default_clock_in" | "default_clock_out"> | undefined) {
  if (!s) return false;
  if (s.default_clock_in && s.default_clock_out) return minutes(s.default_clock_out) < minutes(s.default_clock_in);
  return /night|overnight|graveyard/i.test(s.name);
}

const signature = (rs: TimeRecord[], extra = "") =>
  rs.map((r) => [r.id, r.entry_mode, r.clock_in, r.clock_out, r.lunch_minutes, r.hours, r.pay_override, r.shift_id].join("|")).sort().join(";") + (extra && `#${extra}`);

export function checkRecords({ records, employees, shifts, rates, limits }: CheckInput): RecordWarning[] {
  const out: RecordWarning[] = [];
  const add = (kind: CheckKind, rs: TimeRecord[], detail: string, extra = "") =>
    out.push({ kind, employeeId: rs[0]!.employee_id, date: rs.map((r) => r.work_date).sort()[0]!, recordIds: rs.map((r) => r.id), detail, key: `${kind}:${signature(rs, extra)}` });
  const emps = new Map(employees.map((e) => [e.id, e]));

  // One record at a time.
  for (const r of records) {
    const hours = Number(r.hours);
    const times = span(r);
    if (hours < limits.shortShift) add("short", [r], `${h(hours)} worked${times ? ` (${hhmm(r.clock_in)}–${hhmm(r.clock_out)})` : ""}, under ${h(limits.shortShift)}`);
    if (times && r.lunch_minutes === 0 && hours > limits.noBreakAfter) add("no-break", [r], `${h(hours)} worked with no break (over ${h(limits.noBreakAfter)})`);
    if (times && r.lunch_minutes > limits.longBreak) add("long-break", [r], `${breakText(r.lunch_minutes)} break (over ${breakText(limits.longBreak)})`);
    if (times && times[1] > 1440) {
      const e = emps.get(r.employee_id);
      const shift = shifts.find((s) => s.id === shiftForRecord(r.shift_id, e?.shift_id, shifts).id);
      if (!isNightShift(shift)) add("past-midnight", [r], `${hhmm(r.clock_in)} → ${hhmm(r.clock_out)} runs past midnight on the ${shift?.name ?? "Day"} shift: times swapped?`, shift?.id ?? "");
    }
    if (r.pay_override !== null && Number(r.pay_override) === 0 && hours > 0) add("zero-pay", [r], `Pay set by hand to ${money(0)} for ${h(hours)}`);
  }

  // One person's day: its total, and records whose times overlap.
  const days = new Map<string, TimeRecord[]>();
  for (const r of records) { const k = `${r.employee_id} ${r.work_date}`; days.set(k, [...(days.get(k) ?? []), r]); }
  for (const rs of days.values()) {
    const total = rs.reduce((s, r) => s + Number(r.hours), 0);
    if (total > limits.longDay) add("long-day", rs, `${h(total)} worked in one day${rs.length > 1 ? ` (${rs.length} records)` : ""}, over ${h(limits.longDay)}`);
    const timed = rs.map((r) => ({ r, t: span(r) })).filter((x): x is { r: TimeRecord; t: [number, number] } => !!x.t).sort((a, b) => a.t[0] - b.t[0]);
    for (let i = 0; i < timed.length; i++) {
      for (let j = i + 1; j < timed.length; j++) {
        const a = timed[i]!, b = timed[j]!;
        if (b.t[0] < a.t[1]) add("overlap", [a.r, b.r], `${hhmm(a.r.clock_in)}–${hhmm(a.r.clock_out)} and ${hhmm(b.r.clock_in)}–${hhmm(b.r.clock_out)} overlap: entered twice?`);
      }
    }
  }

  // One person at a time: things about them, not one record.
  const byEmp = new Map<string, TimeRecord[]>();
  for (const r of records) byEmp.set(r.employee_id, [...(byEmp.get(r.employee_id) ?? []), r]);
  for (const [id, rs] of byEmp) {
    const e = emps.get(id);
    if (!e) continue;
    const unpaid = rs.filter((r) => r.pay_override === null && Number(r.hours) > 0 && rateOn(rates?.get(id), e.hourly_rate, r.work_date) === 0);
    if (unpaid.length) add("zero-rate", unpaid, `Hourly rate is ${money(0)}: ${plural(unpaid.length, "record")} pay nothing`);
    if (!e.active) add("resigned", rs, `Marked as resigned, but has ${plural(rs.length, "record")} in this period`, "resigned");
    const early = e.hire_date ? rs.filter((r) => r.work_date < e.hire_date!) : [];
    if (early.length) add("before-hire", early, `${plural(early.length, "record")} before their hire date, ${e.hire_date}`, e.hire_date ?? "");
  }

  return out.sort((a, b) => a.date.localeCompare(b.date) || a.employeeId.localeCompare(b.employeeId) || a.kind.localeCompare(b.kind));
}
