import type { Tables } from "@/integrations/supabase/types";
import type { DataStore, FrozenRow } from "@/lib/db/store";
import { frozenPay, payByRecord, toFrozen, weekEnd, weekStart, payRules } from "@/lib/pay";
import type { RateEntry } from "@/lib/pay-rates";

// Locked days keep what they paid. Locking saves each record's pay as the current rules, shift multipliers and
// rates work it out (time_records.frozen_pay, schema 12), and pay uses that from then on. Unlocking clears it, so
// the current rules apply again; locking again saves the new figures. All of it goes through the store's lock
// methods, which are undoable, so undoing an accidental unlock puts the saved pay back.

type Row = Tables<"time_records">;

/** The pay to save on `records` that don't have saved pay yet, worked out as the Payroll page would show it now. */
export async function payToFreeze(store: DataStore, records: Pick<Row, "id" | "work_date" | "frozen_pay">[]): Promise<FrozenRow[]> {
  const todo = records.filter((r) => !frozenPay(r));
  if (!todo.length) return [];
  const dates = todo.map((r) => r.work_date).sort();
  // Whole Mon–Sun weeks, so weekly overtime and salary weeks come out as they do on the Payroll page.
  const [week, employees, shifts, settings, history] = await Promise.all([
    store.listRecordsMatching({ from: weekStart(dates[0]!), to: weekEnd(dates.at(-1)!) }),
    store.listEmployees(), store.listShifts(), store.getSettings(), store.listPayRates(),
  ]);
  const holidays = await store.listHolidays();
  const rates = new Map<string, RateEntry[]>();
  for (const r of history) rates.set(r.employee_id, [...(rates.get(r.employee_id) ?? []), r]);
  const rules = payRules(settings, holidays);
  const lines = payByRecord(week, employees, shifts, rules, rates);
  const out: FrozenRow[] = [];
  for (const r of todo) {
    const l = lines.get(r.id);
    // A record whose employee is gone has no pay to keep.
    if (l) out.push({ id: r.id, pay: toFrozen(l) });
  }
  return out;
}

/** Locks days through `date` (null: unlocks everything), saving the pay of every record it locks. */
export async function lockThrough(store: DataStore, date: string | null) {
  const freeze = date ? await payToFreeze(store, await store.listRecordsMatching({ to: date })) : [];
  return store.setLockedThrough(date, freeze);
}

/** Unlocks records one by one (the current rules apply to them again), or locks them again with their pay saved as it is now. */
export async function setRecordsLocked(store: DataStore, records: Pick<Row, "id" | "work_date" | "frozen_pay">[], locked: boolean) {
  const ids = records.map((r) => r.id);
  if (!locked) return store.setRecordsUnlocked(ids, true);
  // Saved pay left on a record (it shouldn't be, once unlocked) is replaced by today's figures.
  return store.setRecordsUnlocked(ids, false, await payToFreeze(store, records.map((r) => ({ ...r, frozen_pay: null }))));
}
