import { describe, expect, it } from "vitest";
import { strFromU8 } from "fflate";
import type { Adjustment, Employee, TimeRecord } from "@/lib/payroll";
import { employeeTimesheet } from "./employee-timesheet";
import { exportFile, exportKindFrom, exportKindKey, type TimesheetTemplate } from "./timesheet-export";

const emp = (id: string, code: string) => ({
  id, employee_code: code, first_name: "Ada", last_name: code, department: null, job_title: null, pay_type: "hourly",
  hourly_rate: 20, shift_id: null, custom_fields: {}, active: true,
}) as unknown as Employee;
const rec = (id: string, employee_id: string, work_date: string, hours: number) => ({
  id, employee_id, work_date, entry_mode: "hours", clock_in: null, clock_out: null, lunch_minutes: 0, hours, note: null, shift_id: null, pay_override: null,
}) as unknown as TimeRecord;

const ctx = {
  from: "2026-10-19", to: "2026-10-25", today: "2026-10-29", shifts: [], defs: [], rateHistory: undefined,
  rules: { threshold: 40, otMultiplier: 1.5, weekendOvertime: true },
  // Two people's records, and one of the first person's from outside the period.
  records: [rec("a", "e1", "2026-10-20", 8), rec("b", "e2", "2026-10-20", 5), rec("c", "e1", "2026-10-27", 8)],
  adjustments: [{ id: "x", employee_id: "e1", amount: 25 }, { id: "y", employee_id: "e2", amount: 99 }] as unknown as Adjustment[],
};

describe("one employee's timesheet among everyone's records", () => {
  it("takes only their records in the period, and their own extra pay", () => {
    const d = employeeTimesheet(emp("e1", "E1"), ctx)("record", null, 1);
    expect(d.rows).toHaveLength(1);
    expect(d.values.total_hours).toBe(8);
    expect(d.values.extra_pay).toBe(25);
    expect(d.values.total_pay).toBe(8 * 20 + 25);
  });

  it("makes a named file of the asked kind", async () => {
    const f = await exportFile({ format: "csv" }, employeeTimesheet(emp("e2", "E2"), ctx), "timesheet Ada E2: 2026/10");
    expect(f.name).toBe("timesheet Ada E2- 2026-10.csv");
    // Starts with the byte-order mark Excel needs to read it as UTF-8 (text decoding drops it, so check the bytes).
    expect([...f.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(strFromU8(f.bytes)).toMatch(/^"Timesheet","Ada E2","E2"/);
    expect((await exportFile({ format: "xlsx" }, employeeTimesheet(emp("e2", "E2"), ctx), "t")).name).toBe("t.xlsx");
  });

  it("names an export's kind for routines, and finds it again", () => {
    const t = { id: "t1", name: "Weekly" } as unknown as TimesheetTemplate;
    for (const k of [{ format: "pdf" as const }, { format: "xlsx" as const, template: t }, { format: "pdf" as const, template: t }]) {
      expect(exportKindFrom(exportKindKey(k), [t])).toEqual(k);
    }
    expect(exportKindKey({ format: "pdf", template: t })).toBe("pdf:t1");
    // Routines saved before PDFs: a bare template id is that template as Excel.
    expect(exportKindFrom("t1", [t])).toEqual({ format: "xlsx", template: t });
    expect(exportKindFrom("pdf:gone", [t])).toBeNull();
  });
});
