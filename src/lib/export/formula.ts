import * as XLSX from "xlsx";
import { colNumber, TemplateError } from "./xlsx-template";

// Works out a filled template's formulas, for exports Excel doesn't open (PDF). Excel recalculates a file when it
// opens it, so the cached results in a template are the old ones; a PDF has to show the new ones itself.
// It covers what timesheets use (arithmetic, comparisons, SUM/IF/ROUND and friends, dates and times) and refuses
// anything else with the cell named, so a PDF never shows a stale or guessed total.

/** An Excel error value, such as #DIV/0!: shown in the cell, as Excel would. */
export class XlError { constructor(readonly code: string) {} }
type Scalar = number | string | boolean | null | XlError;
type Range = { sheet: string; r1: number; c1: number; r2: number; c2: number };
type Val = Scalar | Range;
/** A formula this calculator can't work out (a function it doesn't know, a named range…). */
class Unsupported extends Error {}

const VALUE = new XlError("#VALUE!"), DIV0 = new XlError("#DIV/0!"), NA = new XlError("#N/A"), NUM = new XlError("#NUM!");
const isRange = (v: Val): v is Range => typeof v === "object" && v !== null && !(v instanceof XlError);

// ---------------------------------------------------------------- reading formulas

type Node =
  | { k: "lit"; v: Scalar } | { k: "ref"; r: Range } | { k: "neg"; a: Node } | { k: "pct"; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node } | { k: "fn"; name: string; args: Node[] };

const CELL = String.raw`\$?([A-Za-z]{1,3})\$?(\d+)`;
const SHEET = String.raw`(?:'((?:[^']|'')+)'|([A-Za-z_][\w.]*))!`;
const TOKEN = new RegExp([
  String.raw`(?<ws>\s+)`,
  String.raw`(?<str>"(?:[^"]|"")*")`,
  String.raw`(?<err>#(?:DIV\/0!|VALUE!|REF!|NAME\?|N\/A|NUM!|NULL!))`,
  // A cell or range, maybe on another sheet; or whole columns (A:C) or rows (2:5).
  String.raw`(?<ref>(?:${SHEET})?(?:${CELL}(?::${CELL})?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}|\$?\d+:\$?\d+)(?![\w(]))`,
  String.raw`(?<num>(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)`,
  String.raw`(?<fn>[A-Za-z_][\w.]*)(?=\s*\()`,
  String.raw`(?<name>[A-Za-z_][\w.]*)`,
  String.raw`(?<op><>|<=|>=|[-+*/^&=<>%(),;])`,
].join("|"), "y");

function tokens(src: string) {
  const out: { t: string; v: string; m: RegExpExecArray }[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < src.length) {
    const m = TOKEN.exec(src);
    if (!m) throw new Unsupported(`"${src.slice(TOKEN.lastIndex, TOKEN.lastIndex + 12)}"`);
    const [t, v] = Object.entries(m.groups!).find(([, x]) => x !== undefined)!;
    if (t !== "ws") out.push({ t, v, m });
  }
  return out;
}

function parseRef(text: string, here: string, sheets: Map<string, XLSX.WorkSheet>): Range {
  const at = text.lastIndexOf("!");
  const sheet = at < 0 ? here : text.slice(0, at).replace(/^'|'$/g, "").replace(/''/g, "'");
  const ref = text.slice(at + 1).replace(/\$/g, "").toUpperCase();
  const ws = sheets.get(sheet);
  if (!ws) throw new Unsupported(`a sheet "${sheet}" that isn't in the workbook`);
  const used = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
  const [a, b = a] = ref.split(":") as [string, string?];
  const point = (p: string, end: boolean) => {
    const m = /^([A-Z]*)(\d*)$/.exec(p)!;
    return {
      c: m[1] ? colNumber(m[1]) : end ? used.e.c + 1 : 1,
      r: m[2] ? Number(m[2]) : end ? used.e.r + 1 : 1,
    };
  };
  const p = point(a, false), q = point(b!, true);
  return { sheet, r1: Math.min(p.r, q.r), c1: Math.min(p.c, q.c), r2: Math.max(p.r, q.r), c2: Math.max(p.c, q.c) };
}

