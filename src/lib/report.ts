import type { Employee, Shift, TimeRecord } from "@/lib/payroll";
import { addDays, isoDate } from "@/lib/payroll";
import { payByRecord, shiftForRecord, weekStart, type PayLine, type PayRules } from "@/lib/pay";
import type { RateEntry } from "@/lib/pay-rates";

// The numbers behind the Reports page and the profile's "Pay & hours" chart: a metric (pay, hours…) added up per day,
// week, month or year over any range, optionally split by department, shift or employee. Pay comes from payByRecord,
// the same rules as the Payroll page (weekly overtime, shifts, rate history, salary, manual and locked pay), so a
// report and a payroll run for the same days always agree. Pure: tested in report.test.ts.

export type GroupBy = "day" | "week" | "month" | "year";
export type Metric = "pay" | "hours" | "overtime" | "reg_ot" | "extra" | "people" | "days" | "per_hour";
export type SplitBy = "none" | "department" | "shift" | "employee";
export type Unit = "money" | "hours" | "count";

export const GROUPS: Record<GroupBy, string> = { day: "Day", week: "Week", month: "Month", year: "Year" };
export const METRICS: Record<Metric, { label: string; unit: Unit; hint: string }> = {
  pay: { label: "Gross pay", unit: "money", hint: "Pay for hours worked plus extra pay (bonuses etc.), as on the Payroll page" },
  hours: { label: "Hours worked", unit: "hours", hint: "Regular and overtime hours" },
  overtime: { label: "Overtime hours", unit: "hours", hint: "Hours paid at the overtime rate" },
  reg_ot: { label: "Regular vs overtime", unit: "hours", hint: "Hours, split into regular and overtime" },
  extra: { label: "Extra pay", unit: "money", hint: "Bonuses, reimbursements and other extra pay, by their pay date" },
  people: { label: "People who worked", unit: "count", hint: "How many different people have records" },
  days: { label: "Days worked", unit: "count", hint: "Person-days with records (two records the same day count once)" },
  per_hour: { label: "Pay per hour", unit: "money", hint: "Pay for hours worked divided by hours (extra pay left out)" },
};
export const SPLITS: Record<SplitBy, string> = { none: "Nothing", department: "Department", shift: "Shift", employee: "Employee" };
/** Split by employee shows this many people by name; the rest are added up as "Everyone else". */
export const TOP_PEOPLE = 8;

export type Bucket = { key: string; label: string; from: string; to: string };
export type Series = { key: string; label: string };
export type Report = {
  buckets: Bucket[];
  series: Series[];
  /** values[bucket][series]. */
  values: number[][];
  /** Each series over the whole range (people and pay per hour are worked out over the range, not added up). */
  seriesTotals: number[];
  total: number;
  unit: Unit;
};

export type ReportInput = {
  /** Records for whole Mon–Sun weeks around the range, so weekly overtime and salary come out right. */
  records: TimeRecord[];
  employees: Employee[];
  shifts: Shift[];
  rates?: Map<string, RateEntry[]> | undefined;
  rules: PayRules;
  adjustments: { employee_id: string; pay_date: string; amount: number | string }[];
  from: string;
  to: string;
  groupBy: GroupBy;
  metric: Metric;
  splitBy: SplitBy;
  /** Only these people; everyone when left out. */
  employeeIds?: string[] | undefined;
  /** Pay per record, when already worked out (it's the slow part); else worked out here. */
  pay?: Map<string, PayLine> | undefined;
};

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const fmt = (iso: string, o: Intl.DateTimeFormatOptions) => day(iso).toLocaleDateString("en-US", { ...o, timeZone: "UTC" });
const monthEnd = (iso: string) => isoDate(new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), 0));

