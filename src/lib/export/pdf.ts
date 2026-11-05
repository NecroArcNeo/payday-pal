import { jsPDF } from "jspdf";
import type { CellLook, RenderedCell, RenderedSheet } from "./sheet-render";

// Timesheets as PDF. A sheet laid out by renderSheet (a filled template, or the plain table built below) is drawn
// page by page on a canvas, the way the template editor draws it, and each page goes into the PDF as an image.
// Drawing with the browser's own text keeps every font and alphabet (names in any language) without bundling fonts;
// the cost is that the PDF's text can't be selected. Pictures in a template (logos) aren't drawn.

/** A4 in points, with 10 mm margins. */
const PAGE = { w: 595.28, h: 841.89, margin: 28.35 };
/** Screen pixels (96 per inch) to points (72 per inch). */
const PT = 0.75;
/** Canvas pixels per point: 200 dots per inch, sharp in print. */
const DPI = 200 / 72;

export type PdfPage = { rows: number[]; height: number };
export type PdfLayout = { landscape: boolean; scale: number; cols: number[]; width: number; pages: PdfPage[] };

const blank = (c: RenderedCell) => !c.text && !c.look.background && !c.look.borderTop && !c.look.borderRight && !c.look.borderBottom && !c.look.borderLeft;

/**
 * Where everything goes: the sheet trimmed to what's on it, scaled to fit the page width (never enlarged), in
 * portrait or landscape (whichever shows it bigger), and split into pages between rows, never through a merged block.
 */
export function pdfLayout(sheet: RenderedSheet): PdfLayout {
  // Trim empty rows and columns at the end (renderSheet adds a few around the content for the editor).
  let lastRow = -1, lastCol = -1;
  sheet.rows.forEach((r, ri) => r.cells.forEach((c) => {
    if (blank(c)) return;
    lastRow = Math.max(lastRow, ri + c.rowSpan - 1);
    lastCol = Math.max(lastCol, sheet.cols.findIndex((x) => x.col === c.col) + c.colSpan - 1);
  }));
  const rows = sheet.rows.slice(0, lastRow + 1), cols = sheet.cols.slice(0, lastCol + 1);
  const width = cols.reduce((s, c) => s + c.width, 0);
  const fit = (pageW: number) => Math.min(1, (pageW - 2 * PAGE.margin) / Math.max(1, width * PT));
  const portrait = fit(PAGE.w), wide = fit(PAGE.h);
  const landscape = wide > portrait * 1.05;
  const scale = landscape ? wide : portrait;
  const room = ((landscape ? PAGE.w : PAGE.h) - 2 * PAGE.margin) / (PT * scale);

  // Row i can start a page unless a merged block from an earlier row runs over it.
  const blocked = new Set<number>();
  rows.forEach((r, ri) => r.cells.forEach((c) => { for (let k = 1; k < c.rowSpan; k++) blocked.add(ri + k); }));
  const pages: PdfPage[] = [];
  let start = 0;
  while (start < rows.length) {
    let end = start, used = 0, lastBreak = -1;
    while (end < rows.length && (used + rows[end]!.height <= room || end === start)) {
      used += rows[end]!.height;
      end++;
      if (end < rows.length && !blocked.has(end)) lastBreak = end;
    }
    // Break at the last row a page can start on; a block taller than a page is cut where it must be.
    if (end < rows.length && blocked.has(end) && lastBreak > start) end = lastBreak;
    const these = rows.slice(start, end);
    pages.push({ rows: these.map((r) => r.row), height: these.reduce((s, r) => s + r.height, 0) });
    start = end;
  }
  if (!pages.length) pages.push({ rows: [], height: 0 });
  return { landscape, scale, cols: cols.map((c) => c.col), width, pages };
}

// ---------------------------------------------------------------- drawing

function border(ctx: CanvasRenderingContext2D, spec: string | undefined, x1: number, y1: number, x2: number, y2: number) {
  if (!spec) return;
  const [w, style, color] = spec.split(" ") as [string, string, string];
  const width = parseFloat(w) || 1;
  ctx.save();
  ctx.strokeStyle = color ?? "#000";
  ctx.setLineDash(style === "dotted" ? [1, 2] : style === "dashed" ? [4, 2] : []);
  const line = (dx: number, dy: number, lw: number) => {
    ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(x1 + dx, y1 + dy); ctx.lineTo(x2 + dx, y2 + dy); ctx.stroke();
  };
  if (style === "double") { const o = x1 === x2 ? 1 : 0, p = 1 - o; line(-o, -p, 0.8); line(o, p, 0.8); }
  else line(0, 0, width);
  ctx.restore();
}

const font = (l: CellLook) => `${l.italic ? "italic " : ""}${l.bold ? "bold " : ""}${((l.fontSize ?? 11) * 4) / 3}px ${l.fontFamily ? `"${l.fontFamily}", ` : ""}Calibri, Carlito, Arial, sans-serif`;

