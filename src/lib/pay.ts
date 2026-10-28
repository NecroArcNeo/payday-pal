// How a pay period's hours turn into pay.
//
// * Saturday and Sunday hours are always overtime (unless the weekend rule is
//   switched off in payroll settings, in which case they count like weekdays).
// * Monday–Friday hours become overtime once the week's weekday hours pass the
//   threshold (40 by default). Weeks run Monday–Sunday; hours are counted in
//   date order, so the hours past the threshold are the later ones.
// * Each day is worked on a shift: the one set on the record, else the
//   employee's own. The rate is the one in force that day (src/lib/pay-rates.ts),
//   so a raise doesn't change what earlier days paid. The shift multiplier scales the rate for regular hours
//   only. Overtime is paid at rate × overtime multiplier, never stacked with
//   the shift (a ×1.3 night worker's overtime pays ×1.5, not ×1.95).
// * Salaried employees are paid a full week — threshold hours (40) × rate ×
//   shift — for every week they have time records, however many hours that is,
//   and never overtime. The week's pay is shared across its days by hours,
//   each day's share at that day's shift.
// * A day with manual pay is paid exactly that amount. Its hours still count
//   toward the week, so they can push later days into overtime; for salaried
//   employees it replaces that day's share of the week.

import { rateOn, type RateEntry } from "@/lib/pay-rates";

export type PayShift = { id: string; multiplier: number | string; name: string };
export type PayRules = { threshold: number; otMultiplier: number; weekendOvertime: boolean };
export type PayType = "hourly" | "salary";
export const PAY_TYPES: { value: PayType; label: string }[] = [{ value: "hourly", label: "Hourly" }, { value: "salary", label: "Salary" }];

export type PayRecord = {
  id: string;
  work_date: string;
  hours: number | string;
  clock_in?: string | null;
  created_at?: string | null;
  pay_override?: number | string | null;
  /** The shift this day was worked on, when it differs from the employee's. */
  shift_id?: string | null;
};

/**
 * `rate` is the employee's current rate; `rates`, their rate history, sets each day's rate (without it, every day pays `rate`).
 * `shiftMultiplier` is the employee's own shift; `shifts` lets a record's own shift_id override it.
 */
export type PayOptions = { rate: number; rates?: RateEntry[] | undefined; shiftMultiplier: number; rules: PayRules; payType?: string | null | undefined; shifts?: PayShift[] | undefined };

/** One record's share of pay. `regPay`/`otPay` are 0 on a manual day; `pay` is what the day pays. */
export type PayLine = {
  id: string; regular: number; overtime: number; weekend: boolean; manual: boolean; salary: boolean;
  regPay: number; otPay: number; pay: number;
};

export type EmployeePay = {
  regular: number; overtime: number; weekendHours: number; days: number;
  regPay: number; otPay: number; manualPay: number; manualDays: number;
  /** Pay from hours and manual days, before extra-pay entries. */
  total: number;
  lines: PayLine[];
};

/** Saturday or Sunday. */
export const isWeekend = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
};

