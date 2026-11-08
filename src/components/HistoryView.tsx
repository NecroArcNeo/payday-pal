import { useState, useSyncExternalStore } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Redo2, RotateCcw, Undo2, Pencil } from "lucide-react";
import { btnGhost } from "@/components/AppShell";
import { SkeletonRows } from "@/components/Loading";
import { localDb } from "@/lib/db/local";
import { listHistory, type HistoryEntry, type HistoryFilter } from "@/lib/db/history";
import { localUndo, type UndoOp } from "@/lib/db/undo";
import type { Row } from "@/lib/db/snapshot";
import { EMPLOYEE_SECTIONS } from "@/lib/employee-fields";
import { fullName, useEmployees, useFieldDefs, useShifts, type Employee } from "@/lib/payroll";
import { labelOf } from "@/lib/labels";
import { DEDUCTION_KINDS, DEDUCTION_REPEATS } from "@/lib/deductions";

// The edit history (src/lib/db/history.ts) on screen: a list of entries, newest first, each opening to show what it
// changed, field by field, in the names the user sees (aliases included). Shared by the History page, the profile's
// History tab and the Time records side panel, which pass a filter.

const PAGE = 50;

/** Entries matching `filter`, refreshed whenever a change is made, undone or redone (the undo history's version). */
export function useHistoryEntries(filter: HistoryFilter, limit = PAGE) {
  const version = useSyncExternalStore(localUndo.subscribe, localUndo.getVersion, () => 0);
  return useQuery({
    queryKey: ["history", filter, limit, version],
    queryFn: async () => listHistory(await localDb(), filter, 0, limit),
    placeholderData: keepPreviousData,
  });
}

/** A list of entries matching `filter`, with "Show more". `empty` is what shows when there are none. */
export function HistoryList({ filter, empty = "No changes recorded yet." }: { filter: HistoryFilter; empty?: string }) {
  const [limit, setLimit] = useState(PAGE);
  const history = useHistoryEntries(filter, limit);
  const names = useNames();
  if (history.isError) return <p className="px-5 py-4 text-sm text-destructive">Couldn't read the edit history: {history.error.message}</p>;
  if (!history.data) return <table className="w-full"><tbody><SkeletonRows cols={3} rows={4} /></tbody></table>;
  const { entries, total } = history.data;
  if (!entries.length) return <p className="px-5 py-6 text-sm text-muted-foreground">{empty}</p>;
  return (
    <div>
      <ul className="divide-y divide-border">{entries.map((e) => <EntryRow key={e.id} entry={e} names={names} />)}</ul>
      {total > entries.length && (
        <div className="border-t border-border px-5 py-3 text-sm">
          <button type="button" className={btnGhost} onClick={() => setLimit((n) => n + PAGE)}>Show more ({total - entries.length} older)</button>
        </div>
      )}
    </div>
  );
}

const KIND = {
  edit: { icon: Pencil, label: "" },
  undo: { icon: Undo2, label: "Undid: " },
  redo: { icon: Redo2, label: "Redid: " },
  restore: { icon: RotateCcw, label: "" },
} as const;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function EntryRow({ entry, names }: { entry: HistoryEntry; names: Names }) {
  const [open, setOpen] = useState(false);
  const Icon = KIND[entry.kind].icon;
  const who = entry.employees.map((id) => names.employee(id)).filter(Boolean);
  const canOpen = entry.changes.length > 0;
  return (
    <li className="text-sm">
      <button type="button" disabled={!canOpen} onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex w-full items-start gap-3 px-5 py-2.5 text-left hover:bg-secondary disabled:cursor-default disabled:hover:bg-transparent">
        <span className="mt-0.5 text-muted-foreground">{canOpen ? (open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />) : <span className="inline-block w-4" />}</span>
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="font-medium">{KIND[entry.kind].label}{capital(entry.label)}</span>
          {who.length > 0 && <span className="text-muted-foreground"> · {who.slice(0, 3).join(", ")}{who.length > 3 ? ` and ${who.length - 3} more` : ""}</span>}
        </span>
        <span className="shrink-0 font-mono text-[12px] text-muted-foreground">{new Date(entry.at).toLocaleString()}{entry.device ? ` · ${entry.device}` : ""}</span>
      </button>
      {open && <Changes ops={entry.changes} names={names} />}
    </li>
  );
}

/** At most this many rows of one entry are drawn (an import can write thousands); the rest are counted. */
const SHOWN_ROWS = 25;

