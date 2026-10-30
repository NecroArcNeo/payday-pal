// How lists of time records (and the Payroll page's people) can be ordered: what by, and which way round.
// The default everywhere is by date, newest first. Pure, so the pages and the tests share it.

export type SortKey = "date" | "employee" | "hours" | "pay";
/** `desc`: biggest / newest / Z first. */
export type Sort<K extends SortKey = SortKey> = { by: K; desc: boolean };

export const SORT_LABELS: Record<SortKey, string> = { date: "Date", employee: "Employee", hours: "Hours", pay: "Total pay" };

/** The way each key is usually wanted, used when the user switches to it: newest, A to Z, most hours, highest pay. */
export const NATURAL_DESC: Record<SortKey, boolean> = { date: true, employee: false, hours: true, pay: true };

/** What the flip button says for the current direction. */
export function directionLabel(s: Sort): string {
  switch (s.by) {
    case "date": return s.desc ? "Newest first" : "Oldest first";
    case "employee": return s.desc ? "Z → A" : "A → Z";
    case "hours": return s.desc ? "Most hours first" : "Fewest hours first";
    case "pay": return s.desc ? "Highest pay first" : "Lowest pay first";
  }
}

/** A remembered sort, if it still makes sense for this list (prefs can be old or edited); else the fallback. */
export function validSort<K extends SortKey>(s: unknown, keys: readonly K[], fallback: Sort<K>): Sort<K> {
  const v = s as Partial<Sort> | null;
  return v && keys.includes(v.by as K) && typeof v.desc === "boolean" ? (v as Sort<K>) : fallback;
}

/** Keys the database can sort on itself (pay is worked out in the app, so it can't). */
export type StoreSortKey = Exclude<SortKey, "pay">;

type Sortable = { id: string; work_date: string; hours: number | string | null; created_at?: string | null };

/**
 * Records in the asked order. `name` and `pay` give a record's employee name and total pay (pay may be
 * missing while it's loading: those records go last). Ties go newest first, so a person's or an amount's
 * records stay in date order; the same tie-break the database uses for its pages.
 */
export function sortRecords<R extends Sortable>(rows: readonly R[], sort: Sort, opts: { name?: (r: R) => string; pay?: (r: R) => number | undefined } = {}): R[] {
  const sign = sort.desc ? -1 : 1;
  const newestFirst = (a: R, b: R) => b.work_date.localeCompare(a.work_date) || (b.created_at ?? "").localeCompare(a.created_at ?? "") || a.id.localeCompare(b.id);
  const byKey = (a: R, b: R): number => {
    switch (sort.by) {
      case "date": return 0;
      case "employee": return (opts.name?.(a) ?? "").localeCompare(opts.name?.(b) ?? "", undefined, { sensitivity: "base" });
      case "hours": return Number(a.hours ?? 0) - Number(b.hours ?? 0);
      case "pay": {
        const pa = opts.pay?.(a), pb = opts.pay?.(b);
        // Unknown pay sorts last whichever way round, so it never pretends to be the highest or lowest
        // (the `* sign` here cancels the one applied below).
        if (pa === undefined || pb === undefined) return pa === pb ? 0 : (pa === undefined ? 1 : -1) * sign;
        return pa - pb;
      }
    }
  };
  return [...rows].sort((a, b) => {
    if (sort.by === "date") return sort.desc ? newestFirst(a, b) : -newestFirst(a, b);
    return sign * byKey(a, b) || newestFirst(a, b);
  });
}
