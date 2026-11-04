import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, Lock, LockOpen, Trash2, X } from "lucide-react";
import { db } from "@/lib/db/mode";
import { btnGhost, btnPrimary, inputCls } from "@/components/AppShell";
import { EmployeePicker } from "@/components/EmployeeSearch";
import { EmployeeLink } from "@/components/EmployeeLink";
import { DateInput } from "@/components/DateInput";
import { BreakInput } from "@/components/BreakField";
import { RecordShiftSelect } from "@/components/RecordPay";
import { colourCss, MARKS, type RowMark } from "@/lib/row-marks";
import { breakRangeText, useBreakUnit, validBreak } from "@/lib/breaks";
import { useLabels } from "@/lib/labels";
import { computeHours, fullName, money, usePayRates, usePayrollSettings, weekday, type Employee, type RecordWithEmp, type Shift } from "@/lib/payroll";
import { shiftFor, shiftForRecord, type PayLine } from "@/lib/pay";
import { rateOn } from "@/lib/pay-rates";
import type { EntryMode } from "@/components/RecordsLedger";
import { readAmount } from "@/lib/amount";

// The Time records side panel: one record's details (how its pay is worked out, its colours and tags) and its edit
// form, beside the list rather than over it, so the list stays usable: clicking another row or ↑/↓ moves the panel to
// that record. The list (RecordsLedger) owns which record is open; this only shows it.

