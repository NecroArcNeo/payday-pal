import type { Tables, TablesInsert } from "@/integrations/supabase/types";
import type { RecordKey } from "@/lib/db/store";
import { recordKey } from "@/lib/import/parse";
import { addDays } from "@/lib/payroll";

// "Copy a week" on Time records: a week's shifts given again in later (or earlier) weeks. This file only decides what
// to add; the dialog (src/components/CopyWeek.tsx) asks about same-day clashes and saves.

/** What a copy keeps of a record. Pay set by hand, the lock and its saved pay are one-off, so they never come along. */
export type CopySource = Pick<Tables<"time_records">, "employee_id" | "work_date" | "entry_mode" | "clock_in" | "clock_out" | "lunch_minutes" | "hours" | "shift_id" | "note">;

export type CopyRequest = {
  /** The source week's records (any outside `from`…`from`+6 are ignored). */
  records: CopySource[];
  /** First day of the week copied from, and of the first week copied to. */
  from: string;
  to: string;
  /** How many weeks in a row, starting at `to`. */
  weeks: number;
  /** Days of the week to copy, 0 = the week's first day … 6 = its last. */
  days: number[];
  employeeIds: string[];
  lockedThrough: string | null | undefined;
  /** Records already in the weeks copied to. */
  existing: RecordKey[];
};

export type CopyPlan = {
  add: TablesInsert<"time_records">[];
  /** Left out because the very same shift is already there (so copying twice adds nothing). */
  duplicates: number;
  /** Left out because the day is locked as paid. */
  locked: number;
};

const dayNumber = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000);

export function planCopy({ records, from, to, weeks, days, employeeIds, lockedThrough, existing }: CopyRequest): CopyPlan {
  const shift = dayNumber(to) - dayNumber(from);
  // Whole weeks only, so a Monday stays a Monday.
  if (shift % 7 !== 0) throw new Error("The weeks copied from and to must start on the same weekday.");
  const people = new Set(employeeIds);
  const wanted = new Set(days);
  const there = new Set(existing.map(recordKey));
  const plan: CopyPlan = { add: [], duplicates: 0, locked: 0 };
  const source = records.filter((r) => {
    const day = dayNumber(r.work_date) - dayNumber(from);
    return day >= 0 && day < 7 && wanted.has(day) && people.has(r.employee_id);
  });
  for (let week = 0; week < weeks; week++) {
    for (const r of source) {
      const work_date = addDays(r.work_date, shift + 7 * week);
      if (lockedThrough && work_date <= lockedThrough) { plan.locked++; continue; }
      const key = recordKey({ ...r, work_date });
      if (there.has(key)) { plan.duplicates++; continue; }
      there.add(key);
      // Clock records' hours are worked out by the database (compute_record_hours), as for any other record.
      plan.add.push(r.entry_mode === "clock"
        ? { employee_id: r.employee_id, work_date, entry_mode: "clock", clock_in: r.clock_in, clock_out: r.clock_out, lunch_minutes: r.lunch_minutes, shift_id: r.shift_id, note: r.note }
        : { employee_id: r.employee_id, work_date, entry_mode: "hours", hours: r.hours, shift_id: r.shift_id, note: r.note });
    }
  }
  return plan;
}

/**
 * "Copy to next week" for chosen records (the right-click menu, or several selected): each one a week later, by
 * planCopy's rules. They can come from different weeks, so each day is planned by itself, and what one day adds
 * counts as already there for the next (two identical records give one copy, as Copy a week does).
 */
export function planNextWeek(records: CopySource[], lockedThrough: string | null | undefined, existing: RecordKey[]): CopyPlan {
  const plan: CopyPlan = { add: [], duplicates: 0, locked: 0 };
  const there = [...existing];
  const byDay = new Map<string, CopySource[]>();
  for (const r of records) byDay.set(r.work_date, [...(byDay.get(r.work_date) ?? []), r]);
  for (const [day, rs] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
    const p = planCopy({ records: rs, from: day, to: addDays(day, 7), weeks: 1, days: [0], employeeIds: rs.map((r) => r.employee_id), lockedThrough, existing: there });
    plan.add.push(...p.add);
    plan.duplicates += p.duplicates;
    plan.locked += p.locked;
    there.push(...(p.add as RecordKey[]));
  }
  return plan;
}