function Changes({ ops, names }: { ops: UndoOp[]; names: Names }) {
  // The fill-in triggers (worked hours, rate history) log a second write to a row already shown: one row each.
  const byRow = new Map<string, UndoOp>();
  for (const o of ops) {
    const key = `${o.tbl}:${String((o.new ?? o.old)?.["id"])}`;
    const first = byRow.get(key);
    byRow.set(key, first ? { ...first, op: first.op === "INSERT" ? "INSERT" : o.op === "DELETE" ? "DELETE" : first.op, new: o.new } : o);
  }
  const rows = [...byRow.values()].filter((o) => o.op !== "UPDATE" || changedFields(o).length > 0);
  return (
    <div className="space-y-2 bg-secondary/40 px-5 py-3 pl-16">
      {rows.slice(0, SHOWN_ROWS).map((o, i) => <OpView key={i} op={o} names={names} />)}
      {rows.length > SHOWN_ROWS && <p className="text-xs text-muted-foreground">…and {rows.length - SHOWN_ROWS} more rows.</p>}
      {rows.length === 0 && <p className="text-xs text-muted-foreground">Nothing visible changed.</p>}
    </div>
  );
}

const OP_WORD = { INSERT: "Added", UPDATE: "Changed", DELETE: "Deleted" } as const;

