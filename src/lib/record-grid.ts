// Editing Time records like a spreadsheet ("Edit in cells"): which cells can be typed into, what a cell's text is, how
// typed or pasted text becomes a change, and how a pasted block lands on the rows. Pure, tested; the table
// (src/components/RecordGrid.tsx and RecordsLedger) handles the keys and saving.
import { parseTime } from "@/lib/import/parse";
import { readTypedDate, type DayOrder } from "@/lib/typed-date";
import { breakToMinutes, formatBreak, validBreak, breakRangeText, type BreakUnit } from "@/lib/breaks";
import { readAmount } from "@/lib/amount";

export type GridKey = "date" | "shift" | "clock_in" | "clock_out" | "break" | "hours" | "note";
type Mode = "clock" | "hours";

/** The cells that can be typed into, left to right as the table shows them. A clock record's hours are worked out. */
export const gridColumns = (mode: Mode): GridKey[] => (mode === "clock" ? ["date", "shift", "clock_in", "clock_out", "break", "note"] : ["date", "shift", "hours", "note"]);

export type GridRecord = {
  id: string; employee_id: string; work_date: string; entry_mode: string; clock_in: string | null; clock_out: string | null;
  lunch_minutes: number | null; hours: number | string | null; note: string | null; shift_id: string | null; unlocked?: boolean | null;
};
export type GridContext = {
  today: string; order: DayOrder; unit: BreakUnit;
  shifts: { id: string; name: string }[];
  /** The employee's own shift, for "their usual shift" (a record stores a shift only when it differs). */
  usualShift: (employeeId: string) => string | null;
  lockedThrough: string | null;
};

/** Whether a record's day is locked as paid (and it wasn't unlocked by itself): its cells can't change. */
export const isLocked = (r: GridRecord, lockedThrough: string | null) => !!lockedThrough && r.work_date <= lockedThrough && !r.unlocked;

/** A cell's text, as it's edited (and copied). */
export function cellText(r: GridRecord, key: GridKey, ctx: Pick<GridContext, "shifts" | "unit" | "usualShift">): string {
  switch (key) {
    case "date": return r.work_date;
    case "shift": return ctx.shifts.find((s) => s.id === (r.shift_id ?? ctx.usualShift(r.employee_id)))?.name ?? "";
    case "clock_in": return r.clock_in?.slice(0, 5) ?? "";
    case "clock_out": return r.clock_out?.slice(0, 5) ?? "";
    case "break": return formatBreak(r.lunch_minutes, ctx.unit);
    case "hours": return Number(r.hours ?? 0).toFixed(2);
    case "note": return r.note ?? "";
  }
}

export type CellChange = { patch: Record<string, unknown> } | { error: string };

/** What typing `text` into a cell changes, or why it can't. */
export function readCell(r: GridRecord, key: GridKey, text: string, ctx: GridContext): CellChange {
  const t = text.trim();
  switch (key) {
    case "date": {
      const d = readTypedDate(t, ctx.today, ctx.order);
      if (!d) return { error: `"${t}" isn't a date` };
      if (ctx.lockedThrough && d <= ctx.lockedThrough) return { error: `Days up to ${ctx.lockedThrough} are locked as paid` };
      return { patch: { work_date: d } };
    }
    case "shift": {
      if (!t) return { patch: { shift_id: null } };
      const s = ctx.shifts.find((x) => x.name.toLowerCase() === t.toLowerCase()) ?? ctx.shifts.find((x) => x.name.toLowerCase().startsWith(t.toLowerCase()));
      if (!s) return { error: `There's no shift called "${t}" (${ctx.shifts.map((x) => x.name).join(", ")})` };
      // Only a shift other than the person's own is stored on the record.
      return { patch: { shift_id: s.id === ctx.usualShift(r.employee_id) ? null : s.id } };
    }
    case "clock_in":
    case "clock_out": {
      // A bare hour ("9", "17") is that hour sharp.
      const time = parseTime({ text: /^[0-9]{1,2}$/.test(t) ? `${t}:00` : t });
      if (!time) return { error: `"${t}" isn't a time (e.g. 9:00, 5pm, 1730)` };
      return { patch: { [key]: time } };
    }
    case "break": {
      const m = breakToMinutes(t, ctx.unit);
      if (!validBreak(m)) return { error: breakRangeText(ctx.unit) };
      return { patch: { lunch_minutes: m } };
    }
    case "hours": {
      const h = readAmount(t);
      if (!Number.isFinite(h) || h < 0 || h > 24) return { error: "Hours must be 0–24" };
      return { patch: { hours: Math.round(h * 100) / 100 } };
    }
    case "note":
      return { patch: { note: t.slice(0, 300) || null } };
  }
}

export type PastePlan = { updates: { id: string; patch: Record<string, unknown> }[]; cells: number; errors: string[]; locked: number; outside: number };

/**
 * A pasted block (rows of cells) laid over the table from the active cell: down the rows as shown and right across the
 * columns that can be typed into. Each row's cells make one change; cells that don't read, locked rows and cells past
 * the table's edge are left out and counted.
 */
export function planGridPaste(rows: GridRecord[], startId: string, startKey: GridKey, block: string[][], mode: Mode, ctx: GridContext): PastePlan {
  const cols = gridColumns(mode);
  const r0 = rows.findIndex((r) => r.id === startId);
  const c0 = cols.indexOf(startKey);
  const plan: PastePlan = { updates: [], cells: 0, errors: [], locked: 0, outside: 0 };
  if (r0 < 0 || c0 < 0) return plan;
  block.forEach((line, i) => {
    const r = rows[r0 + i];
    if (!r) { plan.outside += line.length; return; }
    if (isLocked(r, ctx.lockedThrough)) { plan.locked++; return; }
    const patch: Record<string, unknown> = {};
    line.forEach((text, j) => {
      const key = cols[c0 + j];
      if (!key) { plan.outside++; return; }
      const change = readCell(r, key, text, ctx);
      if ("error" in change) plan.errors.push(`Row ${i + 1}, ${key.replace("_", " ")}: ${change.error}`);
      else { Object.assign(patch, change.patch); plan.cells++; }
    });
    if (Object.keys(patch).length) plan.updates.push({ id: r.id, patch });
  });
  return plan;
}
