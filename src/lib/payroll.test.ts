import { describe, expect, it } from "vitest";
import { addDays, isoDate, weekday } from "./payroll";

describe("date helpers", () => {
  it("names the weekday of an ISO date", () => {
    expect(["2026-10-19", "2026-10-24", "2026-10-25"].map(weekday)).toEqual(["Mon", "Sat", "Sun"]);
  });
  it("moves dates across month and year ends", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2027-01-03", -7)).toBe("2026-12-27");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });
  it("uses the local calendar date, not UTC's", () => {
    expect(isoDate(new Date(2026, 9, 24, 23, 30))).toBe("2026-10-24");
  });
});
