// Pay rate history: "from this day, this rate". A day is paid at the latest rate starting on or before it; days
// before the first entry at the first entry's rate. An employee with no entries is paid their current rate
// (employees.hourly_rate) every day. The database keeps this up to date whenever a rate changes (schema 9 trigger),
// and the current rate is always the latest entry's.

export type RateEntry = { effective_from: string; hourly_rate: number | string };

/** Entries before this start "from the beginning": the old rate kept by the first change. */
export const SINCE_START = "0001-01-01";

const byDate = (a: RateEntry, b: RateEntry) => a.effective_from.localeCompare(b.effective_from);

/** The rate paid on `date`. `rates` may be unsorted; `current` is used when there's no history. */
export function rateOn(rates: RateEntry[] | undefined, current: number | string, date: string): number {
  if (!rates?.length) return Number(current);
  const sorted = [...rates].sort(byDate);
  let r = sorted[0]!;
  for (const x of sorted) { if (x.effective_from <= date) r = x; else break; }
  return Number(r.hourly_rate);
}

/** The distinct rates paid over [from, to], oldest first: one entry when it didn't change. */
export function ratesBetween(rates: RateEntry[] | undefined, current: number | string, from: string, to: string): number[] {
  const out = [rateOn(rates, current, from)];
  for (const x of [...(rates ?? [])].sort(byDate)) {
    if (x.effective_from > from && x.effective_from <= to && Number(x.hourly_rate) !== out.at(-1)) out.push(Number(x.hourly_rate));
  }
  return out;
}

/** "since the start" for the kept old rate, else the date. */
export const describeFrom = (from: string) => (from === SINCE_START ? "since the start" : `from ${from}`);

export type StoredRate = RateEntry & { id: string };
/** What changing a rate writes: history entries to add or re-rate, and the employee's new current rate. */
export type RatePlan = { insert: { effective_from: string; hourly_rate: number }[]; update: { id: string; hourly_rate: number }[]; current: number };

/**
 * A new rate. `from` a date: that day on (earlier days keep what they had; a later change already recorded still
 * applies after it). "correct": fixes the current rate where it already applies, for a typo.
 * Write the plan's history first, then set the employee's rate to `current`: the database then has nothing to add.
 */
export function planRateChange(history: StoredRate[], oldRate: number, newRate: number, when: { from: string } | "correct"): RatePlan {
  const sorted = [...history].sort(byDate);
  const plan: RatePlan = { insert: [], update: [], current: newRate };
  if (when === "correct") {
    const latest = sorted.at(-1);
    if (latest) plan.update.push({ id: latest.id, hourly_rate: newRate });
    else plan.insert.push({ effective_from: SINCE_START, hourly_rate: newRate });
    return plan;
  }
  if (!sorted.length) plan.insert.push({ effective_from: SINCE_START, hourly_rate: oldRate });
  const same = sorted.find((x) => x.effective_from === when.from);
  if (same) plan.update.push({ id: same.id, hourly_rate: newRate });
  else plan.insert.push({ effective_from: when.from, hourly_rate: newRate });
  const later = sorted.filter((x) => x.effective_from > when.from).at(-1);
  if (later) plan.current = Number(later.hourly_rate);
  return plan;
}

/** After deleting history entry `id`: the rate that's then current. */
export function currentAfterDelete(history: StoredRate[], id: string, fallback: number): number {
  const rest = [...history].filter((x) => x.id !== id).sort(byDate);
  return rest.length ? Number(rest.at(-1)!.hourly_rate) : fallback;
}
