import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Lock, LockOpen, PanelRightOpen, Trash2 } from "lucide-react";
import { db } from "@/lib/db/mode";
import { setRecordsLocked } from "@/lib/pay-freeze";
import { btnGhost } from "@/components/AppShell";
import { RECORD_PAY_COLUMNS, RecordPayCells, RecordPayHeaders, RecordShiftCell } from "@/components/RecordPay";
import { fullName, money, usePayRates, usePayrollSettings, useRecordPay, useShifts, weekday, type Employee, type RecordWithEmp } from "@/lib/payroll";
import { rateOn } from "@/lib/pay-rates";
import { BreakHeader, BreakUnitToggle } from "@/components/BreakField";
import { DataTable } from "./DataTable";
import { formatBreak, useBreakUnit } from "@/lib/breaks";
import { EditableLabel } from "@/components/EditableLabel";
import { EmployeeLink } from "@/components/EmployeeLink";
import { MarkTags, MarksPanel, markedRow, RowMarksButton, useRowMarks } from "@/components/RowMarks";
import { RecordPanel } from "@/components/RecordPanel";

export type EntryMode = "clock" | "hours";

/** The Time records table: one entry type at a time, selectable rows, a side panel to see and edit a record, and a "load more" footer. */
export function RecordsLedger({ rows, total, mode, onModeChange, employees, selected, onToggle, onToggleAll, onChanged, onDelete, footer, title }: {
  rows: RecordWithEmp[]; total: number; mode: EntryMode; onModeChange: (m: EntryMode) => void; employees: Employee[];
  selected: Set<string>; onToggle: (id: string) => void; onToggleAll: () => void;
  onChanged: () => void; onDelete: (id: string) => void; footer?: React.ReactNode; title: React.ReactNode;
}) {
  const allPicked = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const cols = (mode === "clock" ? 11 : 8) + RECORD_PAY_COLUMNS;
  const pay = useRecordPay(rows);
  const { data: rateHistory } = usePayRates();
  // Days locked as paid can't change (the database refuses), so their rows offer no edit or delete, only unlocking that one.
  const lockedThrough = usePayrollSettings().data?.locked_through ?? null;
  const setUnlocked = async (id: string, unlocked: boolean) => {
    const r = rows.find((x) => x.id === id);
    if (!r) return;
    const { error } = await setRecordsLocked(db(), [r], !unlocked);
    if (error) { toast.error(error.message); return; }
    toast.success(unlocked ? "Unlocked: it can be changed, and is paid by the current rules until you lock it again. Ctrl+Z puts its locked pay back." : "Locked again, with its pay saved as it is now");
    onChanged();
  };
  const { data: shifts = [] } = useShifts();
  const [breakUnit] = useBreakUnit();
  const empById = new Map(employees.map((e) => [e.id, e]));
  const markOf = useRowMarks(rows, employees, pay, lockedThrough);
  const [marksOpen, setMarksOpen] = useState(false);

  // The side panel: which record is open. It stays open while the list changes, and closes by itself when its record
  // leaves the list (deleted, filtered out, or moved to the other entry type by an edit).
  const [openId, setOpenId] = useState<string | null>(null);
  const openIndex = openId ? rows.findIndex((r) => r.id === openId) : -1;
  const openRecord = openIndex >= 0 ? rows[openIndex] : undefined;
  // Unsaved changes in the panel's form, so moving to another record asks first. A ref, not state: it's only read
  // when moving, and setting it on every keystroke shouldn't re-render the whole table.
  const dirty = useRef(false);
  const onDirty = useCallback((d: boolean) => { dirty.current = d; }, []);
  const open = useCallback((id: string | null) => {
    if (dirty.current && !confirm("Leave this record without saving your changes?")) return false;
    dirty.current = false;
    setOpenId(id);
    return true;
  }, []);
  const move = (step: -1 | 1) => {
    const next = rows[openIndex + step];
    if (next && open(next.id)) document.querySelector(`[data-record="${next.id}"]`)?.scrollIntoView({ block: "nearest" });
  };
  // Escape closes the panel; ↑/↓ step through the list, except while typing in a field (where they move the caret
  // or change a number).
  const moveRef = useRef(move);
  moveRef.current = move;
  useEffect(() => {
    if (!openId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === "Escape") { open(null); return; }
      const t = e.target as HTMLElement;
      if (t.closest("input, select, textarea, [contenteditable=true]")) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); moveRef.current(e.key === "ArrowDown" ? 1 : -1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId, open]);

  return (
    <div className="glass-panel overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="font-display font-extrabold tracking-tight">{title}</div>
        <div className="flex flex-wrap items-center gap-3">
        <RowMarksButton open={marksOpen} onToggle={() => setMarksOpen((o) => !o)} />
        {mode === "clock" && <span className="flex items-center gap-2 text-xs text-muted-foreground">Breaks in <BreakUnitToggle /></span>}
        <div className="flex rounded-xl bg-secondary p-1 text-xs font-medium ring-1 ring-border">
          {(["clock", "hours"] as const).map((m) => (
            <button key={m} onClick={() => { if (open(null)) onModeChange(m); }}
              className={`rounded-lg px-3 py-1.5 ${mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              {m === "clock" ? "Clock in / out" : "Daily hours"}
            </button>
          ))}
        </div>
        </div>
      </div>
      {marksOpen && <MarksPanel onClose={() => setMarksOpen(false)} />}
      <div className="overflow-x-auto">
        <DataTable id="records" className="w-full text-sm" stickyHeader>
          <thead className="grid-head">
            <tr className="font-mono text-[11px] uppercase tracking-[0.12em]">
              <th className="w-10 pl-5"><input type="checkbox" aria-label="Select all loaded" checked={allPicked} onChange={onToggleAll} disabled={!rows.length} /></th>
              <th className="px-3 py-3 text-left font-medium"><EditableLabel k="employee" name="Employee" /></th>
              <th className="px-3 py-3 text-left font-medium"><EditableLabel k="date" name="Date" /></th>
              <th className="px-3 py-3 text-left font-medium"><EditableLabel k="shift" name="Shift" /></th>
              {mode === "clock" && (
                <>
                  <th className="px-3 py-3 text-left font-medium"><EditableLabel k="clock_in" name="Clock in" /></th>
                  <th className="px-3 py-3 text-left font-medium"><EditableLabel k="clock_out" name="Clock out" /></th>
                  <th className="px-3 py-3 text-right font-medium"><BreakHeader unit={breakUnit} /></th>
                </>
              )}
              <th className="px-3 py-3 text-right font-medium"><EditableLabel k="hours" name="Hours" /></th>
              <th className="px-3 py-3 text-right font-medium"><EditableLabel k="hourly_rate" name="Rate" /></th>
              <RecordPayHeaders />
              <th className="px-3 py-3 text-left font-medium"><EditableLabel k="note" name="Note" /></th>
              <th className="w-20" />
            </tr>
          </thead>
          <tbody className="font-mono text-[13px]">
            {rows.length === 0 && (
              <tr><td colSpan={cols} className="px-5 py-10 text-center font-body text-muted-foreground">
                No {mode === "clock" ? "clock in/out" : "daily hours"} records match.
              </td></tr>
            )}
            {rows.map((r) => {
              const mark = markOf(r);
              const look = markedRow(mark);
              return (
              <tr key={r.id} data-record={r.id} style={look.style} title={look.title}
                // A click anywhere on the row opens it in the panel, except on its own controls (tick box, name, buttons)
                // or when the click ended a text selection (copying a value shouldn't open anything).
                onClick={(e) => { if (!(e.target as HTMLElement).closest("a, button, input, label") && !getSelection()?.toString()) open(r.id); }}
                className={`cursor-pointer border-b border-border last:border-0 hover:bg-secondary ${look.className} ${selected.has(r.id) ? "bg-accent/40" : ""} ${r.id === openId ? "outline outline-2 -outline-offset-2 outline-primary" : ""}`}>
                <td className="pl-5"><input type="checkbox" aria-label="Select record" checked={selected.has(r.id)} onChange={() => onToggle(r.id)} /></td>
                <td className="px-3 py-3 font-body">{r.employees ? <EmployeeLink id={r.employee_id} name={fullName(r.employees)} /> : "—"}</td>
                <td className="whitespace-nowrap px-3 py-3"><span className="inline-block w-9 font-body text-muted-foreground">{weekday(r.work_date)}</span>{r.work_date}<MarkTags tags={mark.tags} /></td>
                <RecordShiftCell shiftId={r.shift_id} employeeShiftId={empById.get(r.employee_id)?.shift_id} shifts={shifts} />
                {mode === "clock" && (
                  <>
                    <td className="px-3 py-3">{r.clock_in?.slice(0, 5)}</td>
                    <td className="px-3 py-3">{r.clock_out?.slice(0, 5)}</td>
                    <td className="px-3 py-3 text-right">{formatBreak(r.lunch_minutes, breakUnit)}</td>
                  </>
                )}
                <td className="px-3 py-3 text-right">{Number(r.hours).toFixed(2)}</td>
                <td className="px-3 py-3 text-right">{money(rateOn(rateHistory?.get(r.employee_id), r.employees?.hourly_rate ?? 0, r.work_date))}</td>
                <RecordPayCells line={pay?.get(r.id)} />
                <td className="px-3 py-3 font-body text-xs text-muted-foreground">{r.note}</td>
                <td className="pl-3 pr-6">
                  <div className="flex justify-end gap-3.5 text-muted-foreground">
                    {lockedThrough && r.work_date <= lockedThrough && !r.unlocked ? (
                      <button onClick={() => setUnlocked(r.id, true)} title={`Locked as paid (days up to ${lockedThrough}). Click to unlock just this record.`} aria-label="Locked as paid: unlock this record"><Lock className="h-4 w-4 text-primary hover:text-foreground" /></button>
                    ) : (
                      <>
                        {lockedThrough && r.work_date <= lockedThrough && (
                          <button onClick={() => setUnlocked(r.id, false)} title="Unlocked on a locked day. Click to lock it again." aria-label="Lock this record again"><LockOpen className="h-4 w-4 text-amber-600 hover:text-foreground" /></button>
                        )}
                        <button onClick={() => open(r.id)} aria-label="Open record" title="See and edit this record"><PanelRightOpen className="h-4 w-4 hover:text-foreground" /></button>
                        <button onClick={() => onDelete(r.id)} aria-label="Delete record"><Trash2 className="h-4 w-4 hover:text-destructive" /></button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </DataTable>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3 text-xs text-muted-foreground">
        <span>Showing {rows.length} of {total}</span>
        {footer}
      </div>
      {openRecord && (
        <RecordPanel record={openRecord} employees={employees} shifts={shifts} line={pay?.get(openRecord.id)} mark={markOf(openRecord)}
          lockedThrough={lockedThrough} position={`${openIndex + 1} of ${rows.length}${total > rows.length ? ` loaded (${total} in all)` : ""}`}
          onMove={move} onClose={() => open(null)} onChanged={onChanged} onDelete={onDelete} onSetUnlocked={setUnlocked} onDirty={onDirty} />
      )}
    </div>
  );
}
