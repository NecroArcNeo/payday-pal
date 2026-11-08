import { describe, expect, it } from "vitest";
import { isDateOrEmpty, placeToReopen, placeWorthKeeping, validFilter } from "./last-place";

describe("opening where I left off", () => {
  it("keeps the app's pages with their settings, nothing else", () => {
    expect(placeWorthKeeping("/payroll")).toBe(true);
    expect(placeWorthKeeping("/timesheet?employee=abc&from=2026-11-02&to=2026-11-08")).toBe(true);
    expect(placeWorthKeeping("/employees/3f2a-11")).toBe(true);
    expect(placeWorthKeeping("/")).toBe(false);
    expect(placeWorthKeeping("https://example.com/payroll")).toBe(false);
    expect(placeWorthKeeping("/auth")).toBe(false);
    expect(placeWorthKeeping(42)).toBe(false);
  });

  it("reopens the remembered page only when the app started on the Dashboard", () => {
    expect(placeToReopen("/dashboard", "/payroll")).toBe("/payroll");
    expect(placeToReopen("/dashboard", "/dashboard")).toBeNull();
    expect(placeToReopen("/records", "/payroll")).toBeNull(); // reloaded on a page, or opened from a link
    expect(placeToReopen("/dashboard", null)).toBeNull();
    expect(placeToReopen("/dashboard", "/nowhere")).toBeNull();
  });

  it("checks kept state before a page uses it", () => {
    expect(isDateOrEmpty("")).toBe(true);
    expect(isDateOrEmpty("2026-11-02")).toBe(true);
    expect(isDateOrEmpty("Nov 2")).toBe(false);
    expect(validFilter({ text: "ann", department: { include: ["Sales"], exclude: [] }, position: { include: [], exclude: [] } })).toBe(true);
    expect(validFilter({ text: "ann" })).toBe(false);
    expect(validFilter(null)).toBe(false);
  });
});
