import * as XLSX from "xlsx";
import { MAX_ROWS, readSheet, type Cell, type Sheet } from "./parse";

// Rows pasted from the clipboard, read into the same Sheet the Import page reads from a file, so pasting gets the
// whole import (column mapping, header row, date order, duplicate check, backup) with nothing new to learn.
// Excel, Google Sheets, LibreOffice, Numbers, Word and web pages put an HTML <table> on the clipboard as well as
// text; the table is read first (cells holding tabs or line breaks stay whole). Otherwise the text is split by
// whichever separator gives the rows a steady number of columns: tabs, commas, semicolons, pipes (Markdown or
// plain-text tables), or runs of 2+ spaces (columns lined up in a PDF or an email). Every cell stays text, so dates
// are read with the import's own date order, never guessed by SheetJS.

/** The sheet's name on the Import page (and in its remembered mappings: the same layout pasted again maps itself). */
export const PASTED = "Pasted rows";

export function readPasted(text: string, html = ""): Sheet | null {
  const sheet = (/<table[\s>]/i.test(html) && fromHtml(html)) || fromText(text);
  return sheet && sheet.grid.some((row) => row.some((c) => c.text)) ? sheet : null;
}

/** True when the paste is more than a single value (one value pasted with nothing focused isn't a set of rows). */
export const isRows = (sheet: Sheet) => sheet.grid.flat().filter((c) => c.text).length > 1;

function fromHtml(html: string): Sheet | null {
  try {
    const wb = XLSX.read(html, { type: "string", raw: true, cellDates: false });
    const ws = wb.Sheets[wb.SheetNames[0] ?? ""];
    if (!ws) return null;
    const s = readSheet(PASTED, ws);
    // Rows and columns count from the paste's first cell, not wherever the table happened to start.
    return s.grid.length ? { ...s, rowOffset: 0, colOffset: 0 } : null;
  } catch {
    return null;
  }
}

type Splitter = (line: string) => string[];
const SEPARATORS: Splitter[] = [
  (l) => l.split(/ {2,}|\t/),
  (l) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|"),
];

function fromText(text: string): Sheet | null {
  let clean = text.replace(/\r\n?/g, "\n");
  if (clean.charCodeAt(0) === 0xfeff) clean = clean.slice(1); // the byte-order mark some apps put first
  if (!clean.trim()) return null;
  let rows: string[][];
  if (clean.includes("\t")) rows = delimited(clean, "\t");
  else {
    const lines = clean.split("\n").filter((l) => l.trim() && !/^[\s|:+-]+$/.test(l)); // drop "|---|---|" lines
    const tries = [delimited(clean, ","), delimited(clean, ";"), ...SEPARATORS.map((split) => lines.map(split))];
    rows = tries.reduce((best, t) => (steadiness(t) > steadiness(best) ? t : best), lines.map((l) => [l]));
  }
  const grid: Cell[][] = rows.slice(0, MAX_ROWS + 50).map((r) => r.map((t) => ({ text: t.trim() })));
  while (grid.length && grid[grid.length - 1]!.every((c) => !c.text)) grid.pop();
  const width = grid.reduce((w, r) => Math.max(w, r.reduce((n, c, j) => (c.text ? j + 1 : n), 0)), 0);
  return { name: PASTED, rowOffset: 0, colOffset: 0, grid: grid.map((r) => [...r, ...Array.from({ length: Math.max(0, width - r.length) }, () => ({ text: "" }))].slice(0, width)), width };
}

/**
 * How well a split fits: the number of columns most rows have, times how many rows have it. A single column scores 0,
 * so any separator that really splits the rows wins over taking each line whole.
 */
function steadiness(rows: string[][]): number {
  const counts = new Map<number, number>();
  for (const r of rows) {
    const n = r.filter((c) => c.trim()).length ? r.length : 0;
    if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  let best = 0;
  for (const [cols, times] of counts) if (cols > 1) best = Math.max(best, times * 2 >= rows.length ? cols * times : 0);
  return best;
}

/**
 * Splits text on `sep` the way spreadsheets write it: a cell starting with a quote runs to its closing quote (so it
 * can hold the separator or line breaks), and "" inside it is one quote.
 */
export function delimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  let quoted = false;
  let atStart = true;
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"' && atStart) { quoted = true; atStart = false; i++; continue; }
    if (ch === sep) { row.push(cell); cell = ""; atStart = true; i++; continue; }
    if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; atStart = true; i++; continue; }
    cell += ch; atStart = false; i++;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

// ---------------------------------------------------------------- handing a paste to the Import page

let handed: Sheet | null = null;
/** Time records hands its paste over before opening Import, which takes it once (`takePasted`). */
export function handOffPasted(sheet: Sheet) { handed = sheet; }
export function takePasted(): Sheet | null { const s = handed; handed = null; return s; }
