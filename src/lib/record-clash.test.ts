import { describe, expect, it } from "vitest";
import { describeRecord, sameDayClashes } from "./record-clash";

const rec = (employee_id: string, work_date: string, clock_in = "09:00:00", clock_out = "17:00:00") =>
  ({ employee_id, work_date, entry_mode: "clock" as const, clock_in, clock_out, hours: 7.5 });

describe("same-day records", () => {
  it("lists each employee-day being added that already has records, once", () => {
    const existing = [rec("a", "2026-11-03"), rec("a", "2026-11-03", "22:00:00", "06:00:00"), rec("b", "2026-11-04")];
    const adding = [
      { employee_id: "a", work_date: "2026-11-03" }, { employee_id: "a", work_date: "2026-11-03" },
      { employee_id: "a", work_date: "2026-11-04" }, { employee_id: "b", work_date: "2026-11-04" },
    ];
    const c = sameDayClashes(adding, existing);
    expect(c.map((x) => `${x.employee_id} ${x.work_date} ${x.existing.length}`)).toEqual(["a 2026-11-03 2", "b 2026-11-04 1"]);
    expect(sameDayClashes(adding, [])).toEqual([]);
  });

  it("describes a record by its times, or its hours", () => {
    expect(describeRecord(rec("a", "2026-11-03"))).toBe("09:00–17:00");
    expect(describeRecord({ entry_mode: "hours", clock_in: null, clock_out: null, hours: 8 })).toBe("8 h");
  });
});
