import type { RecordKey } from "@/lib/db/store";

// Adding a record for someone on a day they already have one is usually a slip (it would pay that day twice),
// though it can be deliberate, e.g. a day and a night shift. So it's warned about, not refused.

export type Clash = { employee_id: string; work_date: string; existing: RecordKey[] };

/** The new records' employee-days that already have a record, in the order they're added. */
export function sameDayClashes(adding: { employee_id: string; work_date: string }[], existing: RecordKey[]): Clash[] {
  const have = new Map<string, RecordKey[]>();
  for (const r of existing) { const k = `${r.employee_id}|${r.work_date}`; have.set(k, [...(have.get(k) ?? []), r]); }
  const seen = new Set<string>();
  const out: Clash[] = [];
  for (const a of adding) {
    const k = `${a.employee_id}|${a.work_date}`;
    const ex = have.get(k);
    if (ex && !seen.has(k)) { seen.add(k); out.push({ employee_id: a.employee_id, work_date: a.work_date, existing: ex }); }
  }
  return out;
}

/** "09:00–17:00" for a clock record, "8 h" for a daily-hours one. */
export function describeRecord(r: Pick<RecordKey, "entry_mode" | "clock_in" | "clock_out" | "hours">) {
  return r.entry_mode === "clock" && r.clock_in && r.clock_out ? `${r.clock_in.slice(0, 5)}–${r.clock_out.slice(0, 5)}` : `${Number(r.hours ?? 0)} h`;
}
