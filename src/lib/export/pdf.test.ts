import { describe, expect, it } from "vitest";
import { pdfLayout, plainSheet } from "./pdf";
import type { RenderedCell, RenderedSheet } from "./sheet-render";

/** A sheet of `rows` × `cols`, `width` px per column and `height` px per row; `text` puts text in cells ("row:col"). */
function sheet(rows: number, cols: number, opts: { width?: number; height?: number; text?: string[]; merge?: [number, number, number] } = {}): RenderedSheet {
  const { width = 64, height = 20, text = [] } = opts;
  const covered = new Set<string>();
  if (opts.merge) { const [r, c, span] = opts.merge; for (let k = 1; k < span; k++) covered.add(`${r + k}:${c}`); }
  return {
    gridlines: true,
    cols: Array.from({ length: cols }, (_, i) => ({ col: i + 1, width })),
    rows: Array.from({ length: rows }, (_, ri) => ({
      row: ri + 1, height,
      cells: Array.from({ length: cols }, (_, ci): RenderedCell => ({
        row: ri + 1, col: ci + 1, text: text.includes(`${ri + 1}:${ci + 1}`) ? "x" : "", look: {}, numeric: false, colSpan: 1,
        rowSpan: opts.merge && opts.merge[0] === ri + 1 && opts.merge[1] === ci + 1 ? opts.merge[2] : 1,
      })).filter((c) => !covered.has(`${c.row}:${c.col}`)),
    })),
  };
}

describe("PDF layout", () => {
  it("trims the empty rows and columns around the content", () => {
    const l = pdfLayout(sheet(30, 10, { text: ["2:3", "5:1"] }));
    expect(l.cols).toEqual([1, 2, 3]);
    expect(l.pages.flatMap((p) => p.rows)).toEqual([1, 2, 3, 4, 5]);
    expect(l.scale).toBe(1);
    expect(l.landscape).toBe(false);
  });

  it("shrinks a wide sheet to the page, turning it sideways when that shows it bigger", () => {
    const l = pdfLayout(sheet(5, 16, { width: 80, text: ["1:16"] }));
    expect(l.landscape).toBe(true);
    // 16 × 80 px = 960 pt-ish at 0.75; the landscape page has 785 pt between its margins.
    expect(l.scale).toBeCloseTo((841.89 - 2 * 28.35) / (16 * 80 * 0.75), 5);
  });

  it("splits long sheets into pages between rows, never through a merged block", () => {
    // A4 portrait holds (841.89 - 56.7) / 0.75 ≈ 1047 px of rows: 52 rows of 20 px.
    const long = pdfLayout(sheet(120, 2, { text: ["120:1"] }));
    expect(long.pages.map((p) => p.rows.length)).toEqual([52, 52, 16]);
    // A block over rows 51–54 moves to the next page whole.
    const merged = pdfLayout(sheet(120, 2, { text: ["120:1", "51:1"], merge: [51, 1, 4] }));
    expect(merged.pages[0]!.rows.at(-1)).toBe(50);
    expect(merged.pages[1]!.rows[0]).toBe(51);
  });

  it("lays the plain table out with a bold header and room for every entry", () => {
    const s = plainSheet([["Timesheet", "Ada", "E1"], ["Period", "2026-10-19", "2026-10-25"], [], ["Date", "Hours"], ["2026-10-19", 8], [], ["Total hours", 8]], 3, (t) => t.length * 7);
    expect(s.rows[3]!.cells[0]!.look.bold).toBe(true);
    expect(s.rows[4]!.cells[1]).toMatchObject({ text: "8", numeric: true });
    expect(s.cols[0]!.width).toBeGreaterThanOrEqual("Total hours".length * 7 + 12);
  });
});