function parse(src: string, here: string, sheets: Map<string, XLSX.WorkSheet>): Node {
  const ts = tokens(src.replace(/^=/, ""));
  let i = 0;
  const peek = () => ts[i];
  const take = (v?: string) => {
    const t = ts[i];
    if (!t || (v !== undefined && t.v !== v)) throw new Unsupported(v ? `a missing "${v}"` : "an unfinished formula");
    i++;
    return t;
  };
  const level = (ops: string[], next: () => Node) => () => {
    let a = next();
    while (peek()?.t === "op" && ops.includes(peek()!.v)) { const op = take().v; a = { k: "bin", op, a, b: next() }; }
    return a;
  };
  const primary = (): Node => {
    const t = take();
    if (t.t === "num") return { k: "lit", v: Number(t.v) };
    if (t.t === "str") return { k: "lit", v: t.v.slice(1, -1).replace(/""/g, '"') };
    if (t.t === "err") return { k: "lit", v: new XlError(t.v) };
    if (t.t === "ref") return { k: "ref", r: parseRef(t.v, here, sheets) };
    if (t.t === "name") {
      if (/^(TRUE|FALSE)$/i.test(t.v)) return { k: "lit", v: t.v.toUpperCase() === "TRUE" };
      throw new Unsupported(`the name "${t.v}"`);
    }
    if (t.t === "fn") {
      const name = t.v.toUpperCase().replace(/^(_XLFN\.|_XLWS\.)+/, "");
      take("(");
      const args: Node[] = [];
      if (peek()?.v !== ")") {
        for (;;) {
          // An empty argument, like ROUND(A1,), counts as blank.
          args.push(peek()?.v === "," || peek()?.v === ";" || peek()?.v === ")" ? { k: "lit", v: null } : compare());
          if (peek()?.v === "," || peek()?.v === ";") { take(); continue; }
          break;
        }
      }
      take(")");
      return { k: "fn", name, args };
    }
    if (t.v === "(") { const e = compare(); take(")"); return e; }
    throw new Unsupported(`"${t.v}"`);
  };
  const postfix = (): Node => { let a = primary(); while (peek()?.v === "%") { take(); a = { k: "pct", a }; } return a; };
  // Excel binds a leading minus tighter than ^ (=-2^2 is 4).
  const unary = (): Node => {
    if (peek()?.v === "-") { take(); return { k: "neg", a: unary() }; }
    if (peek()?.v === "+") { take(); return unary(); }
    return postfix();
  };
  const power = level(["^"], unary);
  const product = level(["*", "/"], power);
  const sum = level(["+", "-"], product);
  const concat = level(["&"], sum);
  const compare: () => Node = level(["=", "<>", "<", ">", "<=", ">="], concat);
  const root = compare();
  if (i < ts.length) throw new Unsupported(`"${ts[i]!.v}"`);
  return root;
}

// ---------------------------------------------------------------- values

