// Reading a date as people type it ("1101", "11/1", "nov 1", "11-01-26", "today"), for DateInput. The browser's own
// date box splits the date into month/day/year segments and puts each digit in whichever segment has the cursor, so
// typing "1101" in the wrong segment gives year 0001 or the like. This reads the whole text at once instead.

/** Which comes first in a date like 11/01: month (US) or day (most other places). Year-first (2026-11-01) is always understood. */
export type DayOrder = "mdy" | "dmy";

/** This computer's habit, from its language settings (US English: month first). */
export function localDayOrder(): DayOrder {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(2026, 10, 25));
    const types = parts.map((p) => p.type).filter((t) => t === "month" || t === "day");
    return types[0] === "day" ? "dmy" : "mdy";
  } catch {
    return "mdy";
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return y >= 1900 && y <= 2200 && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
};
const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
const addDays = (iso: string, n: number) => new Date((dayNumber(iso) + n) * 86_400_000).toISOString().slice(0, 10);

/** A day and month without a year: the year that puts it nearest today, so 11/01 is this November and, in late December, 01/05 is next January. */
function nearestYear(m: number, d: number, today: string): string | null {
  const y = Number(today.slice(0, 4));
  const options = [y - 1, y, y + 1].map((yy) => ymd(yy, m, d)).filter((x): x is string => !!x);
  if (!options.length) return null;
  return options.reduce((best, x) => (Math.abs(dayNumber(x) - dayNumber(today)) < Math.abs(dayNumber(best) - dayNumber(today)) ? x : best));
}
/** A two-digit year: the century that puts it nearest today (26 → 2026, 85 → 1985). */
function fullYear(yy: number, today: string) {
  const y = Number(today.slice(0, 4));
  const c = Math.floor(y / 100) * 100;
  return [c - 100, c, c + 100].map((x) => x + yy).reduce((best, x) => (Math.abs(x - y) < Math.abs(best - y) ? x : best));
}
const year = (text: string, today: string) => (text.length <= 2 ? fullYear(Number(text), today) : Number(text));

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const monthNamed = (w: string) => {
  const i = MONTHS.indexOf(w.slice(0, 3).toLowerCase());
  return w.length >= 3 && i >= 0 && MONTHS[i]!.startsWith(w.slice(0, 3).toLowerCase()) ? i + 1 : null;
};

/** Month and day from two numbers in this computer's order, then the year (given, or the nearest). */
function fromParts(a: number, b: number, y: number | null, order: DayOrder, today: string) {
  const [m, d] = order === "mdy" ? [a, b] : [b, a];
  return y === null ? nearestYear(m, d, today) : ymd(y, m, d);
}

/**
 * The date in `text` as YYYY-MM-DD, or null if it can't be read. `today` is YYYY-MM-DD.
 * Understands: 2026-11-01; 11/01/2026, 11-1-26, 11.01; 1101, 110126, 11012026, 20261101; a day alone (5 = the 5th of
 * this month); Nov 1, 1 November 2026, Sat Nov 1; today, yesterday, tomorrow.
 */
export function readTypedDate(text: string, today: string, order: DayOrder): string | null {
  // A leading weekday is just a reminder ("Sat 11/1", "Saturday, Nov 1").
  const v = text.trim().toLowerCase().replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s*/, "").replace(/,/g, " ").trim();
  if (!v) return null;
  if (v === "today" || v === "now") return today;
  if (v === "yesterday") return addDays(today, -1);
  if (v === "tomorrow") return addDays(today, 1);

  let m = v.match(/^(\d{4})[-/.\s](\d{1,2})[-/.\s](\d{1,2})$/);
  if (m) return ymd(+m[1]!, +m[2]!, +m[3]!);
  m = v.match(/^(\d{1,2})[-/.\s]+(\d{1,2})(?:[-/.\s]+(\d{2}|\d{4}))?$/);
  if (m) return fromParts(+m[1]!, +m[2]!, m[3] ? year(m[3], today) : null, order, today);

  // Month names, either way round: "nov 1", "nov 1 2026", "1 nov", "1st november 26".
  m = v.match(/^([a-z]+)\.?\s*(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{2}|\d{4}))?$/);
  if (m) { const mo = monthNamed(m[1]!); if (mo) return m[3] ? ymd(year(m[3], today), mo, +m[2]!) : nearestYear(mo, +m[2]!, today); return null; }
  m = v.match(/^(\d{1,2})(?:st|nd|rd|th)?\s*([a-z]+)\.?(?:\s+(\d{2}|\d{4}))?$/);
  if (m) { const mo = monthNamed(m[2]!); if (mo) return m[3] ? ymd(year(m[3], today), mo, +m[1]!) : nearestYear(mo, +m[1]!, today); return null; }

  if (!/^\d+$/.test(v)) return null;
  const n = (s: string) => Number(s);
  switch (v.length) {
    // A day of this month.
    case 1: case 2: return ymd(n(today.slice(0, 4)), n(today.slice(5, 7)), n(v));
    // 3 digits are read only when just one split makes a date: 915 is 9/15 (91/5 isn't), but 111 could be 1/11 or 11/1.
    case 3: {
      const reads = [fromParts(n(v[0]!), n(v.slice(1)), null, order, today), fromParts(n(v.slice(0, 2)), n(v[2]!), null, order, today)].filter(Boolean);
      return reads.length === 1 ? reads[0]! : null;
    }
    case 4: return fromParts(n(v.slice(0, 2)), n(v.slice(2)), null, order, today);
    case 6: return fromParts(n(v.slice(0, 2)), n(v.slice(2, 4)), fullYear(n(v.slice(4)), today), order, today);
    case 8: {
      // Year first when it reads as one (20261101), else month/day first (11012026).
      const yearFirst = /^(19|20|21)/.test(v) ? ymd(n(v.slice(0, 4)), n(v.slice(4, 6)), n(v.slice(6))) : null;
      return yearFirst ?? fromParts(n(v.slice(0, 2)), n(v.slice(2, 4)), n(v.slice(4)), order, today);
    }
    default: return null;
  }
}

/** YYYY-MM-DD shown the way it's typed here: 11/01/2026 (or 01/11/2026 day first). */
export function showDate(iso: string, order: DayOrder) {
  const [y, m, d] = iso.split("-");
  return order === "mdy" ? `${m}/${d}/${y}` : `${d}/${m}/${y}`;
}
