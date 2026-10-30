import { describe, expect, it } from "vitest";
import type { PayLine } from "@/lib/pay";
import { fromBase64, plainCsv, templateCells, templateProblems, timesheetData, toBase64, type SheetRecord, type TimesheetTemplate } from "./timesheet-export";

const rec = (id: string, work_date: string, clock_in: string, clock_out: string, hours: number): SheetRecord =>
  ({ id, work_date, entry_mode: "clock", clock_in: `${clock_in}:00`, clock_out: `${clock_out}:00`, lunch_minutes: 30, hours, note: null, shiftName: "Day", rate: 20 });
const line = (id: string, regular: number, overtime = 0): [string, PayLine] =>
  [id, { id, regular, overtime, weekend: false, manual: false, salary: false, regPay: regular * 20, otPay: overtime * 30, pay: regular * 20 + overtime * 30 }];

const input = {
  employee: { first_name: "Ada", last_name: "Lovelace", employee_code: "E1", department: "Ops", job_title: null, pay_type: "hourly" },
  shiftName: "Day", rates: [20], from: "2026-10-19", to: "2026-10-21", today: "2026-10-28",
  // Two records on the 19th (a day and a night), none on the 20th.
  records: [rec("a", "2026-10-19", "06:00", "10:00", 3.5), rec("b", "2026-10-19", "18:00", "22:00", 3.5), rec("c", "2026-10-21", "09:00", "17:30", 8)],
  lines: new Map([line("a", 3.5), line("b", 3.5), line("c", 7, 1)]), extraPay: 50,
};
const template = (over: Partial<TimesheetTemplate["table"]> = {}): TimesheetTemplate => ({
  id: "t", name: "T", fileName: "t.xlsx", file: "", sheet: null,
  cells: { employee_name: "B2", period_from: "B3", total_pay: "F20" },
  table: { columns: { date: "A", clock_in: "B", hours: "E" }, startRow: 6, rows: 7, per: "record", ...over },
});

describe("timesheet export", () => {
  it("gives the totals and a row per record, or per calendar day with a day's records combined", () => {
    const byRecord = timesheetData(input);
    expect(byRecord.values.total_hours).toBe(15);
    expect(byRecord.values.overtime_hours).toBe(1);
    expect(byRecord.values.total_pay).toBe(14 * 20 + 30 + 50);
    expect(byRecord.values.days_worked).toBe(2);
    expect(byRecord.rows).toHaveLength(3);

    const byDay = timesheetData(input, "day");
    expect(byDay.rows.map((r) => r.date)).toEqual([{ date: "2026-10-19" }, { date: "2026-10-20" }, { date: "2026-10-21" }]);
    // First in, last out, breaks and hours added up; a day off is blank.
    expect(byDay.rows[0]).toMatchObject({ clock_in: { time: "06:00" }, clock_out: { time: "22:00" }, break_minutes: 60, hours: 7, weekday: "Mon" });
    expect(byDay.rows[1]).toMatchObject({ hours: null, clock_in: null, pay: null, weekday: "Tue" });
  });

  it("lays rows over whole weeks, dating every day, and refuses a period past them", () => {
    // The period starts on a Monday; two weeks give 14 dated days, the 19th's two records each in a row by record.
    const byDay = timesheetData(input, "day", 2);
    expect(byDay.rows).toHaveLength(14);
    expect(byDay.rows[13]).toMatchObject({ date: { date: "2026-11-01" }, weekday: "Sun", clock_in: null, hours: null, pay: null });
    const byRecord = timesheetData(input, "record", 2);
    expect(byRecord.rows).toHaveLength(15);
    expect(byRecord.rows.map((r) => r.weekday).slice(0, 4)).toEqual(["Mon", "Mon", "Tue", "Wed"]);
    expect(byRecord.rows[2]).toMatchObject({ date: { date: "2026-10-20" }, clock_in: null });
    // A mid-week start begins on that week's Monday.
    expect(timesheetData({ ...input, from: "2026-10-21" }, "day", 1).rows[0]!.date).toEqual({ date: "2026-10-19" });
    expect(() => timesheetData({ ...input, to: "2026-10-26" }, "day", 1)).toThrow(/shows 1 week \(2026-10-19 to 2026-10-25\)/);
    // Weeks can start on another weekday (counting back from the period's start), or on the period's first day.
    expect(timesheetData({ ...input, from: "2026-10-21" }, "day", 1, 3).rows.map((r) => r.weekday)).toEqual(["Wed", "Thu", "Fri", "Sat", "Sun", "Mon", "Tue"]);
    expect(timesheetData({ ...input, from: "2026-10-20" }, "day", 1, 6).rows[0]!.date).toEqual({ date: "2026-10-17" });
    expect(timesheetData({ ...input, from: "2026-10-20" }, "day", 1, "period").rows[0]!.date).toEqual({ date: "2026-10-20" });
    expect(templateProblems(template({ per: "day", weeks: 2, rows: 7 }))).toContain("2 weeks need 14 rows, and the template has room for 7");
  });

  it("places values and rows where the template says, clearing its unused rows, and refuses too many rows", () => {
    const cells = templateCells(template(), timesheetData(input));
    expect(cells.get("B2")).toBe("Ada Lovelace");
    expect(cells.get("A6")).toEqual({ date: "2026-10-19" });
    expect(cells.get("B7")).toEqual({ time: "18:00" });
    expect(cells.get("E8")).toBe(8);
    expect(cells.get("E9")).toBeNull();
    expect(cells.has("E12")).toBe(true);
    expect(cells.has("E13")).toBe(false);
    expect(() => templateCells(template({ rows: 2 }), timesheetData(input))).toThrow(/room for 2 rows, and this period needs 3/);
  });

  it("points out a template that would fill the wrong cells", () => {
    expect(templateProblems(template())).toEqual([]);
    expect(templateProblems({ ...template(), cells: { employee_name: "2B" } })).toEqual([`Employee name: "2B" isn't a cell like B3`]);
    expect(templateProblems(template({ startRow: null }))).toContain("Say which row the day-by-day rows start on");
    expect(templateProblems({ ...template({ rows: null }), cells: { total_pay: "E20" } })[0]).toMatch(/inside the day-by-day rows; set how many rows/);
  });

  it("writes a plain CSV and round-trips template files", () => {
    expect(plainCsv(timesheetData(input)).split("\r\n")[0]).toBe(`"Timesheet","Ada Lovelace","E1"`);
    const bytes = new Uint8Array([0, 1, 254, 255, 80]);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });
});
