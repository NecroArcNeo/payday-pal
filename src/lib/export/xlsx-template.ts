import { strFromU8, strToU8 as encode, unzipSync, zipSync } from "fflate";

// Fills values into a copy of the user's own Excel file (.xlsx/.xlsm), keeping everything else exactly as they made
// it: every other sheet, the styles, fonts, colours, borders, merged cells, pictures, column widths, print setup,
// formulas and macros. SheetJS's free edition drops styles when it writes, so this edits the file itself: only the
// filled cells' text changes inside the sheet's XML (the rest of it, and every other file in the workbook, stays byte
// for byte as it was), plus a flag asking Excel to recalculate formulas on open. Each filled cell keeps its own style;
// dates and times become real Excel dates where the cell is formatted as one, and text where it isn't.

/** A value for one cell. Null empties it (keeping its style). */
export type CellValue = string | number | null | { date: string } | { time: string };

export class TemplateError extends Error {}

/** A sheet in the workbook. Only worksheets can be filled (not chart sheets). */
export type TemplateSheet = { name: string; hidden: boolean; fillable: boolean };

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
/** Elements by local name, whatever namespace or prefix the file uses (Excel's own, "strict" files, other programs). */
const byName = (root: Document | Element, name: string) => [...root.getElementsByTagName("*")].filter((e) => e.localName === name);
const attrByLocalName = (e: Element, name: string) => [...e.attributes].find((a) => a.localName === name)?.value ?? null;

function readZip(file: Uint8Array) {
  try {
    return unzipSync(file);
  } catch {
    throw new TemplateError("That isn't an Excel file (.xlsx). Older .xls files need saving as .xlsx in Excel first.");
  }
}

