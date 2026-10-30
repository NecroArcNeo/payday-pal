import { employeePay, shiftFor, type PayRules } from "@/lib/pay";
import { rateOn, ratesBetween, type RateEntry } from "@/lib/pay-rates";
import type { Adjustment, Employee, FieldDef, Shift, TimeRecord } from "@/lib/payroll";
import { timesheetData, type TemplateCategory, type TimesheetSource } from "./timesheet-export";

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
  return (per, weeks, weekStart) => timesheetData({
    employee: emp, categories: timesheetCategories(ctx.defs), shiftName: shift.name, rates: ratesBetween(rateHistory, emp.hourly_rate, from, to),
    from, to, today: ctx.today, lines, extraPay,
    records: shown.map((r) => ({ ...r, shiftName: shiftFor(r.shift_id ?? emp.shift_id, shifts).name, rate: rateOn(rateHistory, emp.hourly_rate, r.work_date) })),
  }, per, weeks, weekStart);
}
