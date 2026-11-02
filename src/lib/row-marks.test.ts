import { describe, expect, it } from "vitest";
import type { PayLine } from "@/lib/pay";
import { colourCss, DEFAULT_MARKS, markRecord, recordKinds, validMarks, type MarkFacts } from "./row-marks";

const line = (overtime: number, more: Partial<PayLine> = {}): PayLine =>
  ({ id: "r", regular: 8 - overtime, overtime, weekend: false, manual: false, salary: false, regPay: 0, otPay: 0, pay: 0, ...more });
// A Tuesday, on the usual shift, nothing special.
const facts = (more: Partial<MarkFacts> = {}): MarkFacts => ({
  work_date: "2026-11-03", shift_id: null, usualShiftId: "day", pay_override: null, unlocked: false, employeeActive: true,
  line: line(0), lockedThrough: null, warnings: [], ...more,
});
const kinds = (f: MarkFacts) => recordKinds(f).map((k) => k.kind);

describe("row colours and tags", () => {
  it("finds nothing on an ordinary record", () => {
    expect(markRecord(facts(), DEFAULT_MARKS)).toEqual({ row: null, tags: [] });
  });

  it("colours overtime rows orange by default, with the hours in the detail", () => {
    const m = markRecord(facts({ line: line(2.5) }), DEFAULT_MARKS);
    expect(m.row).toEqual({ kind: "overtime", colour: "orange", detail: "2.5 h overtime" });
  });

  it("knows each kind", () => {
    expect(kinds(facts({ work_date: "2026-11-07" }))).toEqual(["weekend"]);
    expect(kinds(facts({ pay_override: 0 }))).toEqual(["manual"]);
    expect(kinds(facts({ shift_id: "night" }))).toEqual(["shift"]);
    expect(kinds(facts({ shift_id: "day" }))).toEqual([]);
    expect(kinds(facts({ lockedThrough: "2026-11-03" }))).toEqual(["locked"]);
    expect(kinds(facts({ lockedThrough: "2026-11-03", unlocked: true }))).toEqual(["unlocked"]);
    expect(kinds(facts({ lockedThrough: "2026-11-02" }))).toEqual([]);
    expect(kinds(facts({ employeeActive: false }))).toEqual(["resigned"]);
    expect(recordKinds(facts({ warnings: ["Very long day", "No break"] }))).toEqual([{ kind: "warning", detail: "Very long day, No break" }]);
  });

  it("tags by default what isn't a row colour, and leaves out what's off", () => {
    const m = markRecord(facts({ line: line(1), warnings: ["No break"], pay_override: 100, employeeActive: false }), DEFAULT_MARKS);
    expect(m.row?.kind).toBe("overtime");
    expect(m.tags.map((t) => t.kind)).toEqual(["warning", "resigned"]);
  });

  it("lets the first row colour win and shows the others as tags", () => {
    const s = { ...DEFAULT_MARKS, weekend: { as: "row" as const, colour: "purple" as const } };
    const m = markRecord(facts({ work_date: "2026-11-07", line: line(8, { weekend: true }) }), s);
    expect(m.row).toMatchObject({ kind: "overtime", detail: "8 h overtime (weekend)" });
    expect(m.tags).toEqual([{ kind: "weekend", colour: "purple", detail: "Saturday" }]);
    expect(markRecord(facts({ work_date: "2026-11-07" }), s).row?.kind).toBe("weekend");
  });

  it("shows nothing when turned off, and keeps each choice for when it's back on", () => {
    const off = { ...DEFAULT_MARKS, on: false };
    expect(markRecord(facts({ line: line(2), employeeActive: false }), off)).toEqual({ row: null, tags: [] });
    expect(validMarks(off)).toEqual(off);
  });

  it("takes a colour the user picked", () => {
    const s = { ...DEFAULT_MARKS, overtime: { as: "row" as const, colour: "#ff00aa" as const } };
    expect(markRecord(facts({ line: line(1) }), s).row?.colour).toBe("#ff00aa");
    expect(colourCss("#ff00aa")).toBe("#ff00aa");
    expect(colourCss("orange")).toMatch(/^oklch/);
  });

  it("puts back defaults for anything saved that isn't valid", () => {
    expect(validMarks(null)).toEqual(DEFAULT_MARKS);
    const v = validMarks({ overtime: { as: "tag", colour: "pink" }, manual: { as: "row" }, nope: { as: "row" } });
    expect(v.overtime).toEqual({ as: "tag", colour: "orange" });
    expect(v.manual).toEqual({ as: "row", colour: "blue" });
    expect(validMarks({ on: "no", overtime: { colour: "#12345" } })).toMatchObject({ on: true, overtime: { colour: "orange" } });
  });
});
