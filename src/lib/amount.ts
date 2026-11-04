// Amounts typed or imported as text ("$1,234.50", "12,50", "1.234,50", "(50)"). One reader for every place that
// takes one (day pay, bulk edit, money and number categories, imports), so they all read the same text the same way.

/**
 * The number in `text`, or NaN. Currency signs and spaces are ignored. When both . and , appear, whichever comes last
 * is the decimal point; a comma alone is one when 1–2 digits follow it ("12,50" is 12.5, never 1250), else it groups
 * thousands ("1,234"). "(50)" is −50. Only plain decimals: not "0x10", "1e5" or "Infinity".
 */
export function readAmount(text: string): number {
  let t = text.replace(/[$€£\s]/g, "");
  const negative = /^\(.*\)$/.test(t);
  if (negative) t = t.slice(1, -1);
  if (t.includes(",") && t.includes(".")) t = t.lastIndexOf(",") > t.lastIndexOf(".") ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  else t = /^-?\d+,\d{1,2}$/.test(t) ? t.replace(",", ".") : t.replace(/,/g, "");
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return NaN;
  return negative ? -Number(t) : Number(t);
}

/**
 * Rounds amounts to the cent so they add up to `total` (in cents) exactly: each is rounded down, and the cents left
 * over go one each to the amounts that lost the most (largest remainder). Rounding each one on its own can miss the
 * total by a few cents over a long column, which shows on any timesheet or report table someone adds up.
 */
export function centsAddingUp(exact: number[], total: number): number[] {
  const cents = exact.map((x) => Math.floor(x * 100 + 1e-7));
  let left = total - cents.reduce((s, c) => s + c, 0);
  const order = exact.map((x, i) => ({ i, rest: x * 100 - cents[i]! })).sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) cents[order[k]!.i]!++;
  for (let k = order.length - 1; left < 0 && k >= 0; k--, left++) cents[order[k]!.i]!--;
  return cents.map((c) => c / 100);
}
