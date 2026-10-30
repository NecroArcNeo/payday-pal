import * as XLSX from "xlsx";
import { strFromU8 } from "fflate";
import { recalculate } from "./formula";
import { byName, parseAddress, readZip, sheetEntries, xml } from "./xlsx-template";

// Lays a template's sheet out the way Excel shows it, so the editor can draw it: each cell's text (with its number
// format applied, by SheetJS) and its look, read from the file's styles: fill, font, borders, alignment, plus
// column widths, row heights, merged blocks and hidden rows and columns. Read-only; the file isn't changed.

type Maybe<T> = T | undefined;
export type CellLook = {
  background?: Maybe<string>; color?: Maybe<string>; bold?: Maybe<boolean>; italic?: Maybe<boolean>; underline?: Maybe<boolean>; strike?: Maybe<boolean>;
  fontSize?: Maybe<number>; fontFamily?: Maybe<string>; align?: Maybe<"left" | "center" | "right" | "justify">; valign?: Maybe<"top" | "middle" | "bottom">; wrap?: Maybe<boolean>;
  borderTop?: Maybe<string>; borderRight?: Maybe<string>; borderBottom?: Maybe<string>; borderLeft?: Maybe<string>;
};
export type RenderedCell = { row: number; col: number; text: string; look: CellLook; rowSpan: number; colSpan: number; numeric: boolean };
/** Rows and columns are 1-based sheet numbers; `rows` and `cols` list only the visible ones. */
export type RenderedSheet = {
  cols: { col: number; width: number }[]; rows: { row: number; height: number; cells: RenderedCell[] }[];
  /** Gridlines shown on screen, and printed (Excel prints them only when the sheet's page setup asks). */
  gridlines: boolean; printGridlines?: boolean;
};

// Excel's 64 indexed colours (the old palette, still used by some files).
const INDEXED = ["000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF", "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF",
  "800000", "008000", "000080", "808000", "800080", "008080", "C0C0C0", "808080", "9999FF", "993366", "FFFFCC", "CCFFFF", "660066", "FF8080", "0066CC", "CCCCFF",
  "000080", "FF00FF", "FFFF00", "00FFFF", "800080", "800000", "008080", "0000FF", "00CCFF", "CCFFFF", "CCFFCC", "FFFF99", "99CCFF", "FF99CC", "CC99FF", "FFCC99",
  "3366FF", "33CCCC", "99CC00", "FFCC00", "FF9900", "FF6600", "666699", "969696", "003366", "339966", "003300", "333300", "993300", "993366", "333399", "333333"];
// Office's default theme, for files without one.
const DEFAULT_THEME = ["FFFFFF", "000000", "E7E6E6", "44546A", "4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47", "0563C1", "954F72"];

/** The theme's colours in the order cell styles number them: light 1, dark 1, light 2, dark 2, accents 1–6, links. */
function themeColors(files: Record<string, Uint8Array>): string[] {
  const name = Object.keys(files).find((f) => /^xl\/theme\/theme\d*\.xml$/.test(f));
  if (!name) return DEFAULT_THEME;
  const scheme = byName(xml(strFromU8(files[name]!)), "clrScheme")[0];
  if (!scheme) return DEFAULT_THEME;
  const value = (tag: string) => {
    const el = [...scheme.children].find((c) => c.localName === tag);
    const inner = el?.firstElementChild;
    return (inner?.getAttribute("lastClr") ?? inner?.getAttribute("val") ?? "").toUpperCase();
  };
  const order = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];
  return order.map((t, i) => value(t) || DEFAULT_THEME[i]!);
}

/** Excel's tint: lightens (positive) or darkens (negative) a colour's luminance. */
function tinted(hex: string, tint: number) {
  if (!tint) return hex;
  let r = parseInt(hex.slice(0, 2), 16) / 255, g = parseInt(hex.slice(2, 4), 16) / 255, b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const f = (p: number, q: number, t: number) => { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  if (s === 0) r = g = b = l;
  else { const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q; r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3); }
  return [r, g, b].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
}

