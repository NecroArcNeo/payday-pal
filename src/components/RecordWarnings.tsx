import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Settings2 } from "lucide-react";
import { EmployeeLink } from "@/components/EmployeeLink";
import { btnGhost, btnPrimary, inputCls } from "@/components/AppShell";
import { fullName, weekday, type Employee, type Shift, type TimeRecord } from "@/lib/payroll";
import { usePref } from "@/lib/prefs";
import type { RateEntry } from "@/lib/pay-rates";
import { CHECK_NAMES, checkRecords, DEFAULT_LIMITS, validLimits, type CheckLimits, type RecordWarning } from "@/lib/record-checks";
import { FoldBox } from "@/components/FoldBox";

// The Payroll page's "things to check" panel: records that look like mistakes (src/lib/record-checks.ts), each with a
// link to it on Time records and "It's fine". Limits and what's been marked fine are remembered on this device.

const LIMITS_PREF = "meridian-check-limits";
const FINE_PREF = "meridian-checks-fine";
/** Keys of warnings marked fine, newest last; the oldest are dropped past this many. */
const FINE_KEEP = 2000;
const SHOWN = 8;

export type Checked = { open: RecordWarning[]; fine: RecordWarning[]; records: Map<string, TimeRecord> };

/** The warnings for these records, split into ones still to look at and ones marked fine. */
export function useRecordWarnings(records: TimeRecord[], employees: Employee[], shifts: Shift[], rates: Map<string, RateEntry[]> | undefined): Checked {
  const [savedLimits] = usePref<unknown>(LIMITS_PREF, DEFAULT_LIMITS);
  const [fineKeys] = usePref<string[]>(FINE_PREF, []);
  const limits = validLimits(savedLimits);
  const limitsKey = JSON.stringify(limits);
  const all = useMemo(() => checkRecords({ records, employees, shifts, rates, limits: JSON.parse(limitsKey) as CheckLimits }), [records, employees, shifts, rates, limitsKey]);
  return useMemo(() => {
    const fine = new Set(Array.isArray(fineKeys) ? fineKeys : []);
    return { open: all.filter((w) => !fine.has(w.key)), fine: all.filter((w) => fine.has(w.key)), records: new Map(records.map((r) => [r.id, r])) };
  }, [all, fineKeys, records]);
}

