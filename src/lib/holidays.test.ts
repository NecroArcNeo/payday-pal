import { describe, expect, it } from "vitest";
import { copyToNextYear, isHolidayPay, planHolidayPay, sameDayNextYear } from "./holidays";

const xmas = { holiday_date: "2026-12-25", name: "Christmas", multiplier: 2, paid_hours: 8 };
const person = (id: string, more: Record<string, unknown> = {}) => ({ id, active: true, hire_date: null, pay_type: "hourly", hourly_rate: 20, ...more });
const base = { holiday: xmas, existing: [], lockedThrough: null, includeWorking: false };

describe("holiday pay", () => {
  it("pays everyone off that day their paid hours at their rate that day, with no hours", () => {
    const rates = new Map([["b", [{ effective_from: "0001-01-01", hourly_rate: 18 }, { effective_from: "2026-12-01", hourly_rate: 22.5 }]]]);
    const plan = planHolidayPay({ ...base, employees: [person("a"), person("b")], rates });
    expect(plan.add).toEqual([
      { employee_id: "a", work_date: "2026-12-25", entry_mode: "hours", hours: 0, pay_override: 160, note: "Public holiday: Christmas (8 h paid)" },
      { employee_id: "b", work_date: "2026-12-25", entry_mode: "hours", hours: 0, pay_override: 180, note: "Public holiday: Christmas (8 h paid)" },
    ]);
  });

  it("leaves out who works that day (unless asked), salaried, resigned or not yet hired people, and anyone with no rate", () => {
    const employees = [person("works"), person("salary", { pay_type: "salary" }), person("left", { active: false }), person("new", { hire_date: "2027-01-04" }), person("zero", { hourly_rate: 0 }), person("ok")];
    const existing = [{ employee_id: "works", work_date: "2026-12-25", hours: 6, pay_override: null, note: null }];
    const plan = planHolidayPay({ ...base, employees, existing });
    expect(plan.add.map((r) => r.employee_id)).toEqual(["ok"]);
    expect([plan.worked, plan.salaried, plan.notWorking, plan.noRate].map((l) => l.map((e) => e.id))).toEqual([["works"], ["salary"], ["left", "new"], ["zero"]]);
    expect(planHolidayPay({ ...base, employees, existing, includeWorking: true }).add.map((r) => r.employee_id)).toEqual(["works", "ok"]);
  });

  it("adds nothing twice, nothing on a locked day, and nothing when the holiday pays no hours off", () => {
    const first = planHolidayPay({ ...base, employees: [person("a")] });
    const again = planHolidayPay({ ...base, employees: [person("a")], existing: first.add });
    expect(again.add).toEqual([]);
    expect(again.already.map((e) => e.id)).toEqual(["a"]);
    expect(isHolidayPay(first.add[0]!)).toBe(true);
    const locked = planHolidayPay({ ...base, employees: [person("a")], lockedThrough: "2026-12-31" });
    expect([locked.locked, locked.add.length]).toEqual([true, 0]);
    expect(planHolidayPay({ ...base, holiday: { ...xmas, paid_hours: 0 }, employees: [person("a")] }).add).toEqual([]);
  });
});

describe("next year's holidays", () => {
  it("moves dates a year on, 29 February to the 28th", () => {
    expect(sameDayNextYear("2026-12-25")).toBe("2027-12-25");
    expect(sameDayNextYear("2028-02-29")).toBe("2029-02-28");
  });

  it("copies one year's holidays with their rules, leaving out dates already there", () => {
    const list = [xmas, { holiday_date: "2026-01-01", name: "New Year", multiplier: 1.5, paid_hours: 8 }, { holiday_date: "2027-01-01", name: "New Year", multiplier: 1.5, paid_hours: 8 }, { holiday_date: "2025-12-25", name: "Old", multiplier: 1, paid_hours: 0 }];
    expect(copyToNextYear(list, 2026)).toEqual([{ holiday_date: "2027-12-25", name: "Christmas", multiplier: 2, paid_hours: 8 }]);
  });
});