/** The day, week (from its Monday), month or year a date falls in, and the range it covers within [from, to]. */
function bucketOf(date: string, groupBy: GroupBy, from: string, to: string): Bucket {
  let start: string, end: string, label: string;
  switch (groupBy) {
    case "day": start = end = date; label = fmt(date, { month: "short", day: "numeric" }); break;
    case "week": start = weekStart(date); end = addDays(start, 6); label = fmt(start, { month: "short", day: "numeric" }); break;
    case "month": start = `${date.slice(0, 7)}-01`; end = monthEnd(start); label = fmt(start, { month: "short", year: "numeric" }); break;
    case "year": start = `${date.slice(0, 4)}-01-01`; end = `${date.slice(0, 4)}-12-31`; label = date.slice(0, 4); break;
  }
  return { key: start, label, from: start < from ? from : start, to: end > to ? to : end };
}

/** Every bucket from `from` to `to`, empty ones included, so a quiet month shows as 0 rather than disappearing. */
export function bucketsBetween(from: string, to: string, groupBy: GroupBy): Bucket[] {
  const out: Bucket[] = [];
  for (let d = from; d <= to; ) {
    const b = bucketOf(d, groupBy, from, to);
    out.push(b);
    d = addDays(b.to, 1);
  }
  return out;
}

/** A sensible grouping for a range: days up to a month, weeks up to about half a year, then months. */
export function autoGroup(from: string, to: string): GroupBy {
  const days = (day(to).getTime() - day(from).getTime()) / 86_400_000 + 1;
  return days <= 31 ? "day" : days <= 190 ? "week" : days <= 3 * 366 ? "month" : "year";
}

/**
 * The range just before [from, to], for "compared with the previous period": the same number of whole months when
 * the range is whole months (Sep–Nov compares with Jun–Aug, not 91 days from Jun 2), else the same number of days.
 */
export function previousRange(from: string, to: string) {
  if (from.endsWith("-01") && to === monthEnd(`${to.slice(0, 7)}-01`)) {
    const months = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
    const y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
    return { from: isoDate(new Date(y, m - 1 - months, 1)), to: isoDate(new Date(y, m - 1, 0)) };
  }
  const days = Math.round((day(to).getTime() - day(from).getTime()) / 86_400_000) + 1;
  return { from: addDays(from, -days), to: addDays(from, -1) };
}

