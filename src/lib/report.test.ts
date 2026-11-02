import { describe, expect, it } from "vitest";
import type { Employee, Shift, TimeRecord } from "@/lib/payroll";
import { addDays } from "@/lib/payroll";
import { autoGroup, bucketsBetween, buildReport, compareReports, previousRange, rangeLabel, reportRange, sameTimeLastYear, TOP_PEOPLE, type ReportInput } from "./report";

const shifts = [{ id: "day", name: "Day", multiplier: 1 }, { id: "night", name: "Night", multiplier: 1.2 }] as Shift[];
const emp = (id: string, more: Partial<Employee> = {}) =>
  ({ id, first_name: id.toUpperCase(), last_name: "Test", hourly_rate: 20, pay_type: "hourly", shift_id: "day", department: "Warehouse", active: true, ...more }) as Employee;
let n = 0;
const rec = (employee_id: string, work_date: string, hours: number, more: Partial<TimeRecord> = {}) =>
  ({ id: `r${++n}`, employee_id, work_date, entry_mode: "hours", hours, clock_in: null, clock_out: null, lunch_minutes: 0, pay_override: null, shift_id: null, frozen_pay: null, created_at: null, ...more }) as TimeRecord;
/** Mon–Fri of the week starting `monday`, `hours` each day. */
const week = (id: string, monday: string, hours = 9) => [0, 1, 2, 3, 4].map((i) => rec(id, addDays(monday, i), hours));
const rules = { threshold: 40, otMultiplier: 1.5, weekendOvertime: true };
const base = (records: TimeRecord[], more: Partial<ReportInput> = {}): ReportInput =>
  ({ records, employees: [emp("a"), emp("b", { department: "Office", shift_id: "night" })], shifts, rules, adjustments: [], from: "2026-10-01", to: "2026-12-31", groupBy: "month", metric: "pay", splitBy: "none", ...more });
const series = (r: ReturnType<typeof buildReport>, s = 0) => Object.fromEntries(r.buckets.map((b, i) => [b.key, Math.round(r.values[i]![s]! * 100) / 100]));

