// Values that are allowed but usually a slip, asked about before they're saved (never refused): a pay rate many times
// higher or lower than before ("250" for "25.0"), a record longer than any real day (a time typed as AM for PM makes
// a 20-hour overnight shift), and a new employee with the same name as someone already there. Pure, tested; the
// pages ask with `askConfirm`. (The Payroll page's warnings check whole days later; these catch the slip as it's typed.)
import { computeHours } from "./payroll";

/** A rate this many times higher (or lower) than the old one is asked about. */
export const RATE_JUMP = 5;
/** A record longer than this many hours is asked about. */
export const LONG_RECORD_HOURS = 16;

/** Why a rate change looks like a typo, or null. A first rate (old 0) is never asked about. */
export function rateLooksWrong(oldRate: number, newRate: number): string | null {
  if (!(oldRate > 0) || !Number.isFinite(newRate) || newRate === oldRate) return null;
  if (newRate === 0) return "That pays them nothing.";
  const times = newRate / oldRate;
  if (times >= RATE_JUMP) return `That's ${round(times)}× their current rate.`;
  if (times <= 1 / RATE_JUMP) return `That's ${round(1 / times)}× less than their current rate.`;
  return null;
}
const round = (n: number) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10);

type RecordLike = { entry_mode?: string | null; clock_in?: string | null; clock_out?: string | null; lunch_minutes?: number | string | null; hours?: number | string | null };

/** A record's hours as it will be saved: clock times worked out the way the database does, else its hours. */
export function recordHours(r: RecordLike): number {
  if (r.entry_mode === "clock" && r.clock_in && r.clock_out) return computeHours(r.clock_in, r.clock_out, Number(r.lunch_minutes) || 0);
  return Number(r.hours) || 0;
}

/** The records longer than a real day. */
export function longRecords<R extends RecordLike>(rows: R[], limit = LONG_RECORD_HOURS): R[] {
  return rows.filter((r) => recordHours(r) > limit);
}

/** Why a long record is likely a slip: an overnight clock record is often a time typed as AM instead of PM. */
export function longRecordHint(rows: RecordLike[]): string {
  const overnight = rows.some((r) => r.entry_mode === "clock" && r.clock_in && r.clock_out && r.clock_out <= r.clock_in);
  return overnight
    ? "A clock out earlier than the clock in counts as working through the night. Often it's a time typed as AM instead of PM."
    : `That's more than ${LONG_RECORD_HOURS} hours in one record.`;
}

const nameKey = (first: string, last: string) => `${first} ${last}`.toLowerCase().replace(/\s+/g, " ").trim();

/** Employees already called the same (first and last name, any case or spacing), except `exceptId`. */
export function sameNamePeople<E extends { id: string; first_name: string; last_name: string }>(first: string, last: string, employees: E[], exceptId?: string): E[] {
  const key = nameKey(first, last);
  return key ? employees.filter((e) => e.id !== exceptId && nameKey(e.first_name, e.last_name) === key) : [];
}