export function buildReport(input: ReportInput): Report {
  const { records, employees, shifts, rates, rules, adjustments, from, to, groupBy, metric, splitBy, employeeIds } = input;
  const unit = METRICS[metric].unit;
  const only = employeeIds ? new Set(employeeIds) : null;
  const emps = new Map(employees.map((e) => [e.id, e]));
  const shiftName = new Map(shifts.map((s) => [s.id, s.name]));
  const pay = input.pay ?? payByRecord(records, employees, shifts, rules, rates);
  const inRange = (d: string) => d >= from && d <= to;
  const wanted = (id: string) => (!only || only.has(id)) && emps.has(id);

  // Each record and extra-pay entry in the range, as amounts against a group (the series it belongs to).
  type Part = { date: string; emp: string; group: string; pay: number; regular: number; overtime: number; extra: number; worked: boolean };
  const groupOf = (empId: string, recordShift: string | null | undefined) => {
    const e = emps.get(empId)!;
    if (splitBy === "department") return e.department?.trim() || "No department";
    if (splitBy === "shift") return shiftName.get(shiftForRecord(recordShift, e.shift_id, shifts).id ?? "") ?? "No shift";
    if (splitBy === "employee") return empId;
    return "total";
  };
  const parts: Part[] = [];
  for (const r of records) {
    if (!inRange(r.work_date) || !wanted(r.employee_id)) continue;
    const l = pay.get(r.id);
    parts.push({ date: r.work_date, emp: r.employee_id, group: groupOf(r.employee_id, r.shift_id), pay: l?.pay ?? 0, regular: l?.regular ?? Number(r.hours), overtime: l?.overtime ?? 0, extra: 0, worked: true });
  }
  for (const a of adjustments) {
    if (!inRange(a.pay_date) || !wanted(a.employee_id)) continue;
    parts.push({ date: a.pay_date, emp: a.employee_id, group: groupOf(a.employee_id, null), pay: 0, regular: 0, overtime: 0, extra: Number(a.amount) || 0, worked: false });
  }

  // How much one part adds to the metric (people and days are counted as sets instead).
  const amount = (p: Part) => metric === "pay" ? p.pay + p.extra : metric === "extra" ? p.extra : metric === "overtime" ? p.overtime : p.regular + p.overtime;

  // The series: one total, regular + overtime, or one per group (by employee: the top few, then everyone else).
  let series: Series[];
  let seriesOf: (p: Part) => string[];
  const OTHERS = "__others";
  if (metric === "reg_ot") {
    series = [{ key: "regular", label: "Regular" }, { key: "overtime", label: "Overtime" }];
    seriesOf = () => ["regular", "overtime"];
  } else if (splitBy === "none") {
    series = [{ key: "total", label: METRICS[metric].label }];
    seriesOf = () => ["total"];
  } else {
    const weight = new Map<string, number>();
    const daysOf = new Map<string, Set<string>>();
    for (const p of parts) {
      weight.set(p.group, (weight.get(p.group) ?? 0) + amount(p));
      if (p.worked) { const s = daysOf.get(p.group) ?? new Set(); s.add(`${p.emp} ${p.date}`); daysOf.set(p.group, s); }
    }
    // Biggest first; counts rank by days worked, since they don't add up.
    const rank = (g: string) => (unit === "count" || metric === "per_hour" ? daysOf.get(g)?.size ?? 0 : weight.get(g) ?? 0);
    const groups = [...new Set(parts.map((p) => p.group))].sort((a, b) => rank(b) - rank(a) || a.localeCompare(b));
    const named = splitBy === "employee" && groups.length > TOP_PEOPLE + 1 ? groups.slice(0, TOP_PEOPLE) : groups;
    const label = (g: string) => (splitBy === "employee" ? (emps.get(g) ? `${emps.get(g)!.first_name} ${emps.get(g)!.last_name}` : "Unknown") : g);
    series = named.map((g) => ({ key: g, label: label(g) }));
    if (named.length < groups.length) series.push({ key: OTHERS, label: "Everyone else" });
    const keep = new Set(named);
    seriesOf = (p) => [keep.has(p.group) ? p.group : OTHERS];
  }

  const buckets = bucketsBetween(from, to, groupBy);
  const bi = new Map(buckets.map((b, i) => [b.key, i]));
  const si = new Map(series.map((s, i) => [s.key, i]));
  const sums = buckets.map(() => series.map(() => 0));
  const hours = buckets.map(() => series.map(() => 0));
  const sets = buckets.map(() => series.map(() => new Set<string>()));
  const totalSums = series.map(() => 0), totalHours = series.map(() => 0), totalSets = series.map(() => new Set<string>());
  for (const p of parts) {
    const b = bi.get(bucketOf(p.date, groupBy, from, to).key)!;
    for (const key of seriesOf(p)) {
      const s = si.get(key)!;
      const v = metric === "reg_ot" ? (key === "regular" ? p.regular : p.overtime) : metric === "per_hour" ? p.pay : amount(p);
      sums[b]![s]! += v; totalSums[s]! += v;
      if (metric === "per_hour") { hours[b]![s]! += p.regular + p.overtime; totalHours[s]! += p.regular + p.overtime; }
      if (p.worked && (metric === "people" || metric === "days")) {
        const k = metric === "people" ? p.emp : `${p.emp} ${p.date}`;
        sets[b]![s]!.add(k); totalSets[s]!.add(k);
      }
    }
  }
  const value = (sum: number, h: number, set: Set<string>) => (metric === "people" || metric === "days" ? set.size : metric === "per_hour" ? (h > 0 ? sum / h : 0) : sum);
  const values = buckets.map((_, b) => series.map((_, s) => value(sums[b]![s]!, hours[b]![s]!, sets[b]![s]!)));
  const seriesTotals = series.map((_, s) => value(totalSums[s]!, totalHours[s]!, totalSets[s]!));
  const all = new Set<string>();
  for (const s of totalSets) for (const k of s) all.add(k);
  const total = metric === "people" || metric === "days" ? all.size
    : metric === "per_hour" ? (totalHours.reduce((a, b) => a + b, 0) > 0 ? totalSums.reduce((a, b) => a + b, 0) / totalHours.reduce((a, b) => a + b, 0) : 0)
    : totalSums.reduce((a, b) => a + b, 0);
  return { buckets, series, values, seriesTotals, total, unit };
}

