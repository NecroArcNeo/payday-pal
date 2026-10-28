import { strFromU8, strToU8 as encode, unzipSync, zipSync } from "fflate";

// Fills values into a copy of the user's own Excel file (.xlsx/.xlsm), so everything else in it stays
// exactly as they made it: fonts, borders, colours, merged cells, logos, column widths, print setup, formulas.
// SheetJS's free edition drops styles when it writes, so this edits the sheet's XML inside the zip instead.
// Each written cell keeps its style; dates and times become real Excel dates where the cell is formatted
// as one, and text where it isn't. Excel recalculates the template's formulas (totals, say) on open.

/** A value for one cell. Null empties it (keeping its style). */
export type CellValue = string | number | null | { date: string } | { time: string };

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export class TemplateError extends Error {}

const CALC_BEFORE = ["oleSize", "customWorkbookViews", "pivotCaches", "smartTagPr", "smartTagTypes", "webPublishing", "fileRecoveryPr", "webPublishObjects", "extLst"];

/** "B12" → { col: 2, row: 12 }. */
export function parseAddress(a: string): { col: number; row: number } | null {
  const m = /^\s*\$?([A-Za-z]{1,3})\$?(\d{1,7})\s*$/.exec(a);
  if (!m) return null;
  return { col: colNumber(m[1]!), row: Number(m[2]) };
}
/** "AB" → 28. */
export function colNumber(letters: string) {
  return [...letters.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
}
/** 28 → "AB". */
export function colLetters(n: number) {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Days since Excel's epoch (1899-12-30), as Excel stores dates. */
const dateSerial = (iso: string) => (Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86_400_000;
/** "09:30" → the fraction of a day Excel stores. */
const timeSerial = (hm: string) => { const [h = 0, m = 0, s = 0] = hm.split(":").map(Number); return (h * 3600 + m * 60 + s) / 86_400; };

/** Encoded text as this window's Uint8Array (a TextEncoder from another realm's fails fflate's check). */
const strToU8 = (text: string) => Uint8Array.from(encode(text));
const xml = (text: string) => new DOMParser().parseFromString(text, "application/xml");
const serialize = (doc: Document) => new XMLSerializer().serializeToString(doc);

/** Paths are relative to xl/ unless they start with "/". */
const resolve = (target: string) => (target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`);

function readZip(file: Uint8Array) {
  try {
    return unzipSync(file);
  } catch {
    throw new TemplateError("That isn't an Excel file (.xlsx). Older .xls files need saving as .xlsx in Excel first.");
  }
}

/** The worksheets' names, in order. */
export function templateSheets(file: Uint8Array): string[] {
  const files = readZip(file);
  const wb = files["xl/workbook.xml"];
  if (!wb) throw new TemplateError("That isn't an Excel workbook (.xlsx).");
  return [...xml(strFromU8(wb)).getElementsByTagNameNS(MAIN, "sheet")].map((s) => s.getAttribute("name") ?? "");
}

type Kind = "date" | "time" | "other";
const BUILTIN: Record<number, Kind> = { 14: "date", 15: "date", 16: "date", 17: "date", 22: "date", 18: "time", 19: "time", 20: "time", 21: "time", 45: "time", 46: "time", 47: "time" };
/** Whether a number format shows a date, a time, or neither. */
export function formatKind(code: string): Kind {
  const bare = code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, "").toLowerCase();
  if (/[yd]/.test(bare) || /(^|[^h:])m{3,}/.test(bare)) return "date";
  if (/[hs]/.test(bare)) return "time";
  return "other";
}
/** For each cell style index, what kind of value its number format shows. */
function styleKinds(files: Record<string, Uint8Array>): Kind[] {
  const raw = files["xl/styles.xml"];
  if (!raw) return [];
  const doc = xml(strFromU8(raw));
  const custom = new Map<number, Kind>();
  for (const f of doc.getElementsByTagNameNS(MAIN, "numFmt")) custom.set(Number(f.getAttribute("numFmtId")), formatKind(f.getAttribute("formatCode") ?? ""));
  const xfs = doc.getElementsByTagNameNS(MAIN, "cellXfs")[0];
  if (!xfs) return [];
  return [...xfs.getElementsByTagNameNS(MAIN, "xf")].map((x) => { const id = Number(x.getAttribute("numFmtId") ?? 0); return custom.get(id) ?? BUILTIN[id] ?? "other"; });
}

/**
 * A copy of `file` with `cells` (keyed "B3") written into the sheet named `sheet` (or the first one).
 * Throws TemplateError for files it can't fill.
 */
export function fillTemplate(file: Uint8Array, sheet: string | null, cells: Map<string, CellValue>): Uint8Array {
  const files = readZip(file);
  const wbRaw = files["xl/workbook.xml"], relsRaw = files["xl/_rels/workbook.xml.rels"];
  if (!wbRaw || !relsRaw) throw new TemplateError("That isn't an Excel workbook (.xlsx).");
  const wb = xml(strFromU8(wbRaw));
  const sheets = [...wb.getElementsByTagNameNS(MAIN, "sheet")];
  const entry = (sheet === null ? sheets[0] : sheets.find((s) => s.getAttribute("name") === sheet));
  if (!entry) throw new TemplateError(`The template has no sheet called "${sheet}".`);
  const rid = entry.getAttributeNS(REL, "id");
  const rel = [...xml(strFromU8(relsRaw)).getElementsByTagName("Relationship")].find((r) => r.getAttribute("Id") === rid);
  const path = rel && resolve(rel.getAttribute("Target") ?? "");
  const sheetRaw = path ? files[path] : undefined;
  if (!path || !sheetRaw) throw new TemplateError(`The sheet "${entry.getAttribute("name")}" couldn't be read.`);

  const doc = xml(strFromU8(sheetRaw));
  const data = doc.getElementsByTagNameNS(MAIN, "sheetData")[0];
  if (!data) throw new TemplateError("The sheet couldn't be read.");
  const kinds = styleKinds(files);
  const el = (name: string) => doc.createElementNS(MAIN, name);

  const rows = new Map<number, Element>();
  for (const r of data.getElementsByTagNameNS(MAIN, "row")) rows.set(Number(r.getAttribute("r")), r);
  const rowAt = (n: number) => {
    let row = rows.get(n);
    if (row) return row;
    row = el("row");
    row.setAttribute("r", String(n));
    const after = [...rows.keys()].sort((a, b) => a - b).find((k) => k > n);
    data.insertBefore(row, after === undefined ? null : rows.get(after)!);
    rows.set(n, row);
    return row;
  };
  const cellAt = (row: Element, ref: string, col: number) => {
    let before: Element | null = null;
    for (const c of row.getElementsByTagNameNS(MAIN, "c")) {
      const at = parseAddress(c.getAttribute("r") ?? "")?.col ?? 0;
      if (at === col) return c;
      if (at > col) { before = c; break; }
    }
    const c = el("c");
    c.setAttribute("r", ref);
    // A new cell takes its row's style, if the row has one.
    const rowStyle = row.getAttribute("s");
    if (rowStyle && row.getAttribute("customFormat") === "1") c.setAttribute("s", rowStyle);
    row.insertBefore(c, before);
    // The row's cached column span may no longer cover it; Excel works it out again without one.
    row.removeAttribute("spans");
    return c;
  };

  for (const [ref, value] of cells) {
    const at = parseAddress(ref);
    if (!at) throw new TemplateError(`"${ref}" isn't a cell address.`);
    const address = `${colLetters(at.col)}${at.row}`;
    const c = cellAt(rowAt(at.row), address, at.col);
    while (c.firstChild) c.removeChild(c.firstChild);
    c.removeAttribute("t");
    const kind = kinds[Number(c.getAttribute("s") ?? 0)] ?? "other";
    let v: string | number | null;
    if (value !== null && typeof value === "object") {
      const asDate = "date" in value;
      const text = asDate ? value.date : value.time;
      // A date or time where the cell shows one; otherwise as text, so it doesn't appear as a bare number.
      v = kind === "other" ? text : asDate ? dateSerial(text) : timeSerial(text);
    } else v = value;
    if (v === null || v === "") continue;
    if (typeof v === "number") {
      const n = el("v");
      n.textContent = String(v);
      c.appendChild(n);
    } else {
      c.setAttribute("t", "inlineStr");
      const is = el("is"), t = el("t");
      t.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
      t.textContent = v;
      is.appendChild(t);
      c.appendChild(is);
    }
  }

  const out: Record<string, Uint8Array> = { ...files, [path]: strToU8(serialize(doc)) };
  // Written cells may have held formulas; drop Excel's formula index (it rebuilds it) and recalculate on open.
  delete out["xl/calcChain.xml"];
  const ct = out["[Content_Types].xml"];
  if (ct) out["[Content_Types].xml"] = strToU8(strFromU8(ct).replace(/<Override[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/, ""));
  out["xl/_rels/workbook.xml.rels"] = strToU8(strFromU8(relsRaw).replace(/<Relationship[^>]*Target="[^"]*calcChain\.xml"[^>]*\/>/, ""));
  let calc = wb.getElementsByTagNameNS(MAIN, "calcPr")[0];
  if (!calc) {
    // Excel insists on the schema's element order: calcPr comes before these.
    calc = wb.createElementNS(MAIN, "calcPr");
    const next = [...wb.documentElement.children].find((e) => CALC_BEFORE.includes(e.localName));
    wb.documentElement.insertBefore(calc, next ?? null);
  }
  calc.setAttribute("fullCalcOnLoad", "1");
  out["xl/workbook.xml"] = strToU8(serialize(wb));
  return zipSync(out);
}
