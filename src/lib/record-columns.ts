import type { PayLine } from "@/lib/pay";
import type { SortColumns } from "@/lib/table-sort";

// The columns a list of time records can be sorted by (Time records, the Timesheet, the Dashboard's recent records),
// keyed like their headers' labels (EditableLabel keys), so a renamed column has its new name in "Sort by" too.

type Row = { id: string; work_date: string; created_at?: string | null; clock_in?: string | null; clock_out?: string | null; lunch_minutes?: number | null; hours: number | string | null; note?: string | null; entry_mode?: string };

export type RecordColumnContext<R> = {
  /** The employee's name (Time records, the Dashboard); left out on one person's timesheet. */
  name?: (r: R) => string;
  shift: (r: R) => string;
  /** The rate in force that day. */
  rate: (r: R) => number;
  /** The record's pay line; undefined while it's being worked out (sorted last). */
  pay: (r: R) => PayLine | undefined;
};

export function recordColumns<R extends Row>(c: RecordColumnContext<R>): SortColumns<R> {
  const line = (f: (l: PayLine) => number | null) => (r: R) => { const l = c.pay(r); return l ? f(l) : undefined; };
  return {
    ...(c.name ? { employee: { label: "Employee", kind: "text" as const, value: c.name } } : {}),
    // With the time it was added, so oldest first is newest first exactly reversed, as before.
    date: { label: "Date", kind: "date", value: (r) => `${r.work_date} ${r.created_at ?? ""}` },
    shift: { label: "Shift", kind: "text", value: c.shift },
    clock_in: { label: "Clock in", kind: "date", desc: false, value: (r) => r.clock_in },
    clock_out: { label: "Clock out", kind: "date", desc: false, value: (r) => r.clock_out },
    break: { label: "Break", kind: "number", value: (r) => (r.entry_mode === "hours" ? null : r.lunch_minutes) },
    hours: { label: "Hours", kind: "number", value: (r) => Number(r.hours ?? 0) },
    hourly_rate: { label: "Rate", kind: "number", value: c.rate },
    reg_hrs: { label: "Reg hrs", kind: "number", value: line((l) => l.regular) },
    ot_hrs: { label: "OT hrs", kind: "number", value: line((l) => l.overtime) },
    // A manual day shows no regular/overtime pay ("—"), so it sorts with the empty ones.
    reg_pay: { label: "Reg pay", kind: "number", value: line((l) => (l.manual ? null : l.regPay)) },
    ot_pay: { label: "OT pay", kind: "number", value: line((l) => (l.manual ? null : l.otPay)) },
    total_pay: { label: "Total pay", kind: "number", value: line((l) => l.pay) },
    note: { label: "Note", kind: "text", value: (r) => r.note },
  };
}

/** Ties go newest first (then the newest added), so one person's or one amount's records stay in date order. */
export function newestFirst(a: Row, b: Row) {
  return b.work_date.localeCompare(a.work_date) || (b.created_at ?? "").localeCompare(a.created_at ?? "") || a.id.localeCompare(b.id);
}

/** The keys the database can order a page of records by itself (store.ts `recordOrder`); the rest are sorted here. */
export const STORE_SORTED = ["date", "employee", "hours"] as const;
