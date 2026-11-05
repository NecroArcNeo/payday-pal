import { employeePay, shiftFor, type PayRules } from "@/lib/pay";
import { rateOn, ratesBetween, type RateEntry } from "@/lib/pay-rates";
import type { Adjustment, Employee, FieldDef, Shift, TimeRecord } from "@/lib/payroll";
import { timesheetData, type Payslip, type TemplateCategory, type TimesheetSource } from "./timesheet-export";
import { deductionsFor, type DeductionRule } from "@/lib/deductions";
import { runFor, yearToDate, type StoredRun } from "@/lib/pay-runs";

/** The user's categories a timesheet may show: not ones filed under Personal, which stay on the profile. */
export const timesheetCategories = (defs: FieldDef[]): TemplateCategory[] =>
  defs.filter((d) => d.section !== "Personal").map((d) => ({ id: d.id, label: d.label, field_type: d.field_type }));

/**
 * One employee's timesheet for `from`–`to`, as the Timesheet page shows it. `records` may hold anyone's, but must
 * cover the whole Mon–Sun weeks around the period so weekly overtime is right; `adjustments` the period's.
 */
export function employeeTimesheet(emp: Employee, ctx: {
  from: string; to: string; today: string; records: TimeRecord[]; adjustments: Adjustment[];
  shifts: Shift[]; defs: FieldDef[]; rateHistory: RateEntry[] | undefined; rules: PayRules;
  /** The payslip part, when those features are on: this employee's deductions (null: deductions off), and every pay run (null: off). */
  deductions?: DeductionRule[] | null | undefined; runs?: StoredRun[] | null | undefined;
}): TimesheetSource {
  const { from, to, shifts, rateHistory } = ctx;
  const own = ctx.records.filter((r) => r.employee_id === emp.id);
  const shift = shiftFor(emp.shift_id, shifts);
  const pay = employeePay(own, { rate: Number(emp.hourly_rate), rates: rateHistory, shiftMultiplier: shift.multiplier, rules: ctx.rules, payType: emp.pay_type, shifts, from, to });
  const lines = new Map(pay.lines.map((l) => [l.id, l]));
  const shown = own
    .filter((r) => r.work_date >= from && r.work_date <= to)
    .sort((a, b) => a.work_date.localeCompare(b.work_date) || (a.clock_in ?? "").localeCompare(b.clock_in ?? ""));
  const extraPay = ctx.adjustments.filter((a) => a.employee_id === emp.id).reduce((s, a) => s + Number(a.amount), 0);
  const payslip = payslipFor(emp.id, from, to, pay.total + extraPay, ctx.deductions, ctx.runs);
  return (per, weeks, weekStart) => timesheetData({
    employee: emp, categories: timesheetCategories(ctx.defs), shiftName: shift.name, rates: ratesBetween(rateHistory, emp.hourly_rate, from, to),
    from, to, today: ctx.today, lines, extraPay, payslip,
    records: shown.map((r) => ({ ...r, shiftName: shiftFor(r.shift_id ?? emp.shift_id, shifts).name, rate: rateOn(rateHistory, emp.hourly_rate, r.work_date) })),
  }, per, weeks, weekStart);
}

/**
 * The payslip figures for one person's period. A pay run recorded for exactly this period is what was paid, so its
 * saved deductions and net are used (and its date and the year-to-date totals); otherwise the deductions are worked out
 * as the Payroll page does. Null when neither feature is on.
 */
export function payslipFor(employeeId: string, from: string, to: string, gross: number, deductions: DeductionRule[] | null | undefined, runs: StoredRun[] | null | undefined): Payslip | null {
  if (!deductions && !runs) return null;
  const run = runs ? runFor(runs, from, to) : null;
  const line = run?.lines.find((l) => l.employee_id === employeeId) ?? null;
  const worked = deductions ? deductionsFor(deductions, gross, from, to) : null;
  return {
    deductions: line ? line.deductions : worked ? worked.lines.map((l) => ({ name: l.name, amount: l.amount })) : null,
    deductionsTotal: line ? Number(line.deductions_total) : worked?.total ?? null,
    net: line ? Number(line.net) : worked?.net ?? null,
    paidOn: line ? run!.paid_on : null,
    ytd: line && runs ? yearToDate(runs, employeeId, run!) : null,
  };
}