function colorOf(el: Element | undefined, theme: string[]): string | undefined {
  if (!el || el.getAttribute("auto") === "1") return undefined;
  const tint = Number(el.getAttribute("tint") ?? 0);
  const rgb = el.getAttribute("rgb"), th = el.getAttribute("theme"), ix = el.getAttribute("indexed");
  let hex: string | undefined;
  if (rgb) hex = rgb.slice(-6);
  else if (th !== null) hex = theme[Number(th)];
  else if (ix !== null) hex = INDEXED[Number(ix)];
  return hex ? `#${tinted(hex.toUpperCase(), tint)}` : undefined;
}

const child = (el: Element | undefined, name: string) => (el ? [...el.children].find((c) => c.localName === name) : undefined);
const BORDER: Record<string, string> = {
  thin: "1px solid", hair: "1px solid", dotted: "1px dotted", dashed: "1px dashed", dashDot: "1px dashed", dashDotDot: "1px dashed",
  medium: "2px solid", mediumDashed: "2px dashed", mediumDashDot: "2px dashed", mediumDashDotDot: "2px dashed", slantDashDot: "2px dashed",
  thick: "3px solid", double: "3px double",
};

/** Each cell style's look, by style index. */
function styleLooks(files: Record<string, Uint8Array>): CellLook[] {
  const raw = files["xl/styles.xml"];
  if (!raw) return [];
  const doc = xml(strFromU8(raw));
  const theme = themeColors(files);
  const list = (parent: string, name: string) => [...(byName(doc, parent)[0]?.children ?? [])].filter((c) => c.localName === name);
  const fonts = list("fonts", "font").map((f): CellLook => {
    const has = (n: string) => { const e = child(f, n); return !!e && e.getAttribute("val") !== "0" && e.getAttribute("val") !== "false"; };
    const size = Number(child(f, "sz")?.getAttribute("val") ?? 11);
    return {
      bold: has("b"), italic: has("i"), underline: !!child(f, "u") && child(f, "u")!.getAttribute("val") !== "none", strike: has("strike"),
      fontSize: size, fontFamily: child(f, "name")?.getAttribute("val") ?? undefined, color: colorOf(child(f, "color"), theme),
    };
  });
  const fills = list("fills", "fill").map((f) => {
    const pattern = child(f, "patternFill");
    if (pattern) {
      const type = pattern.getAttribute("patternType");
      if (!type || type === "none") return undefined;
      // A pattern other than solid is drawn as its foreground colour: close enough to read the layout.
      return colorOf(child(pattern, "fgColor"), theme) ?? (type === "solid" ? undefined : colorOf(child(pattern, "bgColor"), theme));
    }
    const stop = child(child(f, "gradientFill"), "stop");
    return colorOf(child(stop, "color"), theme);
  });
  const borders = list("borders", "border").map((b) => {
    const side = (...names: string[]) => {
      const e = names.map((n) => child(b, n)).find((x) => x?.getAttribute("style"));
      const style = e?.getAttribute("style");
      return style && BORDER[style] ? `${BORDER[style]} ${colorOf(child(e, "color"), theme) ?? "#000"}` : undefined;
    };
    return { borderTop: side("top"), borderBottom: side("bottom"), borderLeft: side("left", "start"), borderRight: side("right", "end") };
  });
  return list("cellXfs", "xf").map((x) => {
    const a = child(x, "alignment");
    const h = a?.getAttribute("horizontal");
    const v = a?.getAttribute("vertical");
    return {
      ...fonts[Number(x.getAttribute("fontId") ?? 0)],
      background: fills[Number(x.getAttribute("fillId") ?? 0)],
      ...borders[Number(x.getAttribute("borderId") ?? 0)],
      align: h === "center" || h === "centerContinuous" ? "center" : h === "right" ? "right" : h === "left" ? "left" : h === "justify" || h === "distributed" ? "justify" : undefined,
      valign: v === "top" ? "top" : v === "center" ? "middle" : v === "bottom" ? "bottom" : undefined,
      wrap: a?.getAttribute("wrapText") === "1" || a?.getAttribute("wrapText") === "true",
    };
  });
}

