import { describe, expect, it } from "vitest";
import type { Employee, Shift, TimeRecord } from "@/lib/payroll";
import { checkRecords, DEFAULT_LIMITS, isNightShift, validLimits, type CheckInput } from "./record-checks";

const shifts = [
  { id: "day", name: "Day", multiplier: 1, default_clock_in: "09:00:00", default_clock_out: "17:00:00" },
  { id: "night", name: "Night", multiplier: 1, default_clock_in: null, default_clock_out: null },
] as Shift[];
const emp = (id: string, more: Partial<Employee> = {}) =>
  ({ id, first_name: id, last_name: "X", employee_code: id, hourly_rate: 20, active: true, hire_date: null, shift_id: "day", ...more }) as Employee;
let n = 0;
// Hours are worked out as the database does (compute_record_hours): an end before the start is the next morning.
const clock = (employee_id: string, work_date: string, clock_in: string, clock_out: string, lunch_minutes = 30, more: Partial<TimeRecord> = {}) => {
  const [a, b] = [clock_in, clock_out].map((t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)));
  const hours = ((b! < a! ? b! + 1440 : b!) - a! - lunch_minutes) / 60;
  return { id: `r${++n}`, employee_id, work_date, entry_mode: "clock", clock_in: `${clock_in}:00`, clock_out: `${clock_out}:00`, lunch_minutes, hours, pay_override: null, shift_id: null, ...more } as TimeRecord;
};
const daily = (employee_id: string, work_date: string, hours: number) =>
  ({ id: `r${++n}`, employee_id, work_date, entry_mode: "hours", clock_in: null, clock_out: null, lunch_minutes: 0, hours, pay_override: null, shift_id: null }) as TimeRecord;
const run = (records: TimeRecord[], more: Partial<CheckInput> = {}) =>
  checkRecords({ records, employees: [emp("a"), emp("b")], shifts, limits: DEFAULT_LIMITS, ...more });
const kinds = (records: TimeRecord[], more: Partial<CheckInput> = {}) => run(records, more).map((w) => w.kind);

describe("checking records before paying them", () => {
  it("finds nothing odd in an ordinary week", () => {
    expect(run([clock("a", "2026-11-02", "09:00", "17:30"), clock("a", "2026-11-03", "09:00", "17:30"), daily("b", "2026-11-02", 8)])).toEqual([]);
  });

  it("flags a very long day, adding up all of the day's records", () => {
    expect(kinds([clock("a", "2026-11-02", "06:00", "20:00")])).toEqual(["long-day"]);
    const split = run([clock("a", "2026-11-02", "06:00", "13:30"), clock("a", "2026-11-02", "14:00", "21:30")]);
    expect(split.map((w) => [w.kind, w.recordIds.length, w.detail])).toEqual([["long-day", 2, "14 h worked in one day (2 records), over 12 h"]]);
    expect(kinds([daily("a", "2026-11-02", 13)])).toEqual(["long-day"]);
  });

  it("flags a long shift with no break, but not hours-only records, which have no break to check", () => {
    expect(kinds([clock("a", "2026-11-02", "09:00", "16:00", 0)])).toEqual(["no-break"]);
    expect(kinds([clock("a", "2026-11-02", "09:00", "14:00", 0)])).toEqual([]);
    expect(kinds([daily("a", "2026-11-02", 8)])).toEqual([]);
  });

  it("flags very short shifts, a long break, and overlapping times", () => {
    expect(kinds([clock("a", "2026-11-02", "09:00", "09:00", 0)])).toEqual(["short"]);
    expect(kinds([clock("a", "2026-11-02", "08:00", "18:00", 180)])).toEqual(["long-break"]);
    const both = run([clock("a", "2026-11-02", "09:00", "13:00"), clock("a", "2026-11-02", "12:00", "16:00")]);
    expect(both.map((w) => [w.kind, w.detail])).toEqual([["overlap", "09:00–13:00 and 12:00–16:00 overlap: entered twice?"]]);
    expect(kinds([clock("a", "2026-11-02", "06:00", "10:00", 0), clock("a", "2026-11-02", "10:00", "14:00", 0)])).toEqual([]);
  });

  it("flags times past midnight on a day shift (swapped?), not on a night shift", () => {
    expect(kinds([clock("a", "2026-11-02", "17:00", "01:00")])).toEqual(["past-midnight"]);
    expect(kinds([clock("a", "2026-11-02", "22:00", "06:00", 30, { shift_id: "night" })])).toEqual([]);
    expect(kinds([clock("a", "2026-11-02", "22:00", "06:00")], { employees: [emp("a", { shift_id: "night" })] })).toEqual([]);
  });

  it("flags days that pay nothing: a rate of 0, or pay set to 0 by hand", () => {
    expect(kinds([clock("a", "2026-11-02", "09:00", "17:00")], { employees: [emp("a", { hourly_rate: 0 })] })).toEqual(["zero-rate"]);
    // The rate in force that day counts, not today's.
    const rates = new Map([["a", [{ effective_from: "2026-01-01", hourly_rate: 0 }, { effective_from: "2026-11-03", hourly_rate: 20 }]]]);
    expect(run([clock("a", "2026-11-02", "09:00", "17:00"), clock("a", "2026-11-03", "09:00", "17:00")], { rates }).map((w) => [w.kind, w.date])).toEqual([["zero-rate", "2026-11-02"]]);
    expect(kinds([clock("a", "2026-11-02", "09:00", "17:00", 30, { pay_override: 0 })])).toEqual(["zero-pay"]);
    expect(kinds([clock("a", "2026-11-02", "09:00", "17:00", 30, { pay_override: 0 })], { employees: [emp("a", { hourly_rate: 0 })] })).toEqual(["zero-pay"]);
  });

  it("flags records for people who've resigned, or from before their hire date, once per person", () => {
    const rs = [clock("a", "2026-11-02", "09:00", "17:00"), clock("a", "2026-11-03", "09:00", "17:00")];
    expect(run(rs, { employees: [emp("a", { active: false })] }).map((w) => [w.kind, w.recordIds.length])).toEqual([["resigned", 2]]);
    expect(run(rs, { employees: [emp("a", { hire_date: "2026-11-03" })] }).map((w) => [w.kind, w.date, w.recordIds.length])).toEqual([["before-hire", "2026-11-02", 1]]);
  });

  it("gives a warning a new key when its records change, so 'it's fine' doesn't cover the change", () => {
    const r = clock("a", "2026-11-02", "06:00", "20:00");
    const [before] = run([r]);
    expect(run([r])[0]!.key).toBe(before!.key);
    expect(run([{ ...r, clock_out: "21:00:00", hours: 14.5 }])[0]!.key).not.toBe(before!.key);
  });

  it("uses the limits given, and falls back to defaults for unusable ones", () => {
    expect(kinds([clock("a", "2026-11-02", "06:00", "20:00")], { limits: { ...DEFAULT_LIMITS, longDay: 14 } })).toEqual([]);
    expect(validLimits({ longDay: 10, noBreakAfter: "x", shortShift: -1 })).toEqual({ ...DEFAULT_LIMITS, longDay: 10 });
    expect(validLimits(null)).toEqual(DEFAULT_LIMITS);
  });

  it("knows a night shift by its usual hours, or by its name when it has none", () => {
    expect(isNightShift(shifts[0])).toBe(false);
    expect(isNightShift(shifts[1])).toBe(true);
    expect(isNightShift({ name: "Late", default_clock_in: "18:00:00", default_clock_out: "02:00:00" })).toBe(true);
  });
});
