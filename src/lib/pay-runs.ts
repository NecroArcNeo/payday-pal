import { roundDecimal } from "@/lib/db/codec";
import type { DeductionLine } from "@/lib/deductions";

// Pay runs (schema 13, when Settings → Features has them on): the saved record of a period paid. Recording one saves
// each person's figures exactly as the Payroll page shows them (one pay_run_lines row each, never edited afterwards)
// and locks the period's days as paid, so the records can't drift from what was paid. Pure helpers here; the Payroll
// page records them (RecordPayRun) and payslips read them back (year-to-date totals, the run's own deductions).

export type RunLine = {
  employee_id: string | null; employee_name: string; employee_code: string;
  hours: number; regular_hours: number; overtime_hours: number; extra_pay: number; gross: number;
  deductions: { name: string; amount: number }[]; deductions_total: number; net: number;
};
export type StoredRun = { id: string; period_from: string; period_to: string; paid_on: string; created_at: string; lines: RunLine[] };

const cents = (n: number) => roundDecimal(n, 2);

/** One person's line, from the figures the Payroll table shows for them. */
export function runLine(p: {
  employee: { id: string; first_name: string; last_name: string; employee_code: string };
  regular: number; overtime: number; extraPay: number; gross: number;
  deducted: { lines: DeductionLine[]; total: number; net: number } | null;
}): RunLine {
  return {
    employee_id: p.employee.id, employee_name: `${p.employee.first_name} ${p.employee.last_name}`.trim(), employee_code: p.employee.employee_code,
    hours: cents(p.regular + p.overtime), regular_hours: cents(p.regular), overtime_hours: cents(p.overtime), extra_pay: cents(p.extraPay), gross: cents(p.gross),
    deductions: (p.deducted?.lines ?? []).map((l) => ({ name: l.name, amount: l.amount })),
    deductions_total: cents(p.deducted?.total ?? 0), net: cents(p.deducted?.net ?? p.gross),
  };
}

/** The runs whose period shares a day with `from`–`to` (a period is only paid once). */
export const overlappingRuns = <R extends { period_from: string; period_to: string }>(runs: readonly R[], from: string, to: string) =>
  runs.filter((r) => r.period_from <= to && r.period_to >= from);

/** The run for exactly this period, if one was recorded. */
export const runFor = <R extends { period_from: string; period_to: string }>(runs: readonly R[], from: string, to: string) =>
  runs.find((r) => r.period_from === from && r.period_to === to) ?? null;

/** Run totals: people paid, gross, deductions, net. */
export function runTotals(lines: readonly RunLine[]) {
  return {
    people: lines.length,
    gross: cents(lines.reduce((s, l) => s + Number(l.gross), 0)),
    deductions: cents(lines.reduce((s, l) => s + Number(l.deductions_total), 0)),
    net: cents(lines.reduce((s, l) => s + Number(l.net), 0)),
  };
}

const later = (a: StoredRun, b: StoredRun) => a.paid_on > b.paid_on || (a.paid_on === b.paid_on && a.created_at > b.created_at);

/**
 * An employee's year-to-date totals as of `run`: every run paid in the same calendar year, on or before it (by paid
 * date, then by when it was recorded), this one included.
 */
export function yearToDate(runs: readonly StoredRun[], employeeId: string, run: StoredRun) {
  const year = run.paid_on.slice(0, 4);
  const lines = runs
    .filter((r) => r.paid_on.slice(0, 4) === year && !later(r, run))
    .flatMap((r) => r.lines.filter((l) => l.employee_id === employeeId));
  return {
    gross: cents(lines.reduce((s, l) => s + Number(l.gross), 0)),
    deductions: cents(lines.reduce((s, l) => s + Number(l.deductions_total), 0)),
    net: cents(lines.reduce((s, l) => s + Number(l.net), 0)),
  };
}
