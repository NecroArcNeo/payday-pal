// Saved weekly patterns (schema 14): a usual week ("Mon–Fri 9–5, 30 min break") and the people who work it, saved once
// and used to fill any weeks with their records ("Fill weeks" on Time records). Pure, tested; the dialog
// (src/components/Patterns.tsx) asks about same-day clashes, backs up and saves in one insert (one undo step).
// The rules match Copy a week's: days locked as paid and shifts already there are skipped, resigned people are left
// out, and so are days before someone was hired; public holidays are skipped unless asked otherwise.
import type { TablesInsert } from "@/integrations/supabase/types";
import type { RecordKey } from "@/lib/db/store";
import { recordKey } from "@/lib/import/parse";
import { addDays } from "@/lib/payroll";
import { weekStart } from "@/lib/pay";

/** One day of a pattern: worked (clock times and break, or hours, on a shift or the person's own) or off (null). */
export type PatternDay =
  | { entry_mode: "clock"; clock_in: string; clock_out: string; lunch_minutes: number; shift_id?: string | null }
  | { entry_mode: "hours"; hours: number; shift_id?: string | null };
/** Monday to Sunday. */
export type PatternWeek = (PatternDay | null)[];
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const EMPTY_WEEK: PatternWeek = [null, null, null, null, null, null, null];

const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/** A pattern's days as stored (JSON), checked: always 7, anything unreadable is an off day. */
export function readWeek(v: unknown): PatternWeek {
  const list = Array.isArray(v) ? v : [];
  return Array.from({ length: 7 }, (_, i) => {
    const d = list[i] as Record<string, unknown> | null | undefined;
    if (!d || typeof d !== "object") return null;
    const shift_id = typeof d["shift_id"] === "string" ? d["shift_id"] : null;
    if (d["entry_mode"] === "clock" && typeof d["clock_in"] === "string" && TIME.test(d["clock_in"]) && typeof d["clock_out"] === "string" && TIME.test(d["clock_out"])) {
      const lunch = Number(d["lunch_minutes"]);
      return { entry_mode: "clock", clock_in: d["clock_in"].slice(0, 5), clock_out: d["clock_out"].slice(0, 5), lunch_minutes: Number.isInteger(lunch) && lunch >= 0 && lunch <= 1440 ? lunch : 0, shift_id };
    }
    const hours = Number(d["hours"]);
    if (d["entry_mode"] === "hours" && Number.isFinite(hours) && hours > 0 && hours <= 24) return { entry_mode: "hours", hours, shift_id };
    return null;
  });
}

/** "Mon–Fri 09:00–17:00, Sat 4 h": a pattern in a line. */
export function describeWeek(week: PatternWeek): string {
  const what = (d: PatternDay) => (d.entry_mode === "clock" ? `${d.clock_in}–${d.clock_out}` : `${d.hours} h`);
  const parts: string[] = [];
  let i = 0;
  while (i < 7) {
    const d = week[i];
    if (!d) { i++; continue; }
    let j = i;
    while (j + 1 < 7 && week[j + 1] && what(week[j + 1]!) === what(d)) j++;
    parts.push(`${WEEKDAYS[i]}${j > i ? `–${WEEKDAYS[j]}` : ""} ${what(d)}`);
    i = j + 1;
  }
  return parts.join(", ") || "No days";
}

type Person = { id: string; active?: boolean | null; hire_date?: string | null };
type Source = { name?: string; days: unknown; employee_ids: unknown };

export type PatternPlan = {
  add: TablesInsert<"time_records">[];
  /** Left out: the same shift is already there, the day is locked as paid, or it's a public holiday. */
  duplicates: number; locked: number; holidays: number;
  /** People in the patterns who are resigned, deleted or not hired yet for a day. */
  leftOut: number;
};

/**
 * The records `patterns` give in `weeks` weeks from the Monday of `from`. `existing`: records already in those weeks;
 * `holidays`: dates to skip (empty to work them as usual).
 */
export function planPatterns({ patterns, from, weeks, employees, existing, lockedThrough, holidays = [] }: {
  patterns: Source[]; from: string; weeks: number; employees: Person[]; existing: RecordKey[];
  lockedThrough: string | null | undefined; holidays?: string[];
}): PatternPlan {
  const plan: PatternPlan = { add: [], duplicates: 0, locked: 0, holidays: 0, leftOut: 0 };
  const monday = weekStart(from);
  const people = new Map(employees.map((e) => [e.id, e]));
  const there = new Set(existing.map(recordKey));
  const off = new Set(holidays);
  for (const p of patterns) {
    const week = readWeek(p.days);
    const ids = Array.isArray(p.employee_ids) ? (p.employee_ids as unknown[]).filter((x): x is string => typeof x === "string") : [];
    for (const id of ids) {
      const e = people.get(id);
      if (!e || e.active === false) { plan.leftOut++; continue; }
      for (let w = 0; w < weeks; w++) {
        week.forEach((d, i) => {
          if (!d) return;
          const work_date = addDays(monday, 7 * w + i);
          if (e.hire_date && work_date < e.hire_date) { plan.leftOut++; return; }
          if (lockedThrough && work_date <= lockedThrough) { plan.locked++; return; }
          if (off.has(work_date)) { plan.holidays++; return; }
          const row: TablesInsert<"time_records"> = d.entry_mode === "clock"
            ? { employee_id: id, work_date, entry_mode: "clock", clock_in: d.clock_in, clock_out: d.clock_out, lunch_minutes: d.lunch_minutes, shift_id: d.shift_id ?? null }
            : { employee_id: id, work_date, entry_mode: "hours", hours: d.hours, shift_id: d.shift_id ?? null };
          const key = recordKey(row as Parameters<typeof recordKey>[0]);
          if (there.has(key)) { plan.duplicates++; return; }
          there.add(key);
          plan.add.push(row);
        });
      }
    }
  }
  return plan;
}

/**
 * A pattern from one person's week of records (the first record of each day): "Save this week as a pattern".
 * Days with no record are off.
 */
export function weekFromRecords(records: { work_date: string; entry_mode: string; clock_in?: string | null; clock_out?: string | null; lunch_minutes?: number | null; hours?: number | string | null; shift_id?: string | null }[], monday: string): PatternWeek {
  return readWeek(Array.from({ length: 7 }, (_, i) => {
    const r = records.filter((x) => x.work_date === addDays(monday, i)).sort((a, b) => (a.clock_in ?? "").localeCompare(b.clock_in ?? ""))[0];
    if (!r) return null;
    return r.entry_mode === "clock"
      ? { entry_mode: "clock", clock_in: r.clock_in, clock_out: r.clock_out, lunch_minutes: r.lunch_minutes ?? 0, shift_id: r.shift_id ?? null }
      : { entry_mode: "hours", hours: Number(r.hours), shift_id: r.shift_id ?? null };
  }));
}