/** The workbook's sheets in tab order, each with the file inside the zip that holds it. */
function sheetEntries(files: Record<string, Uint8Array>) {
  const wbRaw = files["xl/workbook.xml"], relsRaw = files["xl/_rels/workbook.xml.rels"];
  if (!wbRaw || !relsRaw) throw new TemplateError("That isn't an Excel workbook (.xlsx).");
  const rels = new Map(byName(xml(strFromU8(relsRaw)), "Relationship").map((r) => [r.getAttribute("Id"), r]));
  return byName(xml(strFromU8(wbRaw)), "sheet").map((s) => {
    const rel = rels.get(attrByLocalName(s, "id"));
    const target = rel?.getAttribute("Target") ?? "";
    // Targets are relative to xl/ unless they start with "/".
    const path = target ? (target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`) : "";
    const state = s.getAttribute("state");
    return { name: s.getAttribute("name") ?? "", hidden: state === "hidden" || state === "veryHidden", fillable: /\/worksheet$/.test(rel?.getAttribute("Type") ?? "") && !!files[path], path };
  });
}

/** The workbook's sheets, in tab order. */
export function templateSheets(file: Uint8Array): TemplateSheet[] {
  return sheetEntries(readZip(file)).map(({ name, hidden, fillable }) => ({ name, hidden, fillable }));
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
  for (const f of byName(doc, "numFmt")) custom.set(Number(f.getAttribute("numFmtId")), formatKind(f.getAttribute("formatCode") ?? ""));
  const xfs = byName(doc, "cellXfs")[0];
  if (!xfs) return [];
  return [...xfs.children].filter((x) => x.localName === "xf").map((x) => { const id = Number(x.getAttribute("numFmtId") ?? 0); return custom.get(id) ?? BUILTIN[id] ?? "other"; });
}

const escapeXml = (s: string) => s
  // Characters XML can't hold at all.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const attrOf = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
const withoutAttr = (tag: string, name: string) => tag.replace(new RegExp(`\\s${name}="[^"]*"`), "");

/**
 * Changes only the listed cells of a worksheet's XML text and returns the new text, leaving every other character as
 * it was. `p` is the prefix the sheet uses for its elements ("" or "x:"). Returns whether a formula was overwritten.
 */
function spliceCells(text: string, cells: Map<string, CellValue>, kinds: Kind[]): { text: string; formulas: boolean } {
  const open = /<((?:\w+:)?)sheetData\b[^>]*?(\/?)>/.exec(text);
  if (!open) throw new TemplateError("The sheet couldn't be read.");
  const p = open[1]!;
  let start = open.index + open[0].length;
  let end: number;
  if (open[2]) {
    // <sheetData/>: give it room for rows.
    text = `${text.slice(0, open.index)}<${p}sheetData>${`</${p}sheetData>`}${text.slice(start)}`;
    start = open.index + `<${p}sheetData>`.length;
    end = start;
  } else {
    end = text.indexOf(`</${p}sheetData>`, start);
    if (end < 0) throw new TemplateError("The sheet couldn't be read.");
  }

  // A merged block shows only its top-left cell, so a value aimed anywhere in it goes there.
  const merges = [...text.matchAll(/<(?:\w+:)?mergeCell\b[^>]*\bref="([A-Z]+\d+):([A-Z]+\d+)"/g)].map((m) => [parseAddress(m[1]!)!, parseAddress(m[2]!)!] as const);
  const byRow = new Map<number, Map<number, CellValue>>();
  for (const [ref, value] of cells) {
    let at = parseAddress(ref);
    if (!at) throw new TemplateError(`"${ref}" isn't a cell address.`);
    const m = merges.find(([a, b]) => at!.row >= a.row && at!.row <= b.row && at!.col >= a.col && at!.col <= b.col);
    if (m) at = m[0];
    if (!byRow.has(at.row)) byRow.set(at.row, new Map());
    byRow.get(at.row)!.set(at.col, value);
  }

  let formulas = false;
  const cellXml = (ref: string, oldTag: string | null, oldInner: string, value: CellValue) => {
    if (/<(?:\w+:)?f\b[^>]*\bt="shared"[^>]*\bref="/.test(oldInner)) {
      throw new TemplateError(`Cell ${ref} holds a formula that other cells copy, so it can't be filled. Pick another cell for that value, or clear the formula in Excel.`);
    }
    if (/<(?:\w+:)?f\b/.test(oldInner)) formulas = true;
    // Keep the cell's own attributes (its style above all); only its type changes with the new value.
    let tag = oldTag ? withoutAttr(oldTag.replace(/\s*\/?>$/, ""), "t") : `<${p}c r="${ref}"`;
    const kind = kinds[Number(attrOf(tag, "s") ?? 0)] ?? "other";
    let v: string | number | null;
    if (value !== null && typeof value === "object") {
      const asDate = "date" in value;
      const text = asDate ? value.date : value.time;
      // A date or time where the cell shows one; otherwise as text, so it doesn't appear as a bare number.
      v = kind === "other" ? text : asDate ? dateSerial(text) : timeSerial(text);
    } else v = value;
    if (v === null || v === "") return `${tag}/>`;
    if (typeof v === "number") return `${tag}><${p}v>${v}</${p}v></${p}c>`;
    tag += ` t="inlineStr"`;
    return `${tag}><${p}is><${p}t xml:space="preserve">${escapeXml(v)}</${p}t></${p}is></${p}c>`;
  };

  const rowRe = new RegExp(`<${p}row\\b[^>]*?(?:/>|>[\\s\\S]*?</${p}row>)`, "g");
  const cellRe = new RegExp(`(<${p}c\\b[^>]*?)(?:/>|>([\\s\\S]*?)</${p}c>)`, "g");
  const data = text.slice(start, end);
  const rows = [...data.matchAll(rowRe)].map((m) => ({ at: m.index!, text: m[0], r: Number(attrOf(m[0].slice(0, m[0].indexOf(">") + 1), "r")) }));

  const editRow = (rowText: string, r: number, wanted: Map<number, CellValue>) => {
    const selfClosing = /^<[^>]*\/>$/.test(rowText);
    const openTag = selfClosing ? rowText.replace(/\s*\/>$/, ">") : rowText.slice(0, rowText.indexOf(">") + 1);
    const inner = selfClosing ? "" : rowText.slice(openTag.length, rowText.length - `</${p}row>`.length);
    const found = [...inner.matchAll(cellRe)].map((m) => ({ at: m.index!, len: m[0].length, tag: `${m[1]!}>`, inner: m[2] ?? "", col: parseAddress(attrOf(m[1]!, "r") ?? "")?.col ?? 0 }));
    let out = inner;
    let added = false;
    // From the right, so earlier positions stay valid.
    for (const col of [...wanted.keys()].sort((a, b) => b - a)) {
      const ref = `${colLetters(col)}${r}`;
      const hit = found.find((c) => c.col === col);
      if (hit) {
        out = out.slice(0, hit.at) + cellXml(ref, hit.tag, hit.inner, wanted.get(col)!) + out.slice(hit.at + hit.len);
        continue;
      }
      // A new cell goes before the first cell to its right, keeping the row in column order as Excel requires.
      const after = found.filter((c) => c.col > col).sort((a, b) => a.col - b.col)[0];
      const pos = after ? after.at : out.length;
      // It takes the row's style, if the row has one.
      const rowStyle = /\bcustomFormat="(1|true)"/.test(openTag) ? attrOf(openTag, "s") : null;
      const tag = rowStyle ? `<${p}c r="${ref}" s="${rowStyle}">` : null;
      out = out.slice(0, pos) + cellXml(ref, tag, "", wanted.get(col)!) + out.slice(pos);
      added = true;
    }
    // The row's cached column span may no longer cover a new cell; Excel works it out again without one.
    return `${added ? withoutAttr(openTag, "spans") : openTag}${out}</${p}row>`;
  };

  let next = data;
  // From the bottom, so earlier positions stay valid.
  const targets = [...byRow.keys()].sort((a, b) => b - a);
  for (const r of targets) {
    const wanted = byRow.get(r)!;
    const row = rows.find((x) => x.r === r);
    if (row) {
      next = next.slice(0, row.at) + editRow(row.text, r, wanted) + next.slice(row.at + row.text.length);
      continue;
    }
    const after = rows.filter((x) => x.r > r).sort((a, b) => a.r - b.r)[0];
    const pos = after ? after.at : next.length;
    next = next.slice(0, pos) + editRow(`<${p}row r="${r}"/>`, r, wanted) + next.slice(pos);
  }
  return { text: text.slice(0, start) + next + text.slice(end), formulas };
}

/** Asks Excel to recalculate every formula on open (the template's totals, say), changing nothing else in workbook.xml. */
function recalcOnOpen(text: string) {
  const calc = /<((?:\w+:)?)calcPr\b([^>]*?)(\/?)>/.exec(text);
  if (calc) {
    if (/\bfullCalcOnLoad="(1|true)"/.test(calc[2]!)) return text;
    const tag = `<${calc[1]}calcPr${withoutAttr(calc[2]!, "fullCalcOnLoad")} fullCalcOnLoad="1"${calc[3]}>`;
    return text.slice(0, calc.index) + tag + text.slice(calc.index + calc[0].length);
  }
  const p = /<((?:\w+:)?)workbook\b/.exec(text)?.[1] ?? "";
  // Excel insists on the schema's element order: calcPr comes before these.
  const next = new RegExp(`<${p}(oleSize|customWorkbookViews|pivotCaches|smartTagPr|smartTagTypes|webPublishing|fileRecoveryPr|webPublishObjects|extLst)\\b|</${p}workbook>`).exec(text);
  if (!next) return text;
  return `${text.slice(0, next.index)}<${p}calcPr fullCalcOnLoad="1"/>${text.slice(next.index)}`;
}

/**
 * A copy of `file` with `cells` (keyed "B3") written into the sheet named `sheet` (or the first worksheet). Only those
 * cells change, plus the recalculate-on-open flag (and Excel's formula index, dropped when a formula was overwritten).
 * Throws TemplateError for files it can't fill.
 */
export function fillTemplate(file: Uint8Array, sheet: string | null, cells: Map<string, CellValue>): Uint8Array {
  const files = readZip(file);
  const sheets = sheetEntries(files);
  const entry = sheet === null ? sheets.find((s) => s.fillable) : sheets.find((s) => s.name === sheet);
  if (!entry) throw new TemplateError(sheet === null ? "The template has no worksheet to fill." : `The template has no sheet called "${sheet}".`);
  if (!entry.fillable) throw new TemplateError(`"${entry.name}" is a chart sheet, which can't hold values. Pick another sheet.`);

  const { text, formulas } = spliceCells(strFromU8(files[entry.path]!), cells, styleKinds(files));
  const out: Record<string, Uint8Array> = { ...files, [entry.path]: strToU8(text), "xl/workbook.xml": strToU8(recalcOnOpen(strFromU8(files["xl/workbook.xml"]!))) };
  if (formulas && out["xl/calcChain.xml"]) {
    // Excel's index of formula cells now lists one that isn't; it rebuilds the index without complaint when it's gone.
    delete out["xl/calcChain.xml"];
    out["[Content_Types].xml"] = strToU8(strFromU8(out["[Content_Types].xml"]!).replace(/<Override[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/, ""));
    out["xl/_rels/workbook.xml.rels"] = strToU8(strFromU8(out["xl/_rels/workbook.xml.rels"]!).replace(/<Relationship[^>]*Target="[^"]*calcChain\.xml"[^>]*\/>/, ""));
  }
  return zipSync(out);
}