function OpView({ op, names }: { op: UndoOp; names: Names }) {
  const row = (op.new ?? op.old)!;
  const fields = op.op === "UPDATE" ? changedFields(op) : keyFields(op.tbl, row);
  return (
    <div className="text-sm">
      <div><span className="font-medium">{OP_WORD[op.op]} {NOUN[op.tbl] ?? op.tbl}</span> <span className="text-muted-foreground">{names.row(op.tbl, row)}</span></div>
      {fields.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-[13px]">
          {fields.map((f) => (
            <li key={f} className="flex flex-wrap gap-x-2">
              <span className="w-40 shrink-0 text-muted-foreground">{names.field(op.tbl, f)}</span>
              {op.op === "UPDATE" ? (
                <span><span className="text-muted-foreground line-through decoration-muted-foreground/50">{names.value(op.tbl, f, op.old![f])}</span> → <span className="font-medium">{names.value(op.tbl, f, op.new![f])}</span></span>
              ) : <span>{names.value(op.tbl, f, row[f])}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const NOUN: Record<string, string> = {
  employees: "employee", time_records: "time record", pay_adjustments: "extra pay", pay_rates: "pay rate", shifts: "shift",
  employee_field_defs: "category", payroll_settings: "payroll settings", deductions: "deduction", pay_runs: "pay run", pay_run_lines: "pay run line",
  holidays: "holiday", work_patterns: "weekly pattern",
};
/** Bookkeeping columns that don't say anything to the user. */
const HIDDEN = new Set(["id", "created_at", "updated_at", "user_id", "frozen_pay", "sort_order"]);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The fields an update changed; a custom category inside custom_fields counts as its own field. */
function changedFields(op: UndoOp): string[] {
  const a = op.old ?? {}, b = op.new ?? {};
  const out: string[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (HIDDEN.has(k) || same(a[k], b[k])) continue;
    if (k === "custom_fields") {
      const ca = (a[k] ?? {}) as Record<string, unknown>, cb = (b[k] ?? {}) as Record<string, unknown>;
      for (const c of new Set([...Object.keys(ca), ...Object.keys(cb)])) if (!same(ca[c], cb[c])) out.push(`custom:${c}`);
    } else out.push(k);
  }
  return out;
}

/** What an added or deleted row shows: enough to recognise it, not every column. */
const KEY_FIELDS: Record<string, string[]> = {
  employees: ["employee_code", "hourly_rate", "department", "job_title"],
  time_records: ["entry_mode", "clock_in", "clock_out", "lunch_minutes", "hours", "pay_override", "note"],
  pay_adjustments: ["amount", "note"],
  pay_rates: ["hourly_rate"],
  shifts: ["multiplier"],
  deductions: ["kind", "amount", "repeats", "starts_on", "ends_on"],
  pay_runs: ["paid_on", "note"],
  pay_run_lines: ["gross", "deductions_total", "net"],
  holidays: ["holiday_date", "multiplier", "paid_hours"],
};
const keyFields = (tbl: string, row: Row) => (KEY_FIELDS[tbl] ?? []).filter((f) => row[f] !== null && row[f] !== undefined && row[f] !== "");

const FIELD_NAMES: Record<string, Record<string, [string, string]>> = {
  time_records: {
    work_date: ["date", "Date"], entry_mode: ["entry_mode", "Entry type"], clock_in: ["clock_in", "Clock in"], clock_out: ["clock_out", "Clock out"],
    lunch_minutes: ["break", "Break (min)"], hours: ["hours", "Hours"], note: ["note", "Note"], pay_override: ["pay_override", "Set pay"],
    shift_id: ["shift", "Shift"], unlocked: ["unlocked", "Unlocked by itself"], employee_id: ["employee", "Employee"],
  },
  pay_adjustments: { pay_date: ["pay_date", "Pay date"], category: ["category", "Category"], amount: ["amount", "Amount"], note: ["note", "Note"], employee_id: ["employee", "Employee"] },
  pay_rates: { effective_from: ["effective_from", "From"], hourly_rate: ["hourly_rate", "Rate"] },
  payroll_settings: {
    ot_threshold: ["", "Overtime after (hrs/week)"], ot_multiplier: ["", "Overtime rate"], weekend_overtime: ["", "Weekend hours are overtime"],
    visible_columns: ["", "Payroll columns"], employee_defaults: ["", "New-employee template"], locked_through: ["", "Locked as paid through"],
    deductions_on: ["", "Deductions on"], pay_runs_on: ["", "Pay runs on"], history_keep_days: ["", "Edit history kept (days)"],
  },
  holidays: { holiday_date: ["", "Date"], name: ["", "Name"], multiplier: ["", "Rate for hours worked"], paid_hours: ["", "Paid hours when off"] },
  work_patterns: { name: ["", "Name"], days: ["", "Days"], employee_ids: ["", "People"] },
  deductions: { name: ["", "Name"], kind: ["", "Kind"], amount: ["", "Amount"], repeats: ["", "Repeats"], starts_on: ["", "From"], ends_on: ["", "Until"], note: ["", "Note"] },
};

type Names = ReturnType<typeof useNames>;

/** Names for ids, fields and values, as the rest of the app shows them. */
function useNames() {
  const { data: employees = [] } = useEmployees();
  const { data: shifts = [] } = useShifts();
  const { data: defs = [] } = useFieldDefs();
  const emp = new Map<string, Employee>(employees.map((e) => [e.id, e]));
  const employeeFields = new Map(EMPLOYEE_SECTIONS.flatMap((s) => s.fields.map((f) => [f.k, f.label] as const)));
  const employee = (id: unknown) => (typeof id === "string" && emp.has(id) ? fullName(emp.get(id)!) : null);
  const field = (tbl: string, f: string) => {
    if (f.startsWith("custom:")) { const d = defs.find((x) => x.id === f.slice(7)); return labelOf(`custom:${f.slice(7)}`, d?.label ?? "A deleted category"); }
    if (tbl === "employees") return labelOf(f, employeeFields.get(f) ?? (f === "notes" ? "Notes" : f === "shift_id" ? "Shift" : f === "pay_type" ? "Pay type" : f === "active" ? "Active" : f.replace(/_/g, " ")));
    const known = FIELD_NAMES[tbl]?.[f];
    return known ? (known[0] ? labelOf(known[0], known[1]) : known[1]) : capital(f.replace(/_/g, " "));
  };
  const value = (tbl: string, f: string, v: unknown): string => {
    if (v === null || v === undefined || v === "") return "—";
    if (f === "shift_id") return shifts.find((s) => s.id === v)?.name ?? "a deleted shift";
    if (f === "employee_id") return employee(v) ?? "a deleted employee";
    if (tbl === "deductions" && f === "kind") return DEDUCTION_KINDS[v as keyof typeof DEDUCTION_KINDS] ?? String(v);
    if (tbl === "deductions" && f === "repeats") return DEDUCTION_REPEATS[v as keyof typeof DEDUCTION_REPEATS] ?? String(v);
    if (tbl === "time_records" && f === "entry_mode") return v === "clock" ? "Clock in/out" : "Daily hours";
    if (typeof v === "boolean") return v ? "Yes" : "No";
    if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ") : "none";
    if (typeof v === "object") return Object.keys(v as object).length ? JSON.stringify(v) : "—";
    if (/^\d\d:\d\d:\d\d$/.test(String(v))) return String(v).slice(0, 5);
    return String(v);
  };
  /** Which row this is, in words: a record's person and date, an employee's name… */
  const row = (tbl: string, r: Row): string => {
    const who = employee(r["employee_id"]) ?? (tbl === "pay_run_lines" ? String(r["employee_name"] ?? "") : "a deleted employee");
    switch (tbl) {
      case "employees": return `${String(r["first_name"] ?? "")} ${String(r["last_name"] ?? "")}`.trim();
      case "time_records": return `${who}, ${String(r["work_date"])}`;
      case "pay_adjustments": return `${who}, ${String(r["category"])} on ${String(r["pay_date"])}`;
      case "pay_rates": return `${who}, from ${r["effective_from"] === "0001-01-01" ? "the start" : String(r["effective_from"])}`;
      case "deductions": return `${who}, ${String(r["name"])}`;
      case "pay_runs": return `${String(r["period_from"])} – ${String(r["period_to"])}`;
      case "pay_run_lines": return who;
      case "shifts": return String(r["name"] ?? "");
      case "employee_field_defs": return String(r["label"] ?? "");
      default: return "";
    }
  };
  return { employee, field, value, row };
}