/** Excel column width (characters of the default font) to pixels, as Excel draws it at 100%. */
const colPx = (chars: number) => Math.round(chars * 7 + 5);
/** Row height in points to pixels. */
const rowPx = (pt: number) => Math.round((pt * 4) / 3);

/** The first print area set for the sheet at `index` (tab order), from the workbook's defined names. */
function printArea(files: Record<string, Uint8Array>, index: number) {
  const wb = files["xl/workbook.xml"];
  if (!wb) return null;
  const name = byName(xml(strFromU8(wb)), "definedName").find((d) => d.getAttribute("name") === "_xlnm.Print_Area" && Number(d.getAttribute("localSheetId")) === index);
  const first = (name?.textContent ?? "").split(",")[0]!;
  const [a, b] = first.slice(first.lastIndexOf("!") + 1).replace(/\$/g, "").split(":").map((x) => parseAddress(x ?? ""));
  return a && b ? { r1: a.row, c1: a.col, r2: b.row, c2: b.col } : null;
}

/**
 * The sheet named `sheet`, laid out for drawing: at least `minRows` × `minCols`, at most `maxRows` × `maxCols`.
 * For a PDF: `recalculate` works the formulas out again (Excel would on opening; throws if one can't be), and
 * `printArea` keeps to the sheet's print area when it has one.
 */
