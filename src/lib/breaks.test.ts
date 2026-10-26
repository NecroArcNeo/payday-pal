// @vitest-environment node
import { describe, expect, it } from "vitest";
import { breakToMinutes, formatBreak, validBreak } from "./breaks";
import { datesBetween } from "./payroll";

describe("breaks in minutes or hours", () => {
  it("shows stored minutes in either unit", () => {
    expect(formatBreak(30, "min")).toBe("30");
    expect(formatBreak(30, "h")).toBe("0.50");
    expect(formatBreak(null, "h")).toBe("0.00");
  });

  it("reads what was typed back as whole minutes", () => {
    expect(breakToMinutes("45", "min")).toBe(45);
    expect(breakToMinutes("0.75", "h")).toBe(45);
    expect(breakToMinutes("1,5", "h")).toBe(90);
    expect(breakToMinutes("", "h")).toBe(0);
    expect(breakToMinutes("abc", "min")).toBeNaN();
  });

  it("allows 0 to 600 minutes", () => {
    expect([validBreak(0), validBreak(600), validBreak(601), validBreak(-1), validBreak(NaN)]).toEqual([true, true, false, false, false]);
  });
});

describe("date ranges for new records", () => {
  it("lists every day inclusive, just the start when there's no end, and can skip weekends", () => {
    expect(datesBetween("2026-10-23", "")).toEqual(["2026-10-23"]);
    expect(datesBetween("2026-10-23", "2026-10-27")).toEqual(["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"]);
    expect(datesBetween("2026-10-23", "2026-10-27", true)).toEqual(["2026-10-23", "2026-10-26", "2026-10-27"]);
    expect(datesBetween("2026-10-24", "2026-10-25", true)).toEqual([]);
    expect(datesBetween("2026-12-31", "2027-01-01")).toEqual(["2026-12-31", "2027-01-01"]);
  });
});
