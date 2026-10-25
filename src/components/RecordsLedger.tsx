import { useState } from "react";
import { toast } from "sonner";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { db } from "@/lib/db/mode";
import { btnGhost, inputCls } from "@/components/AppShell";
import { EmployeePicker } from "@/components/EmployeeSearch";
import { RECORD_PAY_COLUMNS, RecordPayCells, RecordPayHeaders } from "@/components/RecordPay";
import { computeHours, fullName, money, useRecordPay, weekday, type Employee, type RecordWithEmp } from "@/lib/payroll";

export type EntryMode = "clock" | "hours";

/** The Time records table: one entry type at a time, selectable rows, inline editing, and a "load more" footer. */
export function RecordsLedger({ rows, total, mode, onModeChange, employees, selected, onToggle, onToggleAll, onChanged, onDelete, footer, title }: {
  rows: RecordWithEmp[]; total: number; mode: EntryMode; onModeChange: (m: EntryMode) => void; employees: Employee[];
  selected: Set<string>; onToggle: (id: string) => void; onToggleAll: () => void;
  onChanged: () => void; onDelete: (id: string) => void; footer?: React.ReactNode; title: React.ReactNode;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const allPicked = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const cols = (mode === "clock" ? 10 : 7) + RECORD_PAY_COLUMNS;
  const pay = useRecordPay(rows);

  return (
    <div className="glass-panel overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="font-display font-extrabold tracking-tight">{title}</div>
        <div className="flex rounded-xl bg-secondary p-1 text-xs font-medium ring-1 ring-border">
          {(["clock", "hours"] as const).map((m) => (
            <button key={m} onClick={() => { setEditing(null); onModeChange(m); }}
              className={`rounded-lg px-3 py-1.5 ${mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              {m === "clock" ? "Clock in / out" : "Daily hours"}
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
              <th className="w-10 pl-5"><input type="checkbox" aria-label="Select all loaded" checked={allPicked} onChange={onToggleAll} disabled={!rows.length} /></th>
              <th className="px-3 py-3 text-left font-medium">Employee</th>
              <th className="px-3 py-3 text-left font-medium">Date</th>
              {mode === "clock" && (
                <>
                  <th className="px-3 py-3 text-left font-medium">Clock in</th>
                  <th className="px-3 py-3 text-left font-medium">Clock out</th>
                  <th className="px-3 py-3 text-right font-medium">Lunch min</th>
                </>
              )}
              <th className="px-3 py-3 text-right font-medium">Hours</th>
              <th className="px-3 py-3 text-right font-medium">Rate</th>
              <RecordPayHeaders />
              <th className="px-3 py-3 text-left font-medium">Note</th>
              <th className="w-20" />
            </tr>
          </thead>
          <tbody className="font-mono text-[13px]">
            {rows.length === 0 && (
              <tr><td colSpan={cols} className="px-5 py-10 text-center font-body text-muted-foreground">
                No {mode === "clock" ? "clock in/out" : "daily hours"} records match.
              </td></tr>
            )}
            {rows.map((r) => editing === r.id ? (
              <EditRow key={r.id} record={r} employees={employees} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged(); }} />
            ) : (
              <tr key={r.id} className={`border-b border-border last:border-0 hover:bg-secondary ${selected.has(r.id) ? "bg-accent/40" : ""}`}>
                <td className="pl-5"><input type="checkbox" aria-label="Select record" checked={selected.has(r.id)} onChange={() => onToggle(r.id)} /></td>
                <td className="px-3 py-3 font-body">{r.employees ? fullName(r.employees) : "—"}</td>
                <td className="whitespace-nowrap px-3 py-3"><span className="inline-block w-9 font-body text-muted-foreground">{weekday(r.work_date)}</span>{r.work_date}</td>
                {mode === "clock" && (
                  <>
                    <td className="px-3 py-3">{r.clock_in?.slice(0, 5)}</td>
                    <td className="px-3 py-3">{r.clock_out?.slice(0, 5)}</td>
                    <td className="px-3 py-3 text-right">{r.lunch_minutes}</td>
                  </>
                )}
                <td className="px-3 py-3 text-right">{Number(r.hours).toFixed(2)}</td>
                <td className="px-3 py-3 text-right">{money(Number(r.employees?.hourly_rate ?? 0))}</td>
                <RecordPayCells line={pay?.get(r.id)} />
                <td className="max-w-[14rem] truncate px-3 py-3 font-body text-xs text-muted-foreground" title={r.note ?? ""}>{r.note}</td>
                <td className="pr-4">
                  <div className="flex justify-end gap-3 text-muted-foreground">
                    <button onClick={() => setEditing(r.id)} aria-label="Edit record"><Pencil className="h-4 w-4 hover:text-foreground" /></button>
                    <button onClick={() => onDelete(r.id)} aria-label="Delete record"><Trash2 className="h-4 w-4 hover:text-destructive" /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3 text-xs text-muted-foreground">
        <span>Showing {rows.length} of {total}</span>
        {footer}
      </div>
    </div>
  );
}

/** One record being edited in place. The database recalculates hours for clock entries on save. */
function EditRow({ record, employees, onCancel, onSaved }: { record: RecordWithEmp; employees: Employee[]; onCancel: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    employee_id: record.employee_id, work_date: record.work_date, entry_mode: record.entry_mode as EntryMode,
    clock_in: record.clock_in?.slice(0, 5) ?? "09:00", clock_out: record.clock_out?.slice(0, 5) ?? "17:00",
    lunch_minutes: String(record.lunch_minutes ?? 0), hours: String(record.hours ?? 0), note: record.note ?? "",
    pay: record.pay_override === null || record.pay_override === undefined ? "" : String(record.pay_override),
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });
  const hours = f.entry_mode === "clock" ? computeHours(f.clock_in, f.clock_out, Number(f.lunch_minutes) || 0) : Number(f.hours) || 0;

  const save = async () => {
    if (!f.employee_id) { toast.error("Pick an employee"); return; }
    if (!f.work_date) { toast.error("Pick a date"); return; }
    const lunch = Number(f.lunch_minutes), h = Number(f.hours);
    if (f.entry_mode === "clock" && (!f.clock_in || !f.clock_out)) { toast.error("Clock in and clock out are required"); return; }
    if (f.entry_mode === "clock" && (!Number.isFinite(lunch) || lunch < 0 || lunch > 600)) { toast.error("Lunch minutes must be 0–600"); return; }
    if (f.entry_mode === "hours" && (!Number.isFinite(h) || h < 0 || h > 24)) { toast.error("Hours must be 0–24"); return; }
    const pay = f.pay.trim() === "" ? null : Number(f.pay.replace(/[$,\s]/g, ""));
    if (pay !== null && (!Number.isFinite(pay) || pay < 0 || pay > 100000)) { toast.error("Manual pay must be an amount from $0 to $100,000, or empty to calculate it"); return; }
    const base = { employee_id: f.employee_id, work_date: f.work_date, note: f.note.trim().slice(0, 300) || null, pay_override: pay === null ? null : Math.round(pay * 100) / 100 };
    const patch = f.entry_mode === "clock"
      ? { ...base, entry_mode: "clock", clock_in: f.clock_in, clock_out: f.clock_out, lunch_minutes: lunch }
      : { ...base, entry_mode: "hours", hours: h, clock_in: null, clock_out: null, lunch_minutes: 0 };
    setBusy(true);
    const { error } = await db().update("time_records", record.id, patch);
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    toast.success(f.entry_mode !== record.entry_mode ? `Record saved and moved to ${f.entry_mode === "clock" ? "Clock in / out" : "Daily hours"}` : "Record saved");
    onSaved();
  };

  const cell = "px-1.5 py-2 align-top";
  const input = `${inputCls} !px-2 !py-1.5 text-[13px]`;
  return (
    <tr className="border-b border-border bg-accent/50" onKeyDown={(e) => { if (e.key === "Escape") onCancel(); if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") save(); }}>
      <td className="pl-5 align-top pt-4"><Pencil className="h-3.5 w-3.5 text-primary" /></td>
      <td className={cell}><EmployeePicker employees={employees} value={f.employee_id} onChange={(id) => set("employee_id", id)} className="min-w-[12rem] !py-1.5 text-[13px]" /></td>
      <td className={cell}>
        <input type="date" className={input} value={f.work_date} onChange={(e) => set("work_date", e.target.value)} aria-label="Date" />
        <select className={`${input} mt-1`} value={f.entry_mode} onChange={(e) => set("entry_mode", e.target.value)} aria-label="Entry type">
          <option value="clock">Clock in / out</option>
          <option value="hours">Daily hours</option>
        </select>
      </td>
      {record.entry_mode === "clock" && (
        f.entry_mode === "clock" ? (
          <>
            <td className={cell}><input type="time" className={input} value={f.clock_in} onChange={(e) => set("clock_in", e.target.value)} aria-label="Clock in" /></td>
            <td className={cell}><input type="time" className={input} value={f.clock_out} onChange={(e) => set("clock_out", e.target.value)} aria-label="Clock out" /></td>
            <td className={cell}><input type="number" min={0} max={600} className={`${input} w-20 text-right`} value={f.lunch_minutes} onChange={(e) => set("lunch_minutes", e.target.value)} aria-label="Lunch minutes" /></td>
          </>
        ) : <td colSpan={3} className={`${cell} pt-4 font-body text-xs text-muted-foreground`}>Switching to daily hours: clock times will be removed.</td>
      )}
      <td className={`${cell} text-right`}>
        {f.entry_mode === "hours"
          ? <input type="number" step="0.25" min={0} max={24} className={`${input} w-20 text-right`} value={f.hours} onChange={(e) => set("hours", e.target.value)} aria-label="Hours" />
          : <div className="pt-2">{hours.toFixed(2)}</div>}
        {record.entry_mode === "hours" && f.entry_mode === "clock" && (
          <div className="mt-1 flex gap-1">
            <input type="time" className={input} value={f.clock_in} onChange={(e) => set("clock_in", e.target.value)} aria-label="Clock in" />
            <input type="time" className={input} value={f.clock_out} onChange={(e) => set("clock_out", e.target.value)} aria-label="Clock out" />
            <input type="number" min={0} className={`${input} w-16`} value={f.lunch_minutes} onChange={(e) => set("lunch_minutes", e.target.value)} aria-label="Lunch minutes" title="Lunch minutes" />
          </div>
        )}
      </td>
      <td className={`${cell} pt-4 text-right text-muted-foreground`}>—</td>
      <td colSpan={RECORD_PAY_COLUMNS - 1} className={`${cell} pt-4 text-right font-body text-xs text-muted-foreground`}>Pay is recalculated on save. Manual pay →</td>
      <td className={`${cell} text-right`}>
        <input className={`${input} w-24 text-right`} inputMode="decimal" value={f.pay} placeholder="auto" onChange={(e) => set("pay", e.target.value)} aria-label="Manual pay" title="Pay for this day. Leave empty to calculate it from hours." />
      </td>
      <td className={cell}><input className={`${input} min-w-[8rem] font-body`} value={f.note} placeholder="Note" onChange={(e) => set("note", e.target.value)} aria-label="Note" /></td>
      <td className={`${cell} pr-4`}>
        <div className="flex justify-end gap-1 pt-1">
          <button onClick={save} disabled={busy} className={`${btnGhost} !px-2 !py-1 !text-primary`} aria-label="Save record"><Check className="h-4 w-4" /></button>
          <button onClick={onCancel} className={`${btnGhost} !px-2 !py-1`} aria-label="Cancel editing"><X className="h-4 w-4" /></button>
        </div>
      </td>
    </tr>
  );
}
