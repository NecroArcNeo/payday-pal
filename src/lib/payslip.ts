import { useDeductions, usePayRuns, usePayrollSettings, type PayRun } from "@/lib/payroll";
import type { DeductionRule } from "@/lib/deductions";
import type { RunLine, StoredRun } from "@/lib/pay-runs";

/** A stored pay run with its lines' deductions read from their JSON. */
export const storedRun = (r: PayRun): StoredRun => ({
  id: r.id, period_from: r.period_from, period_to: r.period_to, paid_on: r.paid_on, created_at: r.created_at,
  lines: r.lines.map((l): RunLine => ({
    ...l, hours: Number(l.hours), regular_hours: Number(l.regular_hours), overtime_hours: Number(l.overtime_hours), extra_pay: Number(l.extra_pay),
    gross: Number(l.gross), deductions_total: Number(l.deductions_total), net: Number(l.net),
    deductions: Array.isArray(l.deductions) ? (l.deductions as { name: string; amount: number }[]) : [],
  })),
});

/**
 * What timesheet exports need to be payslips, as far as Settings → Features has it on: each person's deductions
 * (null while deductions are off) and every pay run (null while pay runs are off). `employeeTimesheet` takes both.
 */
export function usePayslipData() {
  const { data: settings } = usePayrollSettings();
  const { data: deductions } = useDeductions();
  const { data: runs } = usePayRuns();
  return {
    deductionsOf: (employeeId: string): DeductionRule[] | null =>
      settings?.deductions_on ? (deductions?.get(employeeId) ?? []).map((d) => ({ ...d, amount: Number(d.amount) })) : null,
    runs: settings?.pay_runs_on ? (runs ?? []).map(storedRun) : null,
    deductionsOn: !!settings?.deductions_on,
    payRunsOn: !!settings?.pay_runs_on,
    /** Every deduction name in use, for the template editor's fields. */
    deductionNames: settings?.deductions_on ? [...new Set([...(deductions?.values() ?? [])].flat().map((d) => d.name))] : [],
  };
}