function wrapLines(ctx: CanvasRenderingContext2D, text: string, width: number) {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > width) { out.push(line); line = word; } else line = next;
    }
    out.push(line);
  }
  return out;
}

/** One page of the sheet on a canvas, in sheet pixels scaled to print resolution. */
function drawPage(sheet: RenderedSheet, layout: PdfLayout, page: PdfPage): HTMLCanvasElement {
  const k = PT * layout.scale * DPI;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(layout.width * k));
  canvas.height = Math.max(1, Math.ceil(page.height * k));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(k, k);

  const colX = new Map<number, { x: number; w: number }>();
  let x = 0;
  for (const c of sheet.cols) if (layout.cols.includes(c.col)) { colX.set(c.col, { x, w: c.width }); x += c.width; }
  const rowY = new Map<number, { y: number; h: number }>();
  let y = 0;
  const onPage = new Set(page.rows);
  const rows = sheet.rows.filter((r) => onPage.has(r.row));
  for (const r of rows) { rowY.set(r.row, { y, h: r.height }); y += r.height; }
  // A merged block's size: the visible columns and rows it covers (rows on this page only).
  const visibleCols = sheet.cols.filter((c) => colX.has(c.col)).map((c) => c.col);
  const allRows = sheet.rows.map((r) => r.row);
  const box = (c: RenderedCell) => {
    const ci = visibleCols.indexOf(c.col), ri = allRows.indexOf(c.row);
    const cs = visibleCols.slice(ci, ci + c.colSpan), rs = allRows.slice(ri, ri + c.rowSpan).filter((r) => onPage.has(r));
    const first = rowY.get(c.row)!, col = colX.get(c.col)!;
    return { x: col.x, y: first.y, w: cs.reduce((s, cc) => s + colX.get(cc)!.w, 0), h: rs.reduce((s, rr) => s + rowY.get(rr)!.h, 0) };
  };
  const cells = rows.flatMap((r) => r.cells.filter((c) => colX.has(c.col)));

  if (sheet.printGridlines) {
    ctx.strokeStyle = "#d4d4d4"; ctx.lineWidth = 0.5;
    for (const c of cells) { const b = box(c); ctx.strokeRect(b.x, b.y, b.w, b.h); }
  }
  for (const c of cells) if (c.look.background) { const b = box(c); ctx.fillStyle = c.look.background; ctx.fillRect(b.x, b.y, b.w, b.h); }

  // Text: clipped to its cell, except that left-aligned text runs on into empty cells to its right, as in Excel.
  const empty = new Set(cells.filter((c) => !c.text && c.colSpan === 1 && c.rowSpan === 1).map((c) => `${c.row}:${c.col}`));
  for (const c of cells) {
    if (!c.text) continue;
    const l = c.look, b = box(c);
    const align = l.align === "justify" ? "left" : l.align ?? (c.numeric ? "right" : "left");
    let clipW = b.w;
    if (align === "left" && !l.wrap && c.colSpan === 1) {
      for (let i = visibleCols.indexOf(c.col) + 1; i < visibleCols.length && empty.has(`${c.row}:${visibleCols[i]}`); i++) clipW += colX.get(visibleCols[i]!)!.w;
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(b.x, b.y, clipW, b.h); ctx.clip();
    ctx.font = font(l);
    ctx.fillStyle = l.color ?? "#000000";
    ctx.textAlign = align;
    ctx.textBaseline = "alphabetic";
    const size = ((l.fontSize ?? 11) * 4) / 3, lineH = size * 1.15, pad = 3;
    const lines = l.wrap ? wrapLines(ctx, c.text, b.w - 2 * pad) : [c.text];
    const blockH = lines.length * lineH;
    const top = l.valign === "top" ? b.y + 1 : l.valign === "middle" ? b.y + (b.h - blockH) / 2 : b.y + b.h - blockH - 1;
    const tx = align === "center" ? b.x + b.w / 2 : align === "right" ? b.x + b.w - pad : b.x + pad;
    lines.forEach((t, i) => {
      const base = top + lineH * (i + 1) - (lineH - size) / 2 - size * 0.2;
      ctx.fillText(t, tx, base);
      if (l.underline || l.strike) {
        const w = ctx.measureText(t).width, left = align === "center" ? tx - w / 2 : align === "right" ? tx - w : tx;
        ctx.fillRect(left, l.strike ? base - size * 0.3 : base + 1.5, w, Math.max(0.6, size / 16));
      }
    });
    ctx.restore();
  }
  for (const c of cells) {
    const b = box(c), l = c.look;
    border(ctx, l.borderTop, b.x, b.y, b.x + b.w, b.y);
    border(ctx, l.borderBottom, b.x, b.y + b.h, b.x + b.w, b.y + b.h);
    border(ctx, l.borderLeft, b.x, b.y, b.x, b.y + b.h);
    border(ctx, l.borderRight, b.x + b.w, b.y, b.x + b.w, b.y + b.h);
  }
  return canvas;
}

