// Sorting any table by any of its columns. Each table lists its columns: what a row shows there, as a value to
// compare (a number, text, date or yes/no), and what kind it is, which decides how it starts (newest, A to Z, the
// highest first) and what the flip button says. Pure, so every table and the tests share one comparison.

export type SortValue = string | number | boolean | null | undefined;
/** text: A to Z; number: amounts and hours; date: ISO dates and times (they compare as text, in time order). */
export type SortKind = "text" | "number" | "date";
export type SortColumn<T> = {
  label: string;
  value: (row: T) => SortValue;
  kind: SortKind;
  /** Which way round it starts when picked; by default numbers and dates biggest/newest first, text A to Z. */
  desc?: boolean;
};
export type SortColumns<T> = Record<string, SortColumn<T>>;
/** `desc`: biggest / newest / Z first. */
export type Sort = { by: string; desc: boolean };

const empty = (v: SortValue) => v === null || v === undefined || v === "" || (typeof v === "number" && !Number.isFinite(v));
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** Two non-empty values of a column: numbers by size, yes before no, text by the language's alphabet ("E2" before "E10"). */
export function compareValues(a: Exclude<SortValue, null | undefined>, b: Exclude<SortValue, null | undefined>): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? -1 : 1;
  return collator.compare(String(a), String(b));
}

/**
 * The rows in the asked order. Empty cells ("—", no value yet) go last whichever way round, so they never pretend to
 * be the highest or the lowest. Ties keep `tie`'s order (e.g. newest first), else the rows' own order: the sort is
 * stable, so sorting by department keeps people in name order within each.
 */
export function sortTable<T>(rows: readonly T[], sort: Sort, columns: SortColumns<T>, tie?: (a: T, b: T) => number): T[] {
  const col = columns[sort.by];
  if (!col) return [...rows];
  const sign = sort.desc ? -1 : 1;
  const keyed = rows.map((row, i) => ({ row, i, v: col.value(row) }));
  keyed.sort((x, y) => {
    const ex = empty(x.v), ey = empty(y.v);
    if (ex || ey) return ex && ey ? (tie?.(x.row, y.row) ?? 0) || x.i - y.i : ex ? 1 : -1;
    return sign * compareValues(x.v!, y.v!) || (tie?.(x.row, y.row) ?? 0) || x.i - y.i;
  });
  return keyed.map((k) => k.row);
}

/** The columns without some (ones a table isn't showing just now). */
export function withoutColumns<T>(columns: SortColumns<T>, keys: readonly string[]): SortColumns<T> {
  return Object.fromEntries(Object.entries(columns).filter(([k]) => !keys.includes(k)));
}

/** Which way round a column starts when it's picked. */
export const naturalDesc = (col: SortColumn<unknown>) => col.desc ?? col.kind !== "text";

/** What the flip button says for the current direction. */
export function directionLabel(sort: Sort, col: SortColumn<never> | undefined): string {
  switch (col?.kind) {
    case "date": return sort.desc ? "Newest first" : "Oldest first";
    case "number": return sort.desc ? "Highest first" : "Lowest first";
    default: return sort.desc ? "Z → A" : "A → Z";
  }
}

/** Keys from before sorting by any column, saved in people's prefs, and what they're called now. */
const RENAMED: Record<string, string> = { pay: "total_pay" };

/** A remembered sort, if it still fits this table's columns (prefs can be old or edited); else the fallback. */
export function validTableSort(s: unknown, columns: SortColumns<never>, fallback: Sort): Sort {
  const v = s as Partial<Sort> | null;
  if (!v || typeof v.by !== "string" || typeof v.desc !== "boolean") return fallback;
  const by = columns[v.by] ? v.by : RENAMED[v.by] && columns[RENAMED[v.by]!] ? RENAMED[v.by]! : null;
  return by ? { by, desc: v.desc } : fallback;
}

/** Clicking a column's sort button: that column its usual way round, or the other way round if it's the one already. */
export function nextSort(current: Sort, by: string, col: SortColumn<never>): Sort {
  return current.by === by ? { by, desc: !current.desc } : { by, desc: naturalDesc(col as SortColumn<unknown>) };
}
