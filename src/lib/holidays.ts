// Public holidays (schema 14): the user lists them, each with its own pay rules. Hours worked on one pay its rate
// (pay.ts, via `rules.holidays`); people who are off can be given "holiday pay": a record for the day with no hours
// and a set pay of the holiday's paid hours × their rate that day, made by `planHolidayPay` (pure, tested). As an
// ordinary record it shows in Time records, payroll, payslips, reports and pay runs, can be edited or deleted, and is
// locked with its day; with no hours it never pushes anyone into overtime.
import { rateOn, type RateEntry } from "./pay-rates";

/** How holiday pay records' notes start, so a second "Add holiday pay" finds the ones already there. */
export const HOLIDAY_NOTE = "Public holiday";

export type HolidayRule = { holiday_date: string; name: string; multiplier: number | string; paid_hours: number | string };
type Person = { id: string; active?: boolean | null; hire_date?: string | null; pay_type?: string | null; hourly_rate: number | string };
type DayRecord = { employee_id: string; work_date: string; hours?: number | string | null; pay_override?: number | string | null; note?: string | null };

export type HolidayPayPlan<P extends Person> = {
  add: { employee_id: string; work_date: string; entry_mode: "hours"; hours: 0; pay_override: number; note: string }[];
  /** Left out, and why. */
  worked: P[]; already: P[]; salaried: P[]; notWorking: P[]; noRate: P[];
  /** The day is locked as paid: nothing can be added. */
  locked: boolean;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Who gets holiday pay for `holiday`, and how much: every active, hourly employee hired by that day, who doesn't work
 * that day (unless `includeWorking`) and hasn't got holiday pay for it already, at their rate that day.
 */
export function planHolidayPay<P extends Person>(input: {
  holiday: HolidayRule; employees: P[]; rates?: Map<string, RateEntry[]> | undefined; existing: DayRecord[];
  lockedThrough: string | null | undefined; includeWorking: boolean;
}): HolidayPayPlan<P> {
  const { holiday, employees, rates, existing, lockedThrough, includeWorking } = input;
  const date = holiday.holiday_date;
  const hours = Number(holiday.paid_hours) || 0;
  const plan: HolidayPayPlan<P> = { add: [], worked: [], already: [], salaried: [], notWorking: [], noRate: [], locked: !!lockedThrough && date <= lockedThrough };
  if (plan.locked || hours <= 0) return plan;
  const sameDay = existing.filter((r) => r.work_date === date);
  for (const e of employees) {
    if (e.active === false || (e.hire_date && e.hire_date > date)) { plan.notWorking.push(e); continue; }
    if (e.pay_type === "salary") { plan.salaried.push(e); continue; }
    const theirs = sameDay.filter((r) => r.employee_id === e.id);
    if (theirs.some(isHolidayPay)) { plan.already.push(e); continue; }
    if (theirs.length && !includeWorking) { plan.worked.push(e); continue; }
    const pay = round2(hours * rateOn(rates?.get(e.id), Number(e.hourly_rate), date));
    if (pay <= 0) { plan.noRate.push(e); continue; }
    plan.add.push({ employee_id: e.id, work_date: date, entry_mode: "hours", hours: 0, pay_override: pay, note: `${HOLIDAY_NOTE}: ${holiday.name} (${hours} h paid)` });
  }
  return plan;
}

/** A record "Add holiday pay" made: no hours, a set pay, and the holiday note. */
export const isHolidayPay = (r: DayRecord) => Number(r.hours ?? 0) === 0 && r.pay_override !== null && r.pay_override !== undefined && (r.note ?? "").startsWith(HOLIDAY_NOTE);

/** The same date a year later (29 February becomes the 28th). */
export function sameDayNextYear(date: string, years = 1): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y + years, m, 0)).getUTCDate();
  return `${y + years}-${String(m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/**
 * One year's holidays again in the next year, same day and month, with their rules (holidays that move, like Easter,
 * need their dates changing afterwards). Dates that already have a holiday are left out.
 */
export function copyToNextYear<H extends HolidayRule>(holidays: H[], year: number): HolidayRule[] {
  const taken = new Set(holidays.map((h) => h.holiday_date));
  return holidays
    .filter((h) => h.holiday_date.startsWith(`${year}-`))
    .map((h) => ({ holiday_date: sameDayNextYear(h.holiday_date), name: h.name, multiplier: h.multiplier, paid_hours: h.paid_hours }))
    .filter((h) => !taken.has(h.holiday_date));
}