export function RecordPanel({ record, employees, shifts, line, mark, lockedThrough, position, onMove, onClose, onChanged, onDelete, onSetUnlocked, onDirty }: {
  record: RecordWithEmp; employees: Employee[]; shifts: Shift[]; line: PayLine | undefined; mark: RowMark;
  lockedThrough: string | null; position: string; onMove: (step: -1 | 1) => void; onClose: () => void;
  onChanged: () => void; onDelete: (id: string) => void; onSetUnlocked: (id: string, unlocked: boolean) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const lockedDay = !!lockedThrough && record.work_date <= lockedThrough;
  const locked = lockedDay && !record.unlocked;
  const head = useRef<HTMLHeadingElement>(null);
  // Focus moves to the panel when it opens, so the keyboard (Tab, Escape) starts there; not on every record change,
  // so stepping with ↑/↓ doesn't pull focus out of the list.
  useEffect(() => { head.current?.focus(); }, []);
  // While open, the page makes room for the panel on wide screens (styles.css), so no column is hidden behind it.
  useEffect(() => {
    document.documentElement.classList.add("record-panel-open");
    return () => document.documentElement.classList.remove("record-panel-open");
  }, []);

  // Through a portal into <body>: the table's panel has a backdrop blur, and an ancestor with a filter or transform
  // becomes the box `position: fixed` is measured from, so the panel would be stuck inside the table.
  return createPortal(
    <aside role="dialog" aria-modal="false" aria-labelledby="record-panel-title"
      className="fixed inset-y-0 right-0 z-40 flex w-[min(27rem,100vw)] flex-col border-l border-border bg-background shadow-2xl duration-200 animate-in slide-in-from-right">
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 id="record-panel-title" ref={head} tabIndex={-1} className="truncate font-display text-lg font-extrabold tracking-tight outline-none">
            {record.employees ? <EmployeeLink id={record.employee_id} name={fullName(record.employees)} /> : "—"}
          </h2>
          <div className="font-mono text-xs text-muted-foreground">{weekday(record.work_date)} {record.work_date} · {position}</div>
        </div>
        <div className="flex shrink-0 gap-1">
          <button type="button" onClick={() => onMove(-1)} className={`${btnGhost} !px-2`} aria-label="Previous record" title="Previous record (↑)"><ChevronUp className="h-4 w-4" /></button>
          <button type="button" onClick={() => onMove(1)} className={`${btnGhost} !px-2`} aria-label="Next record" title="Next record (↓)"><ChevronDown className="h-4 w-4" /></button>
          <button type="button" onClick={onClose} className={`${btnGhost} !px-2`} aria-label="Close panel" title="Close (Esc)"><X className="h-4 w-4" /></button>
        </div>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {lockedDay && (
          <div className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-xs ring-1 ${locked ? "bg-secondary ring-border" : "bg-amber-500/10 ring-amber-500/40"}`}>
            <span className="flex items-center gap-2">
              {locked ? <Lock className="h-4 w-4 shrink-0 text-primary" /> : <LockOpen className="h-4 w-4 shrink-0 text-amber-600" />}
              {locked ? `Locked as paid (days up to ${lockedThrough}), so it can't change.` : "Unlocked on a locked day: it can change, and is paid by the current rules."}
            </span>
            <button type="button" onClick={() => onSetUnlocked(record.id, locked)} className={`${btnGhost} shrink-0 !px-2 !py-1 !text-xs`}>{locked ? "Unlock" : "Lock again"}</button>
          </div>
        )}
        <PayBreakdown record={record} employees={employees} shifts={shifts} line={line} />
        <Marks mark={mark} />
        {/* Keyed by the record's values, so the form starts again when the record changes underneath it (saved,
            undone with Ctrl+Z, or another record opened), and keeps the user's typing otherwise. */}
        <RecordForm key={fingerprint(record)} record={record} employees={employees} shifts={shifts} locked={locked}
          onChanged={onChanged} onDelete={onDelete} onDirty={onDirty} />
      </div>
    </aside>,
    document.body,
  );
}

const fingerprint = (r: RecordWithEmp) =>
  [r.id, r.employee_id, r.work_date, r.entry_mode, r.clock_in, r.clock_out, r.lunch_minutes, r.hours, r.pay_override, r.shift_id, r.note].join("|");

/** How the day's pay is worked out: rate that day, shift multiplier, regular and overtime lines, or why it's fixed. */
function PayBreakdown({ record, employees, shifts, line }: { record: RecordWithEmp; employees: Employee[]; shifts: Shift[]; line: PayLine | undefined }) {
  const { label } = useLabels();
  const { data: rates } = usePayRates();
  const { data: settings } = usePayrollSettings();
  const emp = employees.find((e) => e.id === record.employee_id);
  const shift = shiftForRecord(record.shift_id, emp?.shift_id, shifts);
  const rate = rateOn(rates?.get(record.employee_id), record.employees?.hourly_rate ?? 0, record.work_date);
  const otX = Number(settings?.ot_multiplier ?? 1.5);
  const hrs = (n: number) => `${Number(n.toFixed(2))} h`;
  const row = (k: string, v: React.ReactNode, sub?: string) => (
    <div className="flex justify-between gap-3 py-1">
      <span className="text-muted-foreground">{k}{sub && <span className="block text-[11px]">{sub}</span>}</span>
      <span className="text-right font-mono text-[13px]">{v}</span>
    </div>
  );

  let how: React.ReactNode;
  if (!line) how = <p className="text-muted-foreground">Working out pay…</p>;
  else if (record.frozen_pay && !record.unlocked) how = <p className="text-xs text-muted-foreground">Paid as saved when the day was locked, whatever the rates and rules say now.</p>;
  else if (line.manual) how = <p className="text-xs text-muted-foreground">Manual pay: the day pays this amount, whatever its hours.</p>;
  else if (line.salary) how = <p className="text-xs text-muted-foreground">Salaried: the week pays {settings?.ot_threshold ?? 40} h × {money(rate)}{shift.multiplier !== 1 ? ` × ${shift.multiplier}` : ""}, shared across its days by hours. No overtime.</p>;
  else how = (
    <>
      {row(label("reg_pay", "Reg pay"), money(line.regPay), `${hrs(line.regular)} × ${money(rate)}${shift.multiplier !== 1 ? ` × ${shift.multiplier} (${shift.name})` : ""}`)}
      {line.overtime > 0 && row(label("ot_pay", "OT pay"), money(line.otPay), `${hrs(line.overtime)} × ${money(rate)} × ${otX}${line.weekend ? " (weekend)" : " (past the weekly limit)"}`)}
    </>
  );

  return (
    <section className="text-sm">
      <h3 className="label-mono mb-1">Pay</h3>
      <div className="divide-y divide-border/60">
        {row(label("hourly_rate", "Rate"), `${money(rate)}/h`, "in force that day")}
        {row(label("shift", "Shift"), `${shift.name}${shift.multiplier !== 1 ? ` ×${shift.multiplier}` : ""}`, shift.changed ? "not their usual shift" : undefined)}
        {how}
        {line && <div className="flex justify-between gap-3 pt-2 font-semibold"><span>{label("total_pay", "Total pay")}</span><span className="font-mono">{money(line.pay)}</span></div>}
      </div>
    </section>
  );
}

/** The row's colour and tags, written out with why (the table only shows them on hover). */
function Marks({ mark }: { mark: RowMark }) {
  const all = [...(mark.row ? [mark.row] : []), ...mark.tags];
  if (!all.length) return null;
  return (
    <section className="text-sm">
      <h3 className="label-mono mb-1">Flags</h3>
      <ul className="space-y-1">
        {all.map((m) => (
          <li key={m.kind} className="flex gap-2">
            <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colourCss(m.colour) }} />
            <span><span className="font-medium">{MARKS[m.kind].label}</span> <span className="text-muted-foreground">· {m.detail}</span></span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The record's edit form. The database works out hours for clock entries when it's saved. */
function RecordForm({ record, employees, shifts, locked, onChanged, onDelete, onDirty }: {
  record: RecordWithEmp; employees: Employee[]; shifts: Shift[]; locked: boolean;
  onChanged: () => void; onDelete: (id: string) => void; onDirty: (dirty: boolean) => void;
}) {
  const { label } = useLabels();
  const start = {
    employee_id: record.employee_id, work_date: record.work_date, entry_mode: record.entry_mode as EntryMode,
    clock_in: record.clock_in?.slice(0, 5) ?? "09:00", clock_out: record.clock_out?.slice(0, 5) ?? "17:00",
    lunch_minutes: String(record.lunch_minutes ?? 0), hours: String(record.hours ?? 0), note: record.note ?? "",
    pay: record.pay_override === null || record.pay_override === undefined ? "" : String(record.pay_override),
    shift_id: record.shift_id ?? "",
  };
  const [f, setF] = useState(start);
  const dirty = (Object.keys(start) as (keyof typeof start)[]).some((k) => f[k] !== start[k]);
  // The list asks before moving to another record while this one has unsaved changes.
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  const usual = shiftFor(employees.find((e) => e.id === f.employee_id)?.shift_id, shifts);
  const [busy, setBusy] = useState(false);
  const [breakUnit] = useBreakUnit();
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });
  const hours = f.entry_mode === "clock" ? computeHours(f.clock_in, f.clock_out, Number(f.lunch_minutes) || 0) : Number(f.hours) || 0;

  const save = async () => {
    if (!f.employee_id) { toast.error("Pick an employee"); return; }
    if (!f.work_date) { toast.error("Pick a date"); return; }
    const lunch = Number(f.lunch_minutes), h = Number(f.hours);
    if (f.entry_mode === "clock" && (!f.clock_in || !f.clock_out)) { toast.error("Clock in and clock out are required"); return; }
    if (f.entry_mode === "clock" && !validBreak(lunch)) { toast.error(breakRangeText(breakUnit)); return; }
    if (f.entry_mode === "hours" && (!Number.isFinite(h) || h < 0 || h > 24)) { toast.error("Hours must be 0–24"); return; }
    const pay = f.pay.trim() === "" ? null : readAmount(f.pay);
    if (pay !== null && (!Number.isFinite(pay) || pay < 0 || pay > 100000)) { toast.error("Manual pay must be an amount from $0 to $100,000, or empty to calculate it"); return; }
    const base = { employee_id: f.employee_id, work_date: f.work_date, shift_id: f.shift_id && f.shift_id !== usual.id ? f.shift_id : null, note: f.note.trim().slice(0, 300) || null, pay_override: pay === null ? null : Math.round(pay * 100) / 100 };
    const patch = f.entry_mode === "clock"
      ? { ...base, entry_mode: "clock", clock_in: f.clock_in, clock_out: f.clock_out, lunch_minutes: lunch }
      : { ...base, entry_mode: "hours", hours: h, clock_in: null, clock_out: null, lunch_minutes: 0 };
    setBusy(true);
    const { error } = await db().update("time_records", record.id, patch);
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    toast.success(f.entry_mode !== record.entry_mode ? `Record saved and moved to ${f.entry_mode === "clock" ? "Clock in / out" : "Daily hours"}` : "Record saved");
    onChanged();
  };

  const field = "block space-y-1 text-xs text-muted-foreground";
  const input = `${inputCls} !py-1.5 text-sm text-foreground`;
  return (
    <form className="space-y-3 border-t border-border pt-4" onSubmit={(e) => { e.preventDefault(); if (dirty) save(); }}>
      <h3 className="label-mono">Edit</h3>
      {/* A disabled fieldset disables every control in it: a locked day can't change (the database refuses anyway). */}
      <fieldset disabled={locked || busy} className="space-y-3 disabled:opacity-60">
        <label className={field}>{label("employee", "Employee")}
          <EmployeePicker employees={employees} hideResigned value={f.employee_id} onChange={(id) => set("employee_id", id)} className="!py-1.5 text-sm" />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className={field}>{label("date", "Date")}
            <DateInput className={input} value={f.work_date} onChange={(v) => set("work_date", v)} aria-label="Date" />
          </label>
          <label className={field}>Entry type
            <select className={input} value={f.entry_mode} onChange={(e) => set("entry_mode", e.target.value)}>
              <option value="clock">Clock in / out</option>
              <option value="hours">Daily hours</option>
            </select>
          </label>
        </div>
        <label className={field}>{label("shift", "Shift")}
          <RecordShiftSelect value={f.shift_id === usual.id ? "" : f.shift_id} onChange={(id) => set("shift_id", id)} shifts={shifts} ownLabel={`Usual (${usual.name})`} className={input} />
        </label>
        {f.entry_mode === "clock" ? (
          <div className="grid grid-cols-3 gap-3">
            <label className={field}>{label("clock_in", "Clock in")}
              <input type="time" className={input} value={f.clock_in} onChange={(e) => set("clock_in", e.target.value)} />
            </label>
            <label className={field}>{label("clock_out", "Clock out")}
              <input type="time" className={input} value={f.clock_out} onChange={(e) => set("clock_out", e.target.value)} />
            </label>
            <label className={field}>{label("break", "Break")} ({breakUnit})
              <BreakInput minutes={f.lunch_minutes} onChange={(m) => set("lunch_minutes", m)} className={`${input} text-right`} />
            </label>
            <p className="col-span-3 text-xs text-muted-foreground">{label("hours", "Hours")}: <span className="font-mono text-foreground">{hours.toFixed(2)}</span>
              {record.entry_mode === "hours" && " (switching to clock in / out)"}</p>
          </div>
        ) : (
          <label className={field}>{label("hours", "Hours")}
            <input type="number" step="0.25" min={0} max={24} className={`${input} text-right`} value={f.hours} onChange={(e) => set("hours", e.target.value)} />
            {record.entry_mode === "clock" && <span className="block">Switching to daily hours: clock times will be removed.</span>}
          </label>
        )}
        <label className={field}>Manual pay
          <input className={`${input} text-right`} inputMode="decimal" value={f.pay} placeholder="auto: from the hours" onChange={(e) => set("pay", e.target.value)} />
          <span className="block">Pays the day exactly this amount. Leave empty to calculate it.</span>
        </label>
        <label className={field}>{label("note", "Note")}
          <input className={input} value={f.note} onChange={(e) => set("note", e.target.value)} />
        </label>
      </fieldset>
      {!locked && (
        <div className="flex items-center justify-between gap-2 pt-1">
          <button type="button" onClick={() => onDelete(record.id)} className={`${btnGhost} hover:!text-destructive`}><Trash2 className="mr-1 inline h-4 w-4" />Delete</button>
          <span className="flex gap-2">
            {dirty && <button type="button" onClick={() => setF(start)} className={btnGhost}>Undo changes</button>}
            <button type="submit" disabled={!dirty || busy} className={btnPrimary}>Save</button>
          </span>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">Added {new Date(record.created_at).toLocaleString()}</p>
    </form>
  );
}