/** Ready-made ranges for reports, worked out from `today` each time. Whole calendar months, so monthly bars are complete. */
export const REPORT_RANGES = {
  this_month: "This month", last_month: "Last month", last_3_months: "Last 3 months", last_6_months: "Last 6 months",
  last_12_months: "Last 12 months", this_year: "This year", last_year: "Last year", last_12_weeks: "Last 12 weeks",
} as const;
export type ReportRange = keyof typeof REPORT_RANGES;

export function reportRange(key: ReportRange, today: string): { from: string; to: string } {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const monthStart = (back: number) => isoDate(new Date(y, m - 1 - back, 1));
  const thisMonthEnd = monthEnd(`${today.slice(0, 7)}-01`);
  switch (key) {
    case "this_month": return { from: monthStart(0), to: thisMonthEnd };
    case "last_month": return { from: monthStart(1), to: isoDate(new Date(y, m - 1, 0)) };
    case "last_3_months": return { from: monthStart(2), to: thisMonthEnd };
    case "last_6_months": return { from: monthStart(5), to: thisMonthEnd };
    case "last_12_months": return { from: monthStart(11), to: thisMonthEnd };
    case "this_year": return { from: `${y}-01-01`, to: `${y}-12-31` };
    case "last_year": return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    case "last_12_weeks": { const end = addDays(weekStart(today), 6); return { from: addDays(weekStart(today), -77), to: end }; }
  }
}

/**
 * The same dates a year earlier, for "compared with the same time last year". A range ending on a month's last day
 * ends on that month's last day a year earlier too, so February 2028 (29 days) compares with all of February 2027.
 */
export function sameTimeLastYear(from: string, to: string) {
  const back = (iso: string) => {
    const y = Number(iso.slice(0, 4)) - 1, md = iso.slice(5);
    return md === "02-29" ? `${y}-02-28` : `${y}-${md}`;
  };
  const end = to === monthEnd(`${to.slice(0, 7)}-01`) ? monthEnd(`${back(to).slice(0, 7)}-01`) : back(to);
  return { from: back(from), to: end };
}

/** One line of a comparison: this period's nth day/week/month next to the other period's nth. */
export type CompareRow = { now: Bucket | null; then: Bucket | null; a: number | null; b: number | null };

/**
 * Two unsplit reports side by side, bucket by bucket in order (1st week with 1st week…); "regular vs overtime" adds
 * its two series up to hours. The periods can differ in length (31 days against 30), so the shorter one leaves gaps
 * (null) rather than zeros.
 */
export function compareReports(now: Report, then: Report): CompareRow[] {
  const sum = (r: Report, i: number) => r.values[i]!.reduce((x, y) => x + y, 0);
  return Array.from({ length: Math.max(now.buckets.length, then.buckets.length) }, (_, i) => ({
    now: now.buckets[i] ?? null, then: then.buckets[i] ?? null,
    a: i < now.buckets.length ? sum(now, i) : null, b: i < then.buckets.length ? sum(then, i) : null,
  }));
}

/** A range written out for titles: "Sep 1 – Nov 30, 2026", or with both years when they differ. */
export function rangeLabel(from: string, to: string) {
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  if (from === to) return fmt(from, { month: "short", day: "numeric", year: "numeric" });
  return `${fmt(from, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })} – ${fmt(to, { month: "short", day: "numeric", year: "numeric" })}`;
}