/** Monday of the week containing an ISO date. */
export function weekStart(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Sunday of the week containing an ISO date. */
export function weekEnd(date: string) {
  const d = new Date(`${weekStart(date)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

const chronological = (a: PayRecord, b: PayRecord) =>
  a.work_date.localeCompare(b.work_date) || (a.clock_in ?? "").localeCompare(b.clock_in ?? "")
  || (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id);

/** Splits each record's hours into regular and overtime. Pass all of one employee's records for the weeks involved. */
export function splitWeekly(records: PayRecord[], rules: PayRules): Map<string, { regular: number; overtime: number; weekend: boolean }> {
  const out = new Map<string, { regular: number; overtime: number; weekend: boolean }>();
  const weekdayHours = new Map<string, number>();
  for (const r of [...records].sort(chronological)) {
    const h = Math.max(0, Number(r.hours) || 0);
    const weekend = isWeekend(r.work_date);
    if (weekend && rules.weekendOvertime) { out.set(r.id, { regular: 0, overtime: h, weekend }); continue; }
    const wk = weekStart(r.work_date);
    const before = weekdayHours.get(wk) ?? 0;
    const regular = Math.min(h, Math.max(0, rules.threshold - before));
    weekdayHours.set(wk, before + h);
    out.set(r.id, { regular, overtime: h - regular, weekend });
  }
  return out;
}

const isManual = (r: PayRecord) => r.pay_override !== null && r.pay_override !== undefined && r.pay_override !== "";

/** Each record's hours and pay. Pass all of one employee's records for the weeks involved. */
export function recordPay(records: PayRecord[], opts: PayOptions): Map<string, PayLine> {
  const multiplierOf = (r: PayRecord) => {
    const own = r.shift_id ? opts.shifts?.find((x) => x.id === r.shift_id) : undefined;
    return own ? Number(own.multiplier) : opts.shiftMultiplier;
  };
  const rateFor = (r: PayRecord) => rateOn(opts.rates, opts.rate, r.work_date);
  const out = new Map<string, PayLine>();
  const sorted = [...records].sort(chronological);
  const hoursOf = (r: PayRecord) => Math.max(0, Number(r.hours) || 0);

  if (opts.payType === "salary") {
    const weeks = new Map<string, PayRecord[]>();
    for (const r of sorted) weeks.set(weekStart(r.work_date), [...(weeks.get(weekStart(r.work_date)) ?? []), r]);
    for (const recs of weeks.values()) {
      const paid = recs.filter((r) => !isManual(r));
      const hours = paid.reduce((s, r) => s + hoursOf(r), 0);
      for (const r of recs) {
        const manual = isManual(r);
        const share = manual ? 0 : hours > 0 ? hoursOf(r) / hours : 1 / paid.length;
        // A raise mid-week pays each day's share of the week at that day's rate.
        const regPay = rateFor(r) * opts.rules.threshold * share * multiplierOf(r);
        out.set(r.id, { id: r.id, regular: hoursOf(r), overtime: 0, weekend: isWeekend(r.work_date), manual, salary: true, regPay, otPay: 0, pay: manual ? Number(r.pay_override) : regPay });
      }
    }
    return out;
  }

  const split = splitWeekly(records, opts.rules);
  for (const r of sorted) {
    const s = split.get(r.id)!;
    const manual = isManual(r);
    const rate = rateFor(r);
    const regPay = manual ? 0 : s.regular * rate * multiplierOf(r);
    const otPay = manual ? 0 : s.overtime * rate * opts.rules.otMultiplier;
    out.set(r.id, { id: r.id, ...s, manual, salary: false, regPay, otPay, pay: manual ? Number(r.pay_override) : regPay + otPay });
  }
  return out;
}

/**
 * One employee's pay for [from, to]. `records` may include days outside the
 * period from the same weeks: they count toward weekly overtime but aren't paid here.
 */
export function employeePay(records: PayRecord[], opts: PayOptions & { from: string; to: string }): EmployeePay {
  const lines = recordPay(records, opts);
  const res: EmployeePay = { regular: 0, overtime: 0, weekendHours: 0, days: 0, regPay: 0, otPay: 0, manualPay: 0, manualDays: 0, total: 0, lines: [] };
  const days = new Set<string>();
  for (const r of [...records].sort(chronological)) {
    if (r.work_date < opts.from || r.work_date > opts.to) continue;
    const l = lines.get(r.id)!;
    days.add(r.work_date);
    res.regular += l.regular;
    res.overtime += l.overtime;
    if (l.weekend) res.weekendHours += l.regular + l.overtime;
    if (l.manual) { res.manualPay += l.pay; res.manualDays++; }
    res.regPay += l.regPay;
    res.otPay += l.otPay;
    res.lines.push(l);
  }
  res.days = days.size;
  res.total = res.regPay + res.otPay + res.manualPay;
  return res;
}

type PayEmployee = { id: string; hourly_rate: number | string; shift_id?: string | null; pay_type?: string | null };

/** Pay for every record, across employees. Pass whole Mon–Sun weeks of records so overtime and salary are right, and each employee's rate history. */
export function payByRecord(records: (PayRecord & { employee_id: string })[], employees: PayEmployee[], shifts: PayShift[], rules: PayRules, rates?: Map<string, RateEntry[]>): Map<string, PayLine> {
  const byEmp = new Map<string, PayRecord[]>();
  for (const r of records) byEmp.set(r.employee_id, [...(byEmp.get(r.employee_id) ?? []), r]);
  const out = new Map<string, PayLine>();
  for (const e of employees) {
    const recs = byEmp.get(e.id);
    if (!recs) continue;
    const lines = recordPay(recs, { rate: Number(e.hourly_rate), rates: rates?.get(e.id), shiftMultiplier: shiftFor(e.shift_id, shifts).multiplier, rules, payType: e.pay_type, shifts });
    for (const [id, l] of lines) out.set(id, l);
  }
  return out;
}

/** The shift an employee is on: theirs, or the first shift when unset or deleted. Missing shifts pay ×1. */
export function shiftFor<S extends { id: string; multiplier: number | string; name: string }>(shiftId: string | null | undefined, shifts: S[]) {
  const s = shifts.find((x) => x.id === shiftId) ?? shifts[0];
  return { id: s?.id ?? null, name: s?.name ?? "Day", multiplier: s ? Number(s.multiplier) : 1 };
}

/** The shift a day was worked on: the record's own when set (and still existing), else the employee's. */
export function shiftForRecord<S extends PayShift>(recordShiftId: string | null | undefined, employeeShiftId: string | null | undefined, shifts: S[]) {
  const own = recordShiftId ? shifts.find((x) => x.id === recordShiftId) : undefined;
  return { ...shiftFor(own ? own.id : employeeShiftId, shifts), changed: !!own && own.id !== shiftFor(employeeShiftId, shifts).id };
}
