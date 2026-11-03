import { describe, expect, it } from "vitest";
import { dayAfter, dayBefore, howFar, periodHint } from "./period-hint";

describe("the hint for a period with no hours", () => {
  it("notices a period that ends before it starts", () => {
    expect(periodHint("2026-11-08", "2026-11-02", { before: null, after: null })).toEqual({ kind: "backwards" });
  });

  it("says when there are no records at all", () => {
    expect(periodHint("2026-11-02", "2026-11-08", { before: null, after: null })).toEqual({ kind: "no-records" });
  });

  it("offers the whole week of the nearest record on each side, closest first", () => {
    const h = periodHint("2026-11-02", "2026-11-08", { before: { date: "2026-10-30", count: 16 }, after: { date: "2027-01-06", count: 4 } });
    expect(h).toEqual({ kind: "nearest", options: [
      { side: "before", date: "2026-10-30", count: 16, from: "2026-10-26", to: "2026-11-01", days: 3 },
      { side: "after", date: "2027-01-06", count: 4, from: "2027-01-04", to: "2027-01-10", days: 59 },
    ] });
  });

  it("puts the later records first when they're closer (a year typed wrong, say)", () => {
    const h = periodHint("2025-10-26", "2025-11-01", { before: null, after: { date: "2026-10-30", count: 16 } });
    expect(h.kind === "nearest" && h.options.map((o) => [o.side, howFar(o.days)])).toEqual([["after", "about 12 months"]]);
  });

  it("steps days across month and year ends", () => {
    expect(dayBefore("2026-03-01")).toBe("2026-02-28");
    expect(dayAfter("2026-12-31")).toBe("2027-01-01");
  });

  it("says roughly how far", () => {
    expect([1, 3, 20, 59, 120, 400, 800].map(howFar)).toEqual(["1 day", "3 days", "3 weeks", "8 weeks", "about 4 months", "over a year", "over 2 years"]);
  });
});
