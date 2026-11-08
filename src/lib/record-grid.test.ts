import { describe, expect, it } from "vitest";
import { cellText, gridColumns, planGridPaste, readCell, type GridContext, type GridRecord } from "./record-grid";

const ctx: GridContext = {
  today: "2026-11-06", order: "mdy", unit: "min", lockedThrough: "2026-10-31",
  shifts: [{ id: "day", name: "Day" }, { id: "night", name: "Night" }],
  usualShift: () => "day",
};
const rec = (id: string, work_date: string, more: Partial<GridRecord> = {}): GridRecord =>
  ({ id, employee_id: "a", work_date, entry_mode: "clock", clock_in: "09:00:00", clock_out: "17:00:00", lunch_minutes: 30, hours: 7.5, note: null, shift_id: null, ...more });

describe("editing records in cells", () => {
  it("lists the cells that can be typed into, in the table's order", () => {
    expect(gridColumns("clock")).toEqual(["date", "shift", "clock_in", "clock_out", "break", "note"]);
    expect(gridColumns("hours")).toEqual(["date", "shift", "hours", "note"]);
  });

  it("shows a cell's text as it's edited", () => {
    const r = rec("1", "2026-11-02", { shift_id: "night", note: "cover" });
    expect(["date", "shift", "clock_in", "clock_out", "break", "note"].map((k) => cellText(r, k as never, ctx))).toEqual(["2026-11-02", "Night", "09:00", "17:00", "30", "cover"]);
    expect(cellText(rec("2", "2026-11-02"), "shift", ctx)).toBe("Day"); // their usual shift
    expect(cellText(rec("3", "2026-11-02"), "break", { ...ctx, unit: "h" })).toBe("0.50");
  });

  it("reads typed text the way the rest of the app does", () => {
    const r = rec("1", "2026-11-02");
    expect(readCell(r, "clock_out", "5:30pm", ctx)).toEqual({ patch: { clock_out: "17:30" } });
    expect(readCell(r, "clock_in", "0815", ctx)).toEqual({ patch: { clock_in: "08:15" } });
    expect(readCell(r, "clock_out", "17", ctx)).toEqual({ patch: { clock_out: "17:00" } });
    expect(readCell(r, "date", "11/3", ctx)).toEqual({ patch: { work_date: "2026-11-03" } });
    expect(readCell(r, "break", "45", ctx)).toEqual({ patch: { lunch_minutes: 45 } });
    expect(readCell(r, "break", "0.75", { ...ctx, unit: "h" })).toEqual({ patch: { lunch_minutes: 45 } });
    expect(readCell(r, "hours", "7,5", ctx)).toEqual({ patch: { hours: 7.5 } });
    expect(readCell(r, "note", "  ", ctx)).toEqual({ patch: { note: null } });
    // A shift by name (or its start); the person's own shift is stored as "usual" (null).
    expect(readCell(r, "shift", "nig", ctx)).toEqual({ patch: { shift_id: "night" } });
    expect(readCell(r, "shift", "day", ctx)).toEqual({ patch: { shift_id: null } });
  });

  it("refuses what doesn't read, and dates locked as paid", () => {
    expect(readCell(rec("1", "2026-11-02"), "clock_in", "lunch", ctx)).toHaveProperty("error");
    expect(readCell(rec("1", "2026-11-02"), "hours", "30", ctx)).toEqual({ error: "Hours must be 0–24" });
    expect(readCell(rec("1", "2026-11-02"), "date", "10/30", ctx)).toEqual({ error: "Days up to 2026-10-31 are locked as paid" });
    expect(readCell(rec("1", "2026-11-02"), "shift", "Swing", ctx)).toHaveProperty("error");
    expect(readCell(rec("1", "2026-11-02"), "break", "900", ctx)).toHaveProperty("error");
  });

  it("lays a pasted block over the rows from the active cell, one change per row", () => {
    const rows = [rec("1", "2026-11-02"), rec("2", "2026-10-30"), rec("3", "2026-11-03"), rec("4", "2026-11-04")];
    const block = [["8:00", "16:00", "45"], ["8:00", "16:00", "45"], ["7am", "3pm", "nope"], ["9", "17", "0", "extra", "more"]];
    const plan = planGridPaste(rows, "1", "clock_in", block, "clock", ctx);
    expect(plan.updates).toEqual([
      { id: "1", patch: { clock_in: "08:00", clock_out: "16:00", lunch_minutes: 45 } },
      { id: "3", patch: { clock_in: "07:00", clock_out: "15:00" } },
      { id: "4", patch: { clock_in: "09:00", clock_out: "17:00", lunch_minutes: 0, note: "extra" } },
    ]);
    expect(plan.locked).toBe(1); // row 2 is on a locked day
    expect(plan.errors).toHaveLength(1); // "nope" isn't a break
    expect(plan.outside).toBe(1); // "more" is past the last column
  });

  it("counts pasted rows past the end of the table", () => {
    const plan = planGridPaste([rec("1", "2026-11-02")], "1", "note", [["a"], ["b"], ["c"]], "clock", ctx);
    expect([plan.updates.length, plan.outside]).toEqual([1, 2]);
  });
});