/** The sheet as a PDF file, A4, fitted to the page width. */
export function sheetPdf(sheet: RenderedSheet, title: string): Uint8Array {
  const layout = pdfLayout(sheet);
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: layout.landscape ? "landscape" : "portrait", compress: true });
  doc.setProperties({ title, creator: "KoPayroll" });
  layout.pages.forEach((page, i) => {
    if (i) doc.addPage("a4", layout.landscape ? "landscape" : "portrait");
    if (!page.rows.length) return;
    const canvas = drawPage(sheet, layout, page);
    doc.addImage(canvas, "PNG", PAGE.margin, PAGE.margin, layout.width * PT * layout.scale, page.height * PT * layout.scale, undefined, "FAST");
  });
  return new Uint8Array(doc.output("arraybuffer"));
}

/**
 * A chart as a PDF: the chart picture on an A4 landscape page (scaled to fit, never enlarged past print sharpness),
 * then the numbers, if given, laid out like the plain timesheet export on the pages after it.
 */
export function chartPdf(chart: HTMLCanvasElement, title: string, table: RenderedSheet | null): Uint8Array {
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape", compress: true });
  doc.setProperties({ title, creator: "KoPayroll" });
  const room = { w: PAGE.h - PAGE.margin * 2, h: PAGE.w - PAGE.margin * 2 };
  // The canvas is drawn at 2 pixels per screen pixel; screen pixels are 0.75 pt.
  const natural = { w: (chart.width / 2) * PT, h: (chart.height / 2) * PT };
  const scale = Math.min(room.w / natural.w, room.h / natural.h, 1.5);
  doc.addImage(chart, "PNG", PAGE.margin, PAGE.margin, natural.w * scale, natural.h * scale, undefined, "FAST");
  if (table) {
    const layout = pdfLayout(table);
    for (const page of layout.pages) {
      if (!page.rows.length) continue;
      doc.addPage("a4", layout.landscape ? "landscape" : "portrait");
      doc.addImage(drawPage(table, layout, page), "PNG", PAGE.margin, PAGE.margin, layout.width * PT * layout.scale, page.height * PT * layout.scale, undefined, "FAST");
    }
  }
  return new Uint8Array(doc.output("arraybuffer"));
}

// ---------------------------------------------------------------- the plain table, as a sheet

const THIN = "1px solid #bfbfbf";
/**
 * The plain export's rows (title lines, a header, the day-by-day rows, totals) laid out as a sheet: a header row
 * in bold on grey, thin lines between rows, numbers on the right, columns as wide as their widest entry.
 * `headerRow` is the table's header line; the lines above it and after the table's end are label/value pairs.
 * Numbers go on the right; so do the table's text cells in `rightCols` (figures already written as "$1,234.50").
 */
export function plainSheet(lines: (string | number)[][], headerRow: number, measure: (text: string, bold: boolean) => number, rightCols: number[] = []): RenderedSheet {
  const ncols = Math.max(...lines.map((l) => l.length), 1);
  const widths = Array.from({ length: ncols }, (_, c) =>
    Math.min(260, Math.max(48, ...lines.map((l, ri) => (ri === headerRow || (c > 0 && ri > headerRow) ? measure(String(l[c] ?? ""), ri === headerRow) + 12 : 0)))));
  // The few label lines above and below the table aren't measured, so give their first column room too.
  widths[0] = Math.max(widths[0]!, ...lines.filter((_, ri) => ri !== headerRow).map((l) => Math.min(260, measure(String(l[0] ?? ""), true) + 12)));
  const tableEnd = lines.findIndex((l, ri) => ri > headerRow && l.length === 0);
  return {
    gridlines: false, printGridlines: false,
    cols: widths.map((width, i) => ({ col: i + 1, width })),
    rows: lines.map((l, ri) => {
      const inTable = ri > headerRow && (tableEnd < 0 || ri < tableEnd);
      return {
        row: ri + 1, height: ri === 0 ? 30 : 21,
        cells: Array.from({ length: ncols }, (_, ci) => {
          const v = l[ci] ?? "";
          const look: CellLook = ri === headerRow ? { bold: true, background: "#eef1f6", borderBottom: "1px solid #7f8ea3", borderTop: THIN, valign: "middle" }
            : inTable ? { borderBottom: THIN, valign: "middle" }
            : ri === 0 ? { bold: true, fontSize: 14, valign: "middle" }
            : { bold: ci === 0, valign: "middle" };
          return { row: ri + 1, col: ci + 1, text: String(v), look, rowSpan: 1, colSpan: 1, numeric: typeof v === "number" || ((inTable || ri === headerRow) && rightCols.includes(ci)) };
        }),
      };
    }),
  };
}

/** Text widths for the plain layout, as the canvas will draw them. */
export function canvasMeasure() {
  const ctx = document.createElement("canvas").getContext("2d")!;
  return (text: string, bold: boolean) => { ctx.font = font({ bold }); return ctx.measureText(text).width; };
}
