import { describe, expect, it } from "vitest";
import { planCopy, type CopyRequest, type CopySource } from "./copy-week";

const clock = (employee_id: string, work_date: string, clock_in = "09:00:00", clock_out = "17:00:00"): CopySource =>
  ({ employee_id, work_date, entry_mode: "clock", clock_in, clock_out, lunch_minutes: 30, hours: 7.5, shift_id: null, note: null });
const daily = (employee_id: string, work_date: string, hours: number): CopySource =>
  ({ employee_id, work_date, entry_mode: "hours", clock_in: null, clock_out: null, lunch_minutes: 0, hours, shift_id: "night", note: "cover" });

// Mon 29 Dec 2025 … Sun 4 Jan 2026: crosses a month and a year.
const week = [clock("a", "2025-12-29"), clock("a", "2025-12-31"), daily("b", "2026-01-03", 6), clock("b", "2026-01-04")];
const base: CopyRequest = { records: week, from: "2025-12-29", to: "2026-01-05", weeks: 1, days: [0, 1, 2, 3, 4, 5, 6], employeeIds: ["a", "b"], lockedThrough: null, existing: [] };

describe("copying a week", () => {
  it("moves each record by whole weeks, keeping its weekday, times and shift", () => {
    const { add, duplicates, locked } = planCopy(base);
    expect(add.map((r) => `${r.employee_id} ${r.work_date}`)).toEqual(["a 2026-01-05", "a 2026-01-07", "b 2026-01-10", "b 2026-01-11"]);
    expect(add[0]).toEqual({ employee_id: "a", work_date: "2026-01-05", entry_mode: "clock", clock_in: "09:00:00", clock_out: "17:00:00", lunch_minutes: 30, shift_id: null, note: null });
    expect(add[2]).toEqual({ employee_id: "b", work_date: "2026-01-10", entry_mode: "hours", hours: 6, shift_id: "night", note: "cover" });
    expect([duplicates, locked]).toEqual([0, 0]);
  });

  it("never carries over pay set by hand, the lock or its saved pay", () => {
    const withPay = { ...clock("a", "2025-12-29"), pay_override: 200, unlocked: true, frozen_pay: { pay: 1 }, id: "x" } as CopySource;
    const [r] = planCopy({ ...base, records: [withPay] }).add;
    expect(r).not.toHaveProperty("pay_override");
    expect(r).not.toHaveProperty("unlocked");
    expect(r).not.toHaveProperty("frozen_pay");
    expect(r).not.toHaveProperty("id");
  });

  it("repeats for several weeks", () => {
    const dates = planCopy({ ...base, weeks: 3, employeeIds: ["a"], days: [0] }).add.map((r) => r.work_date);
    expect(dates).toEqual(["2026-01-05", "2026-01-12", "2026-01-19"]);
  });

  it("copies backwards too", () => {
    expect(planCopy({ ...base, to: "2025-12-22", employeeIds: ["a"], days: [0] }).add.map((r) => r.work_date)).toEqual(["2025-12-22"]);
  });

  it("leaves out unticked days, people not picked, and records outside the week", () => {
    const add = planCopy({ ...base, records: [...week, clock("a", "2026-01-05")], days: [0, 6], employeeIds: ["b"] }).add;
    expect(add.map((r) => `${r.employee_id} ${r.work_date}`)).toEqual(["b 2026-01-11"]);
  });

  it("skips shifts already there, so copying twice adds nothing, but keeps different ones that day", () => {
    const first = planCopy(base);
    const again = planCopy({ ...base, existing: first.add.map((r) => ({ ...r, clock_in: r.clock_in ?? null, clock_out: r.clock_out ?? null, hours: r.hours ?? 0, entry_mode: r.entry_mode! })) });
    expect(again.add).toEqual([]);
    expect(again.duplicates).toBe(4);
    const other = planCopy({ ...base, existing: [{ employee_id: "a", work_date: "2026-01-05", entry_mode: "clock", clock_in: "22:00:00", clock_out: "06:00:00", hours: 8 }] });
    expect(other.add).toHaveLength(4);
  });

  it("leaves out days locked as paid", () => {
    const p = planCopy({ ...base, lockedThrough: "2026-01-07" });
    expect(p.add.map((r) => r.work_date)).toEqual(["2026-01-10", "2026-01-11"]);
    expect(p.locked).toBe(2);
  });

  it("refuses weeks that don't start on the same weekday", () => {
    expect(() => planCopy({ ...base, to: "2026-01-06" })).toThrow(/same weekday/);
  });
});
