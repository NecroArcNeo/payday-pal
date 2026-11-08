import { describe, expect, it } from "vitest";
import { describeWeek, planPatterns, readWeek, weekFromRecords, type PatternWeek } from "./patterns";

const nineToFive = { entry_mode: "clock" as const, clock_in: "09:00", clock_out: "17:00", lunch_minutes: 30 };
const weekdays: PatternWeek = [nineToFive, nineToFive, nineToFive, nineToFive, nineToFive, null, null];
const people = [{ id: "a", active: true, hire_date: null }, { id: "b", active: true, hire_date: null }];
// Mon 2026-11-09 … Sun 2026-11-15.
const base = { from: "2026-11-11", weeks: 1, employees: people, existing: [], lockedThrough: null };

describe("weekly patterns", () => {
  it("reads stored days safely: always 7, anything unreadable is a day off", () => {
    expect(readWeek(null)).toEqual([null, null, null, null, null, null, null]);
    const w = readWeek([{ entry_mode: "clock", clock_in: "09:00:00", clock_out: "17:00", lunch_minutes: 30 }, { entry_mode: "hours", hours: 4, shift_id: "night" }, { entry_mode: "clock", clock_in: "nine" }, "junk"]);
    expect(w[0]).toEqual({ ...nineToFive, shift_id: null });
    expect(w[1]).toEqual({ entry_mode: "hours", hours: 4, shift_id: "night" });
    expect(w.slice(2)).toEqual([null, null, null, null, null]);
  });

  it("describes a week in a line", () => {
    expect(describeWeek(weekdays)).toBe("Mon–Fri 09:00–17:00");
    expect(describeWeek([nineToFive, null, nineToFive, null, null, { entry_mode: "hours", hours: 4 }, null])).toBe("Mon 09:00–17:00, Wed 09:00–17:00, Sat 4 h");
    expect(describeWeek([null, null, null, null, null, null, null])).toBe("No days");
  });

  it("fills whole weeks from the Monday of the chosen day, for each person in the pattern", () => {
    const plan = planPatterns({ ...base, weeks: 2, patterns: [{ days: weekdays, employee_ids: ["a"] }, { days: [null, null, null, null, null, { entry_mode: "hours", hours: 5, shift_id: "wk" }, null], employee_ids: ["b"] }] });
    expect(plan.add.filter((r) => r.employee_id === "a").map((r) => r.work_date)).toEqual(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"]);
    expect(plan.add[0]).toEqual({ employee_id: "a", work_date: "2026-11-09", entry_mode: "clock", clock_in: "09:00", clock_out: "17:00", lunch_minutes: 30, shift_id: null });
    expect(plan.add.filter((r) => r.employee_id === "b")).toEqual([
      { employee_id: "b", work_date: "2026-11-14", entry_mode: "hours", hours: 5, shift_id: "wk" },
      { employee_id: "b", work_date: "2026-11-21", entry_mode: "hours", hours: 5, shift_id: "wk" },
    ]);
  });

  it("skips shifts already there (so filling twice adds nothing), locked days and holidays", () => {
    const first = planPatterns({ ...base, patterns: [{ days: weekdays, employee_ids: ["a"] }] });
    const again = planPatterns({ ...base, patterns: [{ days: weekdays, employee_ids: ["a"] }], existing: first.add.map((r) => ({ ...r, clock_in: `${r.clock_in}:00`, clock_out: `${r.clock_out}:00`, hours: 7.5 })) as never });
    expect([again.add.length, again.duplicates]).toEqual([0, 5]);
    const locked = planPatterns({ ...base, patterns: [{ days: weekdays, employee_ids: ["a"] }], lockedThrough: "2026-11-10", holidays: ["2026-11-11"] });
    expect(locked.add.map((r) => r.work_date)).toEqual(["2026-11-12", "2026-11-13"]);
    expect([locked.locked, locked.holidays]).toEqual([2, 1]);
  });

  it("leaves out resigned and deleted people, and days before someone was hired", () => {
    const employees = [{ id: "a", active: false }, { id: "new", active: true, hire_date: "2026-11-12" }];
    const plan = planPatterns({ ...base, employees, patterns: [{ days: weekdays, employee_ids: ["a", "gone", "new"] }] });
    expect(plan.add.map((r) => `${r.employee_id} ${r.work_date}`)).toEqual(["new 2026-11-12", "new 2026-11-13"]);
    expect(plan.leftOut).toBe(2 + 3);
  });

  it("makes a pattern from someone's week of records", () => {
    const recs = [
      { work_date: "2026-11-09", entry_mode: "clock", clock_in: "09:00:00", clock_out: "17:00:00", lunch_minutes: 30, shift_id: null },
      { work_date: "2026-11-14", entry_mode: "hours", hours: 4, shift_id: "wk" },
    ];
    expect(weekFromRecords(recs, "2026-11-09")).toEqual([{ ...nineToFive, shift_id: null }, null, null, null, null, { entry_mode: "hours", hours: 4, shift_id: "wk" }, null]);
  });
});