export function renderSheet(file: Uint8Array, sheet: string, opts: { minRows?: number; minCols?: number; maxRows?: number; maxCols?: number; recalculate?: Date; printArea?: boolean } = {}): RenderedSheet {
  const { minRows = 30, minCols = 10, maxRows = 120, maxCols = 40 } = opts;
  const files = readZip(file);
  const entries = sheetEntries(files);
  const entry = entries.find((s) => s.name === sheet && s.fillable);
  if (!entry) return { cols: [], rows: [], gridlines: true };
  const doc = xml(strFromU8(files[entry.path]!));
  const looks = styleLooks(files);
  // The text, with number formats applied. A file SheetJS can't read still shows its design, without text.
  let ws: XLSX.WorkSheet | undefined;
  if (opts.recalculate) {
    // Every sheet, as formulas may refer to others; a formula that can't be worked out stops the export.
    const wb = XLSX.read(file, { type: "array", cellNF: true });
    recalculate(wb, sheet, opts.recalculate);
    ws = wb.Sheets[sheet];
  } else {
    try { ws = XLSX.read(file, { type: "array", sheets: [sheet], sheetRows: maxRows }).Sheets[sheet]; } catch { ws = undefined; }
  }
  const area = opts.printArea ? printArea(files, entries.indexOf(entry)) : null;

  const fmt = byName(doc, "sheetFormatPr")[0];
  const defaultWidth = Number(fmt?.getAttribute("defaultColWidth") ?? 0) || Number(fmt?.getAttribute("baseColWidth") ?? 8) + 0.43;
  const defaultHeight = Number(fmt?.getAttribute("defaultRowHeight") ?? 15) || 15;
  const gridlines = byName(doc, "sheetView")[0]?.getAttribute("showGridLines") !== "0";
  const printGridlines = ["1", "true"].includes(byName(doc, "printOptions")[0]?.getAttribute("gridLines") ?? "");

  // Columns: width, hidden, default style.
  const colInfo = new Map<number, { width: number | undefined; hidden: boolean; style: number | undefined }>();
  for (const c of byName(doc, "col")) {
    const min = Number(c.getAttribute("min")), max = Math.min(Number(c.getAttribute("max")), maxCols);
    for (let i = min; i <= max; i++) colInfo.set(i, { width: c.getAttribute("width") ? Number(c.getAttribute("width")) : undefined, hidden: c.getAttribute("hidden") === "1" || c.getAttribute("hidden") === "true", style: c.getAttribute("style") ? Number(c.getAttribute("style")) : undefined });
  }
  // Rows and their cells' styles.
  const rowInfo = new Map<number, { height: number | undefined; hidden: boolean; style: number | undefined }>();
  const cellStyle = new Map<string, number>();
  let lastRow = 0, lastCol = 0;
  for (const r of byName(doc, "row")) {
    const n = Number(r.getAttribute("r"));
    if (!n || n > maxRows) continue;
    rowInfo.set(n, { height: r.getAttribute("ht") ? Number(r.getAttribute("ht")) : undefined, hidden: r.getAttribute("hidden") === "1" || r.getAttribute("hidden") === "true", style: r.getAttribute("customFormat") === "1" && r.getAttribute("s") ? Number(r.getAttribute("s")) : undefined });
    for (const c of [...r.children].filter((x) => x.localName === "c")) {
      const at = parseAddress(c.getAttribute("r") ?? "");
      if (!at || at.col > maxCols) continue;
      cellStyle.set(`${at.row}:${at.col}`, Number(c.getAttribute("s") ?? 0));
      lastRow = Math.max(lastRow, at.row);
      lastCol = Math.max(lastCol, at.col);
    }
  }
  const merges = byName(doc, "mergeCell").map((m) => (m.getAttribute("ref") ?? "").split(":").map(parseAddress)).filter((m): m is [NonNullable<ReturnType<typeof parseAddress>>, NonNullable<ReturnType<typeof parseAddress>>] => !!m[0] && !!m[1]);
  for (const [, b] of merges) { lastRow = Math.max(lastRow, b.row); lastCol = Math.max(lastCol, b.col); }
  const rowsTo = Math.min(maxRows, area ? area.r2 : Math.max(minRows, lastRow + 3));
  const colsTo = Math.min(maxCols, area ? area.c2 : Math.max(minCols, lastCol + 2));

  const visibleCols = Array.from({ length: colsTo }, (_, i) => i + 1).filter((c) => !colInfo.get(c)?.hidden && (!area || c >= area.c1));
  const visibleRows = Array.from({ length: rowsTo }, (_, i) => i + 1).filter((r) => !rowInfo.get(r)?.hidden && (!area || r >= area.r1));
  const covered = new Set<string>();
  const spans = new Map<string, { rowSpan: number; colSpan: number }>();
  for (const [a, b] of merges) {
    const rs = visibleRows.filter((r) => r >= a.row && r <= b.row).length, cs = visibleCols.filter((c) => c >= a.col && c <= b.col).length;
    if (!rs || !cs) continue;
    spans.set(`${a.row}:${a.col}`, { rowSpan: rs, colSpan: cs });
    for (let r = a.row; r <= b.row; r++) for (let c = a.col; c <= b.col; c++) if (r !== a.row || c !== a.col) covered.add(`${r}:${c}`);
  }

  return {
    gridlines, printGridlines,
    cols: visibleCols.map((col) => ({ col, width: colPx(colInfo.get(col)?.width ?? defaultWidth) })),
    rows: visibleRows.map((row) => ({
      row,
      height: rowPx(rowInfo.get(row)?.height ?? defaultHeight),
      cells: visibleCols.filter((col) => !covered.has(`${row}:${col}`)).map((col) => {
        const key = `${row}:${col}`;
        const style = cellStyle.get(key) ?? rowInfo.get(row)?.style ?? colInfo.get(col)?.style ?? 0;
        const value = ws?.[XLSX.utils.encode_cell({ r: row - 1, c: col - 1 })] as XLSX.CellObject | undefined;
        const span = spans.get(key) ?? { rowSpan: 1, colSpan: 1 };
        return { row, col, text: value ? String(value.w ?? value.v ?? "") : "", look: looks[style] ?? {}, numeric: value?.t === "n" || value?.t === "d", ...span };
      }),
    })),
  };
}
