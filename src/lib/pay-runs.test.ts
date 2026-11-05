import { describe, expect, it } from "vitest";
import { overlappingRuns, runFor, runLine, runTotals, yearToDate, type StoredRun } from "./pay-runs";

const line = (employee_id: string, gross: number, ded: number) => runLine({
  employee: { id: employee_id, first_name: "A", last_name: employee_id, employee_code: employee_id },
  regular: 40, overtime: 2.5, extraPay: 0, gross,
  deducted: { lines: [{ id: "t", name: "Tax", amount: ded, detail: "" }], total: ded, net: gross - ded },
});
const run = (id: string, from: string, to: string, paid_on: string, lines = [line("e1", 1000, 100)], created_at = `${paid_on}T12:00:00Z`): StoredRun =>
  ({ id, period_from: from, period_to: to, paid_on, created_at, lines });

describe("pay runs", () => {
  it("saves a person's line as the Payroll table shows it", () => {
    expect(line("e1", 812.555, 81.26)).toMatchObject({ employee_name: "A e1", hours: 42.5, regular_hours: 40, overtime_hours: 2.5, gross: 812.56, deductions: [{ name: "Tax", amount: 81.26 }], deductions_total: 81.26, net: 731.3 });
    expect(runLine({ employee: { id: "e2", first_name: "B", last_name: "C", employee_code: "E2" }, regular: 8, overtime: 0, extraPay: 50, gross: 210, deducted: null }))
      .toMatchObject({ deductions: [], deductions_total: 0, net: 210, extra_pay: 50 });
  });

  it("finds runs sharing a day with a period, and the one for exactly that period", () => {
    const runs = [run("a", "2026-11-02", "2026-11-08", "2026-11-09"), run("b", "2026-11-09", "2026-11-15", "2026-11-16")];
    expect(overlappingRuns(runs, "2026-11-08", "2026-11-09").map((r) => r.id)).toEqual(["a", "b"]);
    expect(overlappingRuns(runs, "2026-11-16", "2026-11-22")).toEqual([]);
    expect(runFor(runs, "2026-11-09", "2026-11-15")?.id).toBe("b");
    expect(runFor(runs, "2026-11-09", "2026-11-14")).toBeNull();
  });

  it("adds up a run", () => {
    expect(runTotals([line("e1", 1000, 100), line("e2", 500.5, 50.25)])).toEqual({ people: 2, gross: 1500.5, deductions: 150.25, net: 1350.25 });
  });

  it("totals the year to date up to and including a run, by paid date, not counting other years", () => {
    const runs = [
      run("dec", "2025-12-22", "2025-12-28", "2025-12-29"),
      run("jan", "2026-01-05", "2026-01-11", "2026-01-12"),
      run("feb", "2026-02-02", "2026-02-08", "2026-02-09", [line("e1", 900, 90), line("e2", 400, 40)]),
      run("mar", "2026-03-02", "2026-03-08", "2026-03-09"),
    ];
    expect(yearToDate(runs, "e1", runs[2]!)).toEqual({ gross: 1900, deductions: 190, net: 1710 });
    expect(yearToDate(runs, "e2", runs[2]!)).toEqual({ gross: 400, deductions: 40, net: 360 });
    expect(yearToDate(runs, "e1", runs[0]!)).toEqual({ gross: 1000, deductions: 100, net: 900 });
  });
});