describe("reports", () => {
  it("adds up pay per month with the payroll rules: 45 h in a week pays 5 h overtime", () => {
    const r = buildReport(base(week("a", "2026-10-26")));
    // Mon 26 – Fri 30 Oct: 40 h × $20 + 5 h × $30.
    expect(series(r)).toEqual({ "2026-10-01": 950, "2026-11-01": 0, "2026-12-01": 0 });
    expect(r.total).toBe(950);
    expect(r.buckets.map((b) => b.label)).toEqual(["Oct 2026", "Nov 2026", "Dec 2026"]);
  });

  it("works out overtime over the whole week even when the week crosses into the next month or starts before the range", () => {
    const recs = week("a", "2026-11-30");
    // Monday 30 Nov is in November; the 5 overtime hours fall on Friday 4 Dec.
    const r = buildReport(base(recs, { metric: "overtime" }));
    expect(series(r)).toMatchObject({ "2026-11-01": 0, "2026-12-01": 5 });
    // A range starting 1 Dec still counts Monday's hours toward the week's overtime.
    const dec = buildReport(base(recs, { from: "2026-12-01", to: "2026-12-31", metric: "pay" }));
    expect(dec.total).toBe(31 * 20 + 5 * 30);
  });

  it("splits hours into regular and overtime", () => {
    const r = buildReport(base(week("a", "2026-10-26"), { metric: "reg_ot" }));
    expect(r.series.map((s) => s.key)).toEqual(["regular", "overtime"]);
    expect(r.seriesTotals).toEqual([40, 5]);
  });

  it("pays salary, manual pay and extra pay as the Payroll page does", () => {
    const employees = [emp("s", { pay_type: "salary", hourly_rate: 25 })];
    const r = buildReport(base([...week("s", "2026-10-26", 6), rec("s", "2026-11-02", 5, { pay_override: 100 })], {
      employees, adjustments: [{ employee_id: "s", pay_date: "2026-11-15", amount: 50 }],
    }));
    // Salary: 40 h × $25 for the week with records; a manual day pays exactly its amount; extra pay on its date.
    expect(series(r)).toMatchObject({ "2026-10-01": 1000, "2026-11-01": 150 });
    expect(buildReport(base([], { employees, adjustments: [{ employee_id: "s", pay_date: "2026-11-15", amount: 50 }], metric: "extra" })).total).toBe(50);
  });

  it("splits by department, by shift (a record's own shift first) and by employee", () => {
    const recs = [rec("a", "2026-10-05", 8), rec("b", "2026-10-05", 8), rec("a", "2026-10-06", 8, { shift_id: "night" })];
    const dept = buildReport(base(recs, { metric: "hours", splitBy: "department" }));
    expect(Object.fromEntries(dept.series.map((s, i) => [s.label, dept.seriesTotals[i]]))).toEqual({ Warehouse: 16, Office: 8 });
    const shift = buildReport(base(recs, { metric: "hours", splitBy: "shift" }));
    expect(Object.fromEntries(shift.series.map((s, i) => [s.label, shift.seriesTotals[i]]))).toEqual({ Night: 16, Day: 8 });
    const people = buildReport(base(recs, { metric: "days", splitBy: "employee" }));
    expect(people.series.map((s) => s.label)).toEqual(["A Test", "B Test"]);
    expect(people.seriesTotals).toEqual([2, 1]);
  });

  it("names the top people and adds up the rest as everyone else", () => {
    const ids = Array.from({ length: TOP_PEOPLE + 3 }, (_, i) => `p${i}`);
    const employees = ids.map((id) => emp(id));
    const recs = ids.map((id, i) => rec(id, "2026-10-05", i + 1));
    const r = buildReport(base(recs, { employees, metric: "hours", splitBy: "employee" }));
    expect(r.series).toHaveLength(TOP_PEOPLE + 1);
    expect(r.series[0]!.key).toBe(`p${TOP_PEOPLE + 2}`);
    expect(r.series.at(-1)!.label).toBe("Everyone else");
    expect(r.seriesTotals.at(-1)).toBe(1 + 2 + 3);
    expect(r.total).toBe(recs.reduce((s, x) => s + Number(x.hours), 0));
  });

  it("counts people and days as sets, and pay per hour as a ratio", () => {
    const recs = [rec("a", "2026-10-05", 4), rec("a", "2026-10-05", 4), rec("a", "2026-11-02", 8), rec("b", "2026-11-02", 8)];
    expect(buildReport(base(recs, { metric: "people" })).total).toBe(2);
    expect(series(buildReport(base(recs, { metric: "people" })))).toMatchObject({ "2026-10-01": 1, "2026-11-01": 2 });
    expect(buildReport(base(recs, { metric: "days" })).total).toBe(3);
    // b is on the Night shift (×1.2): (16 h × $20 + 8 h × $24) / 24 h.
    expect(buildReport(base(recs, { metric: "per_hour" })).total).toBeCloseTo((16 * 20 + 8 * 24) / 24);
  });

  it("can be about one person", () => {
    const recs = [rec("a", "2026-10-05", 8), rec("b", "2026-10-05", 6)];
    expect(buildReport(base(recs, { metric: "hours", employeeIds: ["b"] })).total).toBe(6);
  });

  it("lists every bucket in the range, empty ones too, cut to the range at both ends", () => {
    const weeks = bucketsBetween("2026-12-30", "2027-01-12", "week");
    expect(weeks.map((b) => [b.key, b.from, b.to])).toEqual([
      ["2026-12-28", "2026-12-30", "2027-01-03"], ["2027-01-04", "2027-01-04", "2027-01-10"], ["2027-01-11", "2027-01-11", "2027-01-12"],
    ]);
    expect(bucketsBetween("2026-02-27", "2026-03-02", "day")).toHaveLength(4);
    expect(bucketsBetween("2025-11-15", "2027-02-01", "year").map((b) => b.key)).toEqual(["2025-01-01", "2026-01-01", "2027-01-01"]);
  });

  it("picks a grouping for the range, the period before it, and ready-made ranges", () => {
    expect([autoGroup("2026-11-01", "2026-11-30"), autoGroup("2026-06-01", "2026-11-30"), autoGroup("2025-01-01", "2026-12-31"), autoGroup("2020-01-01", "2026-12-31")]).toEqual(["day", "week", "month", "year"]);
    expect(previousRange("2026-11-01", "2026-11-30")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(previousRange("2026-09-01", "2026-11-30")).toEqual({ from: "2026-06-01", to: "2026-08-31" });
    expect(previousRange("2026-01-01", "2026-12-31")).toEqual({ from: "2025-01-01", to: "2025-12-31" });
    expect(previousRange("2026-10-26", "2026-11-01")).toEqual({ from: "2026-10-19", to: "2026-10-25" });
    expect(reportRange("last_3_months", "2026-11-01")).toEqual({ from: "2026-09-01", to: "2026-11-30" });
    expect(reportRange("last_month", "2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(reportRange("last_12_weeks", "2026-11-01")).toEqual({ from: "2026-08-10", to: "2026-11-01" });
  });
});

describe("comparing two periods", () => {
  it("goes back a year, keeping whole months whole", () => {
    expect(sameTimeLastYear("2026-09-01", "2026-11-30")).toEqual({ from: "2025-09-01", to: "2025-11-30" });
    expect(sameTimeLastYear("2028-02-01", "2028-02-29")).toEqual({ from: "2027-02-01", to: "2027-02-28" });
    expect(sameTimeLastYear("2027-02-01", "2027-02-28")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(sameTimeLastYear("2025-03-01", "2025-03-10")).toEqual({ from: "2024-03-01", to: "2024-03-10" });
  });

  it("lines the buckets up in order and leaves gaps where one period is shorter", () => {
    const now = buildReport(base(week("a", "2026-10-26"), { from: "2026-10-01", to: "2026-10-31", groupBy: "day", metric: "hours" }));
    const then = buildReport(base([], { from: "2026-09-01", to: "2026-09-30", groupBy: "day", metric: "hours" }));
    const rows = compareReports(now, then);
    expect(rows).toHaveLength(31);
    expect(rows[25]).toMatchObject({ a: 9, b: 0, now: { from: "2026-10-26" }, then: { from: "2026-09-26" } });
    expect(rows[30]).toMatchObject({ a: 0, b: null, then: null, now: { from: "2026-10-31" } }); // a Saturday: 0, but a day; Sep has no 31st
  });

  it("writes ranges out for titles", () => {
    expect(rangeLabel("2026-09-01", "2026-11-30")).toBe("Sep 1 – Nov 30, 2026");
    expect(rangeLabel("2025-12-01", "2026-01-31")).toBe("Dec 1, 2025 – Jan 31, 2026");
  });

  it("adds regular and overtime up to hours", () => {
    const r = buildReport(base(week("a", "2026-10-26"), { metric: "reg_ot" }));
    expect(compareReports(r, r)[0]).toMatchObject({ a: 45, b: 45 });
  });
});
