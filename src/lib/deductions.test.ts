import { describe, expect, it } from "vitest";
import { deductionsFor, planBulkDeduction, weeksTouching, type DeductionRule } from "./deductions";

const d = (over: Partial<DeductionRule>): DeductionRule => ({ id: over.name ?? "x", name: "x", kind: "fixed", amount: 0, repeats: "period", starts_on: null, ends_on: null, ...over });
// Mon 2 Nov – Sun 15 Nov 2026: two whole weeks.
const FROM = "2026-11-02", TO = "2026-11-15";

describe("deductions", () => {
  it("takes a percent of gross and a fixed amount once per pay period, leaving net pay", () => {
    const r = deductionsFor([d({ name: "Tax", kind: "percent", amount: 10 }), d({ name: "Health", amount: 50 })], 1234.56, FROM, TO);
    expect(r.lines.map((l) => [l.name, l.amount])).toEqual([["Tax", 123.46], ["Health", 50]]);
    expect(r.total).toBe(173.46);
    expect(r.net).toBe(1061.1);
  });

  it("takes a weekly amount for each Mon–Sun week the period touches, partial weeks included", () => {
    expect(weeksTouching(FROM, TO)).toBe(2);
    expect(weeksTouching("2026-11-04", "2026-11-10")).toBe(2); // Wed to the next Tue
    expect(weeksTouching("2026-11-02", "2026-11-02")).toBe(1);
    const r = deductionsFor([d({ name: "Loan", amount: 25, repeats: "week" })], 900, FROM, TO);
    expect(r.lines[0]).toMatchObject({ amount: 50, detail: "25.00 × 2 weeks" });
  });

  it("only counts the weeks it's active in", () => {
    const r = deductionsFor([d({ name: "Loan", amount: 25, repeats: "week", starts_on: "2026-11-09" })], 900, FROM, TO);
    expect(r.lines[0]!.amount).toBe(25);
  });

  it("takes a one-off only in the period holding its date", () => {
    const once = d({ name: "Uniform", amount: 40, repeats: "once", starts_on: "2026-11-10" });
    expect(deductionsFor([once], 500, FROM, TO).total).toBe(40);
    expect(deductionsFor([once], 500, "2026-11-16", "2026-11-29").total).toBe(0);
    expect(deductionsFor([once], 500, "2026-10-19", "2026-11-01").total).toBe(0);
  });

  it("skips deductions that haven't started or have ended", () => {
    const rules = [d({ name: "Old", amount: 10, ends_on: "2026-11-01" }), d({ name: "New", amount: 10, starts_on: "2026-11-16" }), d({ name: "Now", amount: 10, ends_on: "2026-11-02" })];
    expect(deductionsFor(rules, 500, FROM, TO).lines.map((l) => l.name)).toEqual(["Now"]);
  });

  it("can leave net pay below zero, never hiding it", () => {
    expect(deductionsFor([d({ name: "Advance", amount: 300 })], 120, FROM, TO).net).toBe(-180);
  });
});

describe("adding a deduction to several people", () => {
  const existing = new Map([["ann", [{ name: "Health" }, { name: "tax " }]], ["bob", []]]);
  const row = { name: "Tax", kind: "percent", amount: 10 };

  it("gives each person a row after their own deductions, and says who already has one of that name", () => {
    const plan = planBulkDeduction(["ann", "bob", "cy"], existing, row, false);
    expect(plan.already).toEqual(["ann"]);
    expect(plan.rows).toEqual([
      { ...row, employee_id: "ann", sort_order: 2 },
      { ...row, employee_id: "bob", sort_order: 0 },
      { ...row, employee_id: "cy", sort_order: 0 },
    ]);
  });

  it("can leave out the people who already have it", () => {
    expect(planBulkDeduction(["ann", "bob"], existing, row, true).rows.map((r) => r.employee_id)).toEqual(["bob"]);
  });
});
