import { weekEnd, weekStart } from "@/lib/pay";

// What the Payroll page says when its period has no hours, so a mistyped date (or a period just past the data)
// doesn't look like a payroll of $0. Pure: tested in period-hint.test.ts; the page looks up the nearest records.

export type NearestRecords = {
  /** The latest record day before the period and how many records lie before it; null when there are none. */
  before: { date: string; count: number } | null;
  after: { date: string; count: number } | null;
};

export type PeriodHint =
  | { kind: "backwards" }
  | { kind: "no-records" }
  | { kind: "nearest"; options: { side: "before" | "after"; date: string; count: number; from: string; to: string; days: number }[] };

/** The day before or after an ISO date. */
export const dayBefore = (d: string) => shift(d, -1);
export const dayAfter = (d: string) => shift(d, 1);
function shift(d: string, n: number) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * The hint for an empty period. Each way to go is the Mon–Sun week holding the nearest record day, with how far it
 * is from the period; the closer one comes first.
 */
export function periodHint(from: string, to: string, nearest: NearestRecords): PeriodHint {
  if (from > to) return { kind: "backwards" };
  const options: Extract<PeriodHint, { kind: "nearest" }>["options"] = [];
  if (nearest.before) options.push({ side: "before", ...nearest.before, from: weekStart(nearest.before.date), to: weekEnd(nearest.before.date), days: daysBetween(nearest.before.date, from) });
  if (nearest.after) options.push({ side: "after", ...nearest.after, from: weekStart(nearest.after.date), to: weekEnd(nearest.after.date), days: daysBetween(to, nearest.after.date) });
  if (!options.length) return { kind: "no-records" };
  return { kind: "nearest", options: options.sort((a, b) => a.days - b.days) };
}

/** "3 days", "5 weeks", "about 4 months", "over a year": how far the nearest records are, roughly. */
export function howFar(days: number): string {
  if (days < 14) return `${days} day${days === 1 ? "" : "s"}`;
  if (days < 61) return `${Math.round(days / 7)} weeks`;
  if (days < 365) return `about ${Math.round(days / 30.44)} months`;
  return days < 730 ? "over a year" : `over ${Math.floor(days / 365)} years`;
}