export function RecordWarnings({ checked, employees }: { checked: Checked; employees: Employee[] }) {
  const [fineKeys, setFineKeys] = usePref<string[]>(FINE_PREF, []);
  const [showAll, setShowAll] = useState(false);
  const [showFine, setShowFine] = useState(false);
  const [editing, setEditing] = useState(false);
  const { open, fine } = checked;
  const names = new Map(employees.map((e) => [e.id, fullName(e)]));
  const keys = Array.isArray(fineKeys) ? fineKeys : [];
  const markFine = (w: RecordWarning) => setFineKeys([...keys.filter((k) => k !== w.key), w.key].slice(-FINE_KEEP));
  const unmark = (w: RecordWarning) => setFineKeys(keys.filter((k) => k !== w.key));

  const row = (w: RecordWarning, isFine: boolean) => {
    const rs = w.recordIds.map((id) => checked.records.get(id)).filter((r): r is TimeRecord => !!r);
    const dates = rs.map((r) => r.work_date).sort();
    const last = dates.at(-1) ?? w.date;
    return (
      <li key={w.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-sm">
        <span className={`w-36 shrink-0 rounded-md px-2 py-0.5 text-center text-[11px] font-medium ring-1 ${isFine ? "bg-secondary text-muted-foreground ring-border" : "bg-amber-500/10 text-amber-800 ring-amber-500/30 dark:text-amber-300"}`}>{CHECK_NAMES[w.kind]}</span>
        <span className="w-32 shrink-0 font-mono text-[12px] text-muted-foreground">{weekday(w.date)} {w.date}{last !== w.date ? " …" : ""}</span>
        <span className="w-44 shrink-0 truncate font-medium">{names.has(w.employeeId) ? <EmployeeLink id={w.employeeId} name={names.get(w.employeeId)!} /> : "Unknown employee"}</span>
        <span className={`min-w-[12rem] flex-1 ${isFine ? "text-muted-foreground" : ""}`}>{w.detail}</span>
        <span className="flex shrink-0 gap-2">
          <Link to="/records" search={{ from: w.date, to: last, emp: w.employeeId, mode: rs[0]?.entry_mode === "hours" ? "hours" : "clock" }} className={btnGhost}>Open</Link>
          {isFine
            ? <button type="button" onClick={() => unmark(w)} className={btnGhost}>Check again</button>
            : <button type="button" onClick={() => markFine(w)} className={btnGhost} title="Hide this warning. It comes back if the record changes.">It's fine</button>}
        </span>
      </li>
    );
  };

  const shown = showAll ? open : open.slice(0, SHOWN);
  return (
    <FoldBox id="payroll:checks" title="Things to check" summary={open.length ? `${open.length} to look at` : "nothing to look at"}>
      <div className={`glass-panel overflow-hidden ${open.length ? "ring-1 ring-amber-500/40" : ""}`}>
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
          <span className="flex items-center gap-2 text-sm">
            {open.length
              ? <><AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" /><span><span className="font-semibold">{open.length} thing{open.length === 1 ? "" : "s"} to check</span> before paying this period. Fix them on Time records, or mark them as fine.</span></>
              : <><CheckCircle2 className="h-4 w-4 text-primary" /><span className="text-muted-foreground">Nothing looks unusual in this period's records.</span></>}
          </span>
          <span className="flex gap-2">
            {fine.length > 0 && <button type="button" onClick={() => setShowFine((s) => !s)} className={btnGhost}>{showFine ? "Hide" : "Show"} {fine.length} marked fine</button>}
            <button type="button" onClick={() => setEditing((s) => !s)} className={btnGhost}><Settings2 className="mr-1 inline h-4 w-4" />Limits</button>
          </span>
        </div>
        {editing && <LimitsEditor onClose={() => setEditing(false)} />}
        {open.length > 0 && (
          <ul className="divide-y divide-border border-t border-border">
            {shown.map((w) => row(w, false))}
            {open.length > SHOWN && (
              <li className="px-5 py-2 text-sm">
                <button type="button" onClick={() => setShowAll((s) => !s)} className="text-muted-foreground underline hover:text-foreground">{showAll ? "Show fewer" : `Show all ${open.length}`}</button>
              </li>
            )}
          </ul>
        )}
        {showFine && fine.length > 0 && (
          <ul className="divide-y divide-border border-t border-border bg-secondary/40">
            {fine.map((w) => row(w, true))}
          </ul>
        )}
      </div>
    </FoldBox>
  );
}

/** The limits "Things to check" uses (a per-device pref). On the Payroll page under Limits, and in Settings → Checks. */
export function LimitsEditor({ onClose }: { onClose: () => void }) {
  const [saved, setSaved] = usePref<unknown>(LIMITS_PREF, DEFAULT_LIMITS);
  const limits = validLimits(saved);
  const [v, setV] = useState({ longDay: String(limits.longDay), noBreakAfter: String(limits.noBreakAfter), shortShift: String(limits.shortShift), longBreak: String(limits.longBreak) });
  const fields: { k: keyof CheckLimits; label: string; unit: string; max: number }[] = [
    { k: "longDay", label: "Very long day: over", unit: "hours worked", max: 24 },
    { k: "noBreakAfter", label: "No break: over", unit: "hours with a 0 break", max: 24 },
    { k: "shortShift", label: "Very short: under", unit: "hours", max: 24 },
    { k: "longBreak", label: "Long break: over", unit: "minutes", max: 1440 },
  ];
  const bad = fields.filter((f) => { const n = Number(v[f.k]); return v[f.k].trim() === "" || !Number.isFinite(n) || n < 0 || n > f.max; });
  const save = () => {
    if (bad.length) return;
    setSaved(Object.fromEntries(fields.map((f) => [f.k, Number(v[f.k])])));
    onClose();
  };
  return (
    <div className="flex flex-wrap items-end gap-4 border-t border-border px-5 py-4">
      {fields.map((f) => (
        <label key={f.k} className="text-sm">
          <span className="label-mono">{f.label}</span>
          <span className="mt-1 flex items-center gap-2">
            <input type="number" min={0} max={f.max} step={f.k === "longBreak" ? 5 : 0.5} value={v[f.k]} onChange={(e) => setV({ ...v, [f.k]: e.target.value })}
              className={`${inputCls} !w-24 ${bad.includes(f) ? "ring-2 ring-destructive" : ""}`} />
            <span className="text-xs text-muted-foreground">{f.unit}</span>
          </span>
        </label>
      ))}
      <span className="flex gap-2">
        <button type="button" onClick={save} disabled={bad.length > 0} className={btnPrimary}>Save</button>
        <button type="button" onClick={() => setV({ longDay: String(DEFAULT_LIMITS.longDay), noBreakAfter: String(DEFAULT_LIMITS.noBreakAfter), shortShift: String(DEFAULT_LIMITS.shortShift), longBreak: String(DEFAULT_LIMITS.longBreak) })} className={btnGhost}>Defaults</button>
      </span>
    </div>
  );
}