const general = (n: number) => XLSX.SSF.format("General", n) as string;
function num(v: Scalar): number | XlError {
  if (v instanceof XlError) return v;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null || v === "") return 0;
  const n = Number(v.trim());
  return v.trim() && Number.isFinite(n) ? n : VALUE;
}
function text(v: Scalar): string | XlError {
  if (v instanceof XlError) return v;
  if (typeof v === "number") return general(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return v ?? "";
}
function bool(v: Scalar): boolean | XlError {
  if (v instanceof XlError) return v;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (v === null) return false;
  if (/^true$/i.test(v)) return true;
  if (/^false$/i.test(v)) return false;
  return VALUE;
}
/** Excel's order: numbers, then text (ignoring case), then TRUE/FALSE; a blank is 0, "" or FALSE to match. */
function compareValues(a: Scalar, b: Scalar): number {
  const blank = (x: Scalar, other: Scalar): Scalar => (x !== null ? x : typeof other === "string" ? "" : typeof other === "boolean" ? false : 0);
  const x = blank(a, b), y = blank(b, a);
  const rank = (v: Scalar) => (typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2);
  if (rank(x) !== rank(y)) return rank(x) - rank(y);
  if (typeof x === "string") return x.toLowerCase().localeCompare((y as string).toLowerCase());
  return Number(x) - Number(y);
}
/** Rounds half away from zero, as Excel does, without 1.005 becoming 1.00. */
function round(n: number, digits: number, how: "near" | "up" | "down" = "near") {
  const f = 10 ** digits;
  const x = Number((Math.abs(n) * f).toPrecision(15));
  const r = how === "up" ? Math.ceil(x) : how === "down" ? Math.floor(x) : Math.round(x);
  return (Math.sign(n) * r) / f;
}

// Excel dates: days since 1899-12-30 (serial 60 is the 29 February 1900 that never was).
const DAY = 86_400_000;
const EPOCH = Date.UTC(1899, 11, 30);
const toDate = (serial: number) => new Date(EPOCH + Math.floor(serial < 61 ? serial + 1 : serial) * DAY);
const toSerial = (y: number, m: number, d: number) => { const s = (Date.UTC(y, m - 1, d) - EPOCH) / DAY; return s < 61 ? s - 1 : s; };

/** COUNTIF-style criteria: ">5", "<>x", "=3", "text" (with * and ? wildcards). */
function criteria(c: Scalar): (v: Scalar) => boolean {
  if (typeof c !== "string") return (v) => v !== null && compareValues(v, c) === 0 && typeof v === typeof c;
  const m = /^(<>|<=|>=|=|<|>)?(.*)$/s.exec(c)!;
  const op = m[1] ?? "=", raw = m[2]!;
  const n = raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : null;
  const want: Scalar = n !== null ? n : /^(true|false)$/i.test(raw) ? raw.toLowerCase() === "true" : raw;
  const pattern = typeof want === "string" && /[*?]/.test(want)
    ? new RegExp(`^${want.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i") : null;
  return (v) => {
    if (op === "=" && raw === "") return v === null || v === "";
    if (v === null) return op === "<>";
    const same = pattern ? typeof v === "string" && pattern.test(v) : typeof v === typeof want && compareValues(v, want) === 0;
    if (op === "=") return same;
    if (op === "<>") return !same;
    if (typeof v !== typeof want) return false;
    const d = compareValues(v, want);
    return op === "<" ? d < 0 : op === ">" ? d > 0 : op === "<=" ? d <= 0 : d >= 0;
  };
}

// ---------------------------------------------------------------- working it out

/**
 * Recalculates every formula on `sheet` (and whatever they refer to, on any sheet) in place: each cell's value,
 * type and shown text (`w`, in its number format). Throws a TemplateError naming the cell if one can't be worked out.
 * The workbook must be read with `cellNF: true` (number formats) and without `cellDates`.
 */
export function recalculate(wb: XLSX.WorkBook, sheet: string, today = new Date()) {
  const sheets = new Map(Object.entries(wb.Sheets));
  const done = new Map<string, Scalar>();
  const busy = new Set<string>();

  const cellValue = (s: string, r: number, c: number): Scalar => {
    const ws = sheets.get(s);
    const addr = XLSX.utils.encode_cell({ r: r - 1, c: c - 1 });
    const cell = ws?.[addr] as XLSX.CellObject | undefined;
    if (!cell) return null;
    if (cell.f) return formulaCell(s, addr, cell);
    return stored(cell);
  };
  const stored = (cell: XLSX.CellObject): Scalar =>
    cell.t === "n" ? (cell.v as number) : cell.t === "b" ? (cell.v as boolean) : cell.t === "e" ? new XlError(cell.w ?? "#N/A")
    : cell.t === "s" ? String(cell.v ?? "") : cell.t === "z" ? null : (cell.v as Scalar) ?? null;

  const formulaCell = (s: string, addr: string, cell: XLSX.CellObject): Scalar => {
    const key = `${s}!${addr}`;
    if (done.has(key)) return done.get(key)!;
    if (busy.has(key)) throw new TemplateError(`Cell ${addr} on "${s}" refers back to itself (a circular reference), so the PDF can't work it out.`);
    busy.add(key);
    let v: Scalar;
    try {
      v = scalar(evaluate(parse(cell.f!, s, sheets), s));
    } catch (e) {
      if (e instanceof Unsupported) {
        throw new TemplateError(`Cell ${addr} on "${s}" (=${cell.f}) uses ${e.message}, which the PDF can't work out. Export this template as Excel instead, or simplify that formula.`);
      }
      throw e;
    } finally { busy.delete(key); }
    done.set(key, v);
    // The cell now shows its new value, in its own number format.
    if (v instanceof XlError) { cell.t = "e"; cell.w = v.code; }
    else if (typeof v === "number") { cell.t = "n"; cell.v = v; cell.w = XLSX.SSF.format(String(cell.z ?? "General"), v) as string; }
    else if (typeof v === "boolean") { cell.t = "b"; cell.v = v; cell.w = v ? "TRUE" : "FALSE"; }
    else { cell.t = "s"; cell.v = v ?? ""; cell.w = v ?? ""; }
    return v;
  };

  /** A range used where one value is wanted: its only cell, else #VALUE!. */
  const scalar = (v: Val): Scalar => {
    if (!isRange(v)) return v;
    if (v.r1 === v.r2 && v.c1 === v.c2) return cellValue(v.sheet, v.r1, v.c1);
    return VALUE;
  };
  const cells = (r: Range): Scalar[] => {
    const out: Scalar[] = [];
    for (let row = r.r1; row <= r.r2; row++) for (let col = r.c1; col <= r.c2; col++) out.push(cellValue(r.sheet, row, col));
    return out;
  };
  /** Numbers for SUM and the like: typed-in values are converted; in ranges only numbers count. */
  const numbers = (args: Val[]): number[] | XlError => {
    const out: number[] = [];
    for (const a of args) {
      if (isRange(a)) {
        for (const v of cells(a)) { if (v instanceof XlError) return v; if (typeof v === "number") out.push(v); }
      } else {
        const n = num(a);
        if (n instanceof XlError) return n;
        out.push(n);
      }
    }
    return out;
  };
  const all = (args: Val[]): Scalar[] => args.flatMap((a) => (isRange(a) ? cells(a) : [a]));

  const evaluate = (n: Node, here: string): Val => {
    switch (n.k) {
      case "lit": return n.v;
      case "ref": return n.r;
      case "neg": { const x = num(scalar(evaluate(n.a, here))); return x instanceof XlError ? x : -x; }
      case "pct": { const x = num(scalar(evaluate(n.a, here))); return x instanceof XlError ? x : x / 100; }
      case "bin": {
        const a = scalar(evaluate(n.a, here)), b = scalar(evaluate(n.b, here));
        if (a instanceof XlError) return a;
        if (b instanceof XlError) return b;
        if (n.op === "&") return `${text(a)}${text(b)}`;
        if (["=", "<>", "<", ">", "<=", ">="].includes(n.op)) {
          const d = compareValues(a, b);
          return n.op === "=" ? d === 0 : n.op === "<>" ? d !== 0 : n.op === "<" ? d < 0 : n.op === ">" ? d > 0 : n.op === "<=" ? d <= 0 : d >= 0;
        }
        const x = num(a), y = num(b);
        if (x instanceof XlError) return x;
        if (y instanceof XlError) return y;
        if (n.op === "+") return x + y;
        if (n.op === "-") return x - y;
        if (n.op === "*") return x * y;
        if (n.op === "/") return y === 0 ? DIV0 : x / y;
        const p = x ** y;
        return Number.isFinite(p) ? p : NUM;
      }
      case "fn": return call(n.name, n.args, here);
    }
  };

  const call = (name: string, nodes: Node[], here: string): Val => {
    const arg = (i: number) => (nodes[i] ? evaluate(nodes[i]!, here) : null);
    const sc = (i: number) => scalar(arg(i));
    const n = (i: number, fallback?: number): number | XlError => (nodes[i] === undefined && fallback !== undefined ? fallback : num(sc(i)));
    const args = () => nodes.map((x) => evaluate(x, here));
    const nums = (f: (xs: number[]) => Scalar) => { const xs = numbers(args()); return xs instanceof XlError ? xs : f(xs); };
    const math = (f: (...xs: number[]) => Scalar, count: number, defaults: number[] = []) => {
      const xs: number[] = [];
      for (let i = 0; i < count; i++) { const x = n(i, defaults[i]); if (x instanceof XlError) return x; xs.push(x); }
      return f(...xs);
    };
    const date = (f: (d: Date) => number) => math((s) => (s < 0 ? NUM : f(toDate(s))), 1);
    switch (name) {
      case "SUM": return nums((xs) => xs.reduce((s, x) => s + x, 0));
      case "AVERAGE": return nums((xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : DIV0));
      case "MIN": return nums((xs) => (xs.length ? Math.min(...xs) : 0));
      case "MAX": return nums((xs) => (xs.length ? Math.max(...xs) : 0));
      case "COUNT": return all(args()).filter((v) => typeof v === "number").length;
      case "COUNTA": return all(args()).filter((v) => v !== null).length;
      case "COUNTBLANK": return all(args()).filter((v) => v === null || v === "").length;
      case "PRODUCT": return nums((xs) => xs.reduce((s, x) => s * x, 1));
      case "SUMPRODUCT": {
        const ranges = args();
        if (!ranges.every(isRange)) return VALUE;
        const lists = (ranges as Range[]).map(cells);
        if (lists.some((l) => l.length !== lists[0]!.length)) return VALUE;
        let total = 0;
        for (let i = 0; i < lists[0]!.length; i++) total += lists.reduce((p, l) => p * (typeof l[i] === "number" ? (l[i] as number) : 0), 1);
        return total;
      }
      case "SUMIF": case "COUNTIF": case "AVERAGEIF": {
        const where = arg(0), test = criteria(sc(1));
        if (!isRange(where)) return VALUE;
        const sumOver = name !== "COUNTIF" && nodes[2] ? arg(2) : where;
        if (!isRange(sumOver)) return VALUE;
        const keys = cells(where);
        const vals = cells({ ...sumOver, r2: sumOver.r1 + (where.r2 - where.r1), c2: sumOver.c1 + (where.c2 - where.c1) });
        const hit = keys.map((k, i) => (test(k) ? vals[i] : undefined)).filter((v) => v !== undefined);
        if (name === "COUNTIF") return hit.length;
        const ns = hit.filter((v): v is number => typeof v === "number");
        return name === "SUMIF" ? ns.reduce((s, x) => s + x, 0) : ns.length ? ns.reduce((s, x) => s + x, 0) / ns.length : DIV0;
      }
      case "ROUND": return math((x, d) => round(x, Math.trunc(d)), 2);
      case "ROUNDUP": return math((x, d) => round(x, Math.trunc(d), "up"), 2);
      case "ROUNDDOWN": case "TRUNC": return math((x, d) => round(x, Math.trunc(d), "down"), 2, [0, 0]);
      case "INT": return math((x) => Math.floor(x), 1);
      case "ABS": return math((x) => Math.abs(x), 1);
      case "MOD": return math((x, d) => (d === 0 ? DIV0 : x - d * Math.floor(x / d)), 2);
      case "MROUND": return math((x, m) => (m === 0 ? 0 : Math.sign(x) !== Math.sign(m) ? NUM : round(x / m, 0) * m), 2);
      case "CEILING": return math((x, m) => (m === 0 ? 0 : Math.ceil(Number((x / m).toPrecision(15))) * m), 2, [0, 1]);
      case "FLOOR": return math((x, m) => (m === 0 ? DIV0 : Math.floor(Number((x / m).toPrecision(15))) * m), 2, [0, 1]);
      case "IF": {
        const c = bool(sc(0));
        if (c instanceof XlError) return c;
        return c ? (nodes[1] ? sc(1) : true) : nodes[2] ? sc(2) : false;
      }
      case "IFERROR": { const v = sc(0); return v instanceof XlError ? sc(1) : v; }
      case "ISBLANK": return sc(0) === null;
      case "ISNUMBER": return typeof sc(0) === "number";
      case "ISTEXT": return typeof sc(0) === "string";
      case "ISERROR": return sc(0) instanceof XlError;
      case "AND": case "OR": {
        const vs = all(args()).filter((v) => v !== null && typeof v !== "string");
        const bs: boolean[] = [];
        for (const v of vs) { const b = bool(v); if (b instanceof XlError) return b; bs.push(b); }
        if (!bs.length) return VALUE;
        return name === "AND" ? bs.every(Boolean) : bs.some(Boolean);
      }
      case "NOT": { const b = bool(sc(0)); return b instanceof XlError ? b : !b; }
      case "TRUE": return true;
      case "FALSE": return false;
      case "NA": return NA;
      case "CONCATENATE": case "CONCAT": {
        let s = "";
        for (const v of all(args())) { const t = text(v); if (t instanceof XlError) return t; s += t; }
        return s;
      }
      case "TEXT": {
        const v = sc(0), f = text(sc(1));
        if (v instanceof XlError) return v;
        if (f instanceof XlError) return f;
        const x = typeof v === "string" ? (Number.isFinite(Number(v)) && v.trim() ? Number(v) : v) : num(v);
        if (x instanceof XlError) return x;
        return typeof x === "string" ? x : (XLSX.SSF.format(f, x) as string);
      }
      case "LEN": { const t = text(sc(0)); return t instanceof XlError ? t : t.length; }
      case "UPPER": case "LOWER": case "TRIM": {
        const t = text(sc(0));
        if (t instanceof XlError) return t;
        return name === "UPPER" ? t.toUpperCase() : name === "LOWER" ? t.toLowerCase() : t.trim().replace(/ +/g, " ");
      }
      case "TODAY": return toSerial(today.getFullYear(), today.getMonth() + 1, today.getDate());
      case "NOW": return toSerial(today.getFullYear(), today.getMonth() + 1, today.getDate()) + (today.getHours() * 3600 + today.getMinutes() * 60 + today.getSeconds()) / 86400;
      case "DATE": return math((y, m, d) => toSerial(y < 1900 ? y + 1900 : y, m, d), 3);
      case "TIME": return math((h, m, s) => ((h * 3600 + m * 60 + s) / 86400) % 1, 3);
      case "YEAR": return date((d) => d.getUTCFullYear());
      case "MONTH": return date((d) => d.getUTCMonth() + 1);
      case "DAY": return date((d) => d.getUTCDate());
      case "WEEKDAY": return math((s, type) => {
        const d = toDate(s).getUTCDay();
        return type === 2 ? ((d + 6) % 7) + 1 : type === 3 ? (d + 6) % 7 : d + 1;
      }, 2, [0, 1]);
      case "HOUR": return math((s) => Math.floor(round((s % 1) * 24, 9)), 1);
      case "MINUTE": return math((s) => Math.floor(round((s % 1) * 1440, 9)) % 60, 1);
      case "N": { const v = sc(0); return typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : v instanceof XlError ? v : 0; }
      default: throw new Unsupported(`the function ${name}`);
    }
  };

  // Every formula on the sheet, which works out anything it refers to on the way.
  const ws = sheets.get(sheet);
  if (!ws) return;
  for (const addr of Object.keys(ws)) {
    if (addr.startsWith("!")) continue;
    const cell = ws[addr] as XLSX.CellObject;
    if (cell.f) formulaCell(sheet, addr, cell);
  }
}
