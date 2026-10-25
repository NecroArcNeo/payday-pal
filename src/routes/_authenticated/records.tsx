import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { db, storeFor, useDataMode } from "@/lib/db/mode";
import { backupBefore } from "@/lib/db/safety";
import type { RecordFilter } from "@/lib/db/store";
import type { TablesInsert } from "@/integrations/supabase/types";
import { AppShell, btnGhost, btnPrimary, inputCls } from "@/components/AppShell";
import { RecordsLedger, type EntryMode } from "@/components/RecordsLedger";
import { EmployeePicker, SearchInput } from "@/components/EmployeeSearch";
import { describeEmployeeFilter, isFiltering, matchesEmployee, NO_FILTER, searchEmployees, type EmployeeFilter } from "@/lib/employee-search";
import { addDays, computeHours, fullName, isoDate, useEmployees, weekday, type Employee, type TimeRecord } from "@/lib/payroll";
import { Pencil, Trash2, X } from "lucide-react";

export const Route = createFileRoute("/_authenticated/records")({
  head: () => ({ meta: [{ title: "Time records — Meridian Payroll" }] }),
  component: RecordsPage,
});

/** Records shown at first, and added by each "Load more". */
const PAGE = 50;

function RecordsPage() {
  const qc = useQueryClient();
  const dataMode = useDataMode();
  const { data: employees = [] } = useEmployees();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [mode, setMode] = useState<"clock" | "hours">("clock");
  const [f, setF] = useState({ work_date: isoDate(new Date()), clock_in: "09:00", clock_out: "17:00", lunch_minutes: "30", hours: "8", pay: "" });
  const [picked, setPicked] = useState<string[]>([]);
  const [pickQ, setPickQ] = useState<EmployeeFilter>(NO_FILTER);
  const [listQ, setListQ] = useState<EmployeeFilter>(NO_FILTER);
  const shownEmployees = useMemo(() => searchEmployees(employees, pickQ), [employees, pickQ]);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const preview = mode === "clock" ? computeHours(f.clock_in, f.clock_out, Number(f.lunch_minutes) || 0) : Number(f.hours) || 0;

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (picked.length === 0) { toast.error("Pick at least one employee"); return; }
    const lunch = Number(f.lunch_minutes);
    const hours = Number(f.hours);
    if (mode === "clock" && (!Number.isFinite(lunch) || lunch < 0 || lunch > 600)) { toast.error("Lunch minutes must be 0–600"); return; }
    if (mode === "hours" && (!Number.isFinite(hours) || hours < 0 || hours > 24)) { toast.error("Hours must be 0–24"); return; }
    const pay = f.pay.trim() === "" ? null : Number(f.pay.replace(/[$,\s]/g, ""));
    if (pay !== null && (!Number.isFinite(pay) || pay < 0 || pay > 100000)) { toast.error("Day pay must be an amount from $0 to $100,000, or empty"); return; }
    const manual = pay === null ? {} : { pay_override: Math.round(pay * 100) / 100 };
    const rows: TablesInsert<"time_records">[] = picked.map((employee_id) =>
      mode === "clock"
        ? { employee_id, work_date: f.work_date, entry_mode: "clock", clock_in: f.clock_in, clock_out: f.clock_out, lunch_minutes: lunch, ...manual }
        : { employee_id, work_date: f.work_date, entry_mode: "hours", hours, ...manual });
    const { error } = await db().insert("time_records", rows);
    if (error) { toast.error(error.message); return; }
    toast.success(rows.length === 1 ? "Record added" : `${rows.length} records added`);
    setPicked([]);
    setF((x) => ({ ...x, pay: "" }));
    qc.invalidateQueries({ queryKey: ["records"] });
  };

  const del = async (id: string) => {
    const { error } = await db().remove("time_records", id);
    if (error) { toast.error(error.message); return; }
    qc.invalidateQueries({ queryKey: ["records"] });
  };

  // ---- the list: filtered in the database, loaded a page at a time
  const [listMode, setListMode] = useState<EntryMode>("clock");
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<null | "selected" | "all">(null);
  const filter = useMemo<RecordFilter>(() => ({
    from: from || undefined, to: to || undefined, mode: listMode,
    employeeIds: isFiltering(listQ) ? employees.filter((e) => matchesEmployee(e, listQ)).map((e) => e.id) : undefined,
  }), [from, to, listMode, listQ, employees]);
  const filterKey = JSON.stringify(filter);
  // A new filter starts again from the first page, with nothing selected.
  useEffect(() => { setLimit(PAGE); setSelected(new Set()); setBulk(null); }, [filterKey]);
  const page = useQuery({
    queryKey: ["records", "page", dataMode, filterKey, limit],
    queryFn: () => storeFor(dataMode).listRecordsPage(filter, 0, limit),
    placeholderData: keepPreviousData,
  });
  const rows = page.data?.rows ?? [];
  const total = page.data?.total ?? 0;
  const pickedRows = rows.filter((r) => selected.has(r.id));
  const toggleRow = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAllRows = () => setSelected((s) => (rows.length && rows.every((r) => s.has(r.id)) ? new Set() : new Set(rows.map((r) => r.id))));
  const refresh = () => qc.invalidateQueries({ queryKey: ["records"] });
  const describeFilter = [
    listMode === "clock" ? "clock in/out" : "daily-hours",
    from || to ? `from ${from ? `${weekday(from)} ${from}` : "the start"} to ${to ? `${weekday(to)} ${to}` : "the latest"}` : "",
    isFiltering(listQ) ? `for employees matching ${describeEmployeeFilter(listQ)}` : "",
  ].filter(Boolean).join(" ");

  const deleteMany = async (which: "selected" | "all") => {
    const n = which === "selected" ? pickedRows.length : total;
    if (!confirm(`Delete ${n} ${describeFilter} record${n === 1 ? "" : "s"}${which === "selected" ? " that you selected" : ""}?\n\nA backup is saved first, so you can restore it from Sync & backup.`)) return;
    try {
      const ids = which === "selected" ? pickedRows.map((r) => r.id) : (await storeFor(dataMode).listRecordsMatching(filter)).map((r) => r.id);
      await backupBefore("record-delete");
      const { error } = await db().removeMany("time_records", ids);
      if (error) throw error;
      toast.success(`Deleted ${ids.length} record${ids.length === 1 ? "" : "s"}. A backup was saved in Sync & backup.`);
      setSelected(new Set());
      refresh();
    } catch (e) {
      toast.error(`Nothing was deleted: ${(e as Error).message}`);
    }
  };

  return (
    <AppShell eyebrow="Ledger" title="Time records">
      <form onSubmit={add} className="glass-panel space-y-4 p-5">
        <div className="flex items-center justify-between">
          <div className="font-display font-extrabold tracking-tight">New record</div>
          <div className="flex rounded-xl bg-secondary p-1 text-xs font-medium ring-1 ring-border">
            {(["clock", "hours"] as const).map((m) => (
              <button type="button" key={m} onClick={() => setMode(m)} className={`rounded-lg px-3 py-1.5 ${mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                {m === "clock" ? "Clock in / out" : "Daily hours"}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="label-mono">Employees · {picked.length} selected</span>
            <div className="flex gap-3 text-xs text-muted-foreground">
              <button type="button" className="hover:text-foreground"
                onClick={() => setPicked((p) => [...new Set([...p, ...shownEmployees.filter((e) => e.active).map((e) => e.id)])])}>
                {isFiltering(pickQ) ? `Select all ${shownEmployees.filter((e) => e.active).length} shown` : "Select all"}
              </button>
              <button type="button" className="hover:text-foreground" onClick={() => setPicked([])}>Clear</button>
            </div>
          </div>
          <SearchInput value={pickQ} onChange={setPickQ} employees={employees} className="mb-2" />
          <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
            {employees.length === 0 && <span className="text-sm text-muted-foreground">No employees yet.</span>}
            {employees.length > 0 && shownEmployees.length === 0 && <span className="text-sm text-muted-foreground">No employee matches {describeEmployeeFilter(pickQ)}.</span>}
            {shownEmployees.map((e) => {
              const on = picked.includes(e.id);
              return (
                <button type="button" key={e.id} onClick={() => toggle(e.id)}
                  className={`rounded-lg px-3 py-1.5 text-sm ring-1 ring-border ${on ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`}>
                  {fullName(e)} <span className="font-mono text-[11px] opacity-70">{e.employee_code}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="grid items-end gap-3 md:grid-cols-7">
          <label><span className="label-mono">Date{f.work_date && ` · ${weekday(f.work_date)}`}</span><input type="date" className={`${inputCls} mt-1`} value={f.work_date} onChange={(e) => setF({ ...f, work_date: e.target.value })} required /></label>
          {mode === "clock" ? (
            <>
              <label><span className="label-mono">Clock in</span><input type="time" className={`${inputCls} mt-1`} value={f.clock_in} onChange={(e) => setF({ ...f, clock_in: e.target.value })} required /></label>
              <label><span className="label-mono">Clock out</span><input type="time" className={`${inputCls} mt-1`} value={f.clock_out} onChange={(e) => setF({ ...f, clock_out: e.target.value })} required /></label>
              <label><span className="label-mono">Lunch (min)</span><input type="number" min={0} className={`${inputCls} mt-1`} value={f.lunch_minutes} onChange={(e) => setF({ ...f, lunch_minutes: e.target.value })} /></label>
            </>
          ) : (
            <label className="md:col-span-3"><span className="label-mono">Hours worked</span><input type="number" step="0.25" min={0} max={24} className={`${inputCls} mt-1`} value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} /></label>
          )}
          <label title="Leave empty to pay from hours. Enter an amount to pay exactly that for the day.">
            <span className="label-mono">Day pay (optional)</span>
            <input className={`${inputCls} mt-1`} inputMode="decimal" placeholder="auto" value={f.pay} onChange={(e) => setF({ ...f, pay: e.target.value })} />
          </label>
          <div>
            <div className="mb-1 text-right font-mono text-[11px] text-muted-foreground">{preview.toFixed(2)} h</div>
            <button className={`${btnPrimary} w-full`}>Add</button>
          </div>
        </div>
      </form>

      <div className="flex flex-wrap items-center gap-3">
        <span className="label-mono">Filter</span>
        <input type="date" className={`${inputCls} max-w-[11rem]`} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
        <span className="text-muted-foreground">→</span>
        <input type="date" className={`${inputCls} max-w-[11rem]`} value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
        <SearchInput value={listQ} onChange={setListQ} employees={employees} placeholder="Filter by employee name, ID, position, department…" className="min-w-[16rem] flex-1" />
      </div>

      {bulk && (
        <BulkRecordEdit
          mode={listMode} employees={employees}
          label={bulk === "selected" ? `${pickedRows.length} selected record${pickedRows.length === 1 ? "" : "s"}` : `all ${total} ${describeFilter} records`}
          load={async () => (bulk === "selected" ? pickedRows : storeFor(dataMode).listRecordsMatching(filter))}
          onClose={() => setBulk(null)} onDone={() => { setBulk(null); setSelected(new Set()); refresh(); }}
        />
      )}

      {selected.size > 0 && (
        <div className="glass-panel flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
          <span className="font-semibold">{selected.size} selected</span>
          <div className="flex gap-2">
            <button onClick={() => setBulk("selected")} className={btnPrimary}><Pencil className="mr-1 inline h-4 w-4" />Edit selected</button>
            <button onClick={() => deleteMany("selected")} className={`${btnGhost} hover:!text-destructive`}><Trash2 className="mr-1 inline h-4 w-4" />Delete selected</button>
            <button onClick={() => setSelected(new Set())} className={btnGhost} aria-label="Clear selection"><X className="h-4 w-4" /></button>
          </div>
        </div>
      )}

      <RecordsLedger
        title={<>{total} records{page.isFetching && <span className="ml-2 text-xs font-normal text-muted-foreground">loading…</span>}</>}
        rows={rows} total={total} mode={listMode} onModeChange={setListMode} employees={employees}
        selected={selected} onToggle={toggleRow} onToggleAll={toggleAllRows} onChanged={refresh} onDelete={del}
        footer={
          <div className="flex flex-wrap items-center gap-2">
            {total > 0 && <button onClick={() => setBulk("all")} className={btnGhost}>Edit all {total}</button>}
            {total > 0 && <button onClick={() => deleteMany("all")} className={`${btnGhost} hover:!text-destructive`}>Delete all {total}</button>}
            {rows.length < total && (
              <>
                <button onClick={() => setLimit((l) => l + PAGE)} disabled={page.isFetching} className={btnPrimary}>Load {Math.min(PAGE, total - rows.length)} more</button>
                <button onClick={() => setLimit(total)} disabled={page.isFetching} className={btnGhost}>Load all</button>
              </>
            )}
          </div>
        }
      />
    </AppShell>
  );
}

// ---------------------------------------------------------------- edit many records

type DateMode = "set" | "shift";

/** Changes the ticked fields on every target record. Clock fields only touch clock records; hours only touch daily-hours records. */
function BulkRecordEdit({ mode, employees, label, load, onClose, onDone }: {
  mode: EntryMode; employees: Employee[]; label: string;
  load: () => Promise<Pick<TimeRecord, "id" | "work_date" | "entry_mode">[]>; onClose: () => void; onDone: () => void;
}) {
  const [on, setOn] = useState<Record<string, boolean>>({});
  const [v, setV] = useState({ employee_id: "", date: "", shift: "1", clock_in: "09:00", clock_out: "17:00", lunch_minutes: "30", hours: "8", note: "", pay: "" });
  const [dateMode, setDateMode] = useState<DateMode>("set");
  const [busy, setBusy] = useState(false);
  // "Edit all" lives in the table footer, often far below this panel: bring the panel into view when it opens or changes target.
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    panel.current?.focus({ preventScroll: true });
  }, [label]);
  const set = (k: keyof typeof v, val: string) => { setV({ ...v, [k]: val }); setOn((o) => ({ ...o, [k === "shift" ? "date" : k]: true })); };
  const row = (k: string, text: string, control: React.ReactNode) => (
    <label className={`flex items-center gap-3 rounded-xl p-2 ring-1 ${on[k] ? "bg-accent/50 ring-primary/25" : "ring-border"}`}>
      <input type="checkbox" checked={!!on[k]} onChange={(e) => setOn({ ...on, [k]: e.target.checked })} aria-label={`Change ${text}`} />
      <span className="w-28 shrink-0 text-sm">{text}</span>
      <div className="min-w-0 flex-1">{control}</div>
    </label>
  );

  const shiftDays = Math.trunc(Number(v.shift));
  const target = employees.find((e) => e.id === v.employee_id);
  const changes: string[] = [];
  if (on["employee_id"]) changes.push(`employee → ${target ? fullName(target) : "?"}`);
  if (on["date"]) changes.push(dateMode === "set" ? `date → ${v.date ? `${weekday(v.date)} ${v.date}` : "?"}` : `dates ${shiftDays >= 0 ? "+" : ""}${shiftDays || 0} day${Math.abs(shiftDays) === 1 ? "" : "s"}`);
  if (mode === "clock") {
    if (on["clock_in"]) changes.push(`clock in → ${v.clock_in}`);
    if (on["clock_out"]) changes.push(`clock out → ${v.clock_out}`);
    if (on["lunch_minutes"]) changes.push(`lunch → ${v.lunch_minutes} min`);
  } else if (on["hours"]) changes.push(`hours → ${v.hours}`);
  if (on["note"]) changes.push(v.note.trim() ? `note → “${v.note.trim()}”` : "clear note");
  const payNum = Number(v.pay.replace(/[$,\s]/g, ""));
  if (on["pay"]) changes.push(v.pay.trim() ? `day pay → ${Number.isFinite(payNum) ? `$${payNum.toFixed(2)}` : "?"} (manual)` : "calculate day pay from hours");

  const apply = async () => {
    if (on["employee_id"] && !v.employee_id) { toast.error("Pick the employee to move the records to"); return; }
    if (on["date"] && dateMode === "set" && !v.date) { toast.error("Pick a date"); return; }
    if (on["date"] && dateMode === "shift" && (!Number.isFinite(shiftDays) || shiftDays === 0 || Math.abs(shiftDays) > 366)) { toast.error("Move dates by 1 to 366 days (a minus sign moves them earlier)"); return; }
    const lunch = Number(v.lunch_minutes), hours = Number(v.hours);
    if (mode === "clock" && on["lunch_minutes"] && (!Number.isFinite(lunch) || lunch < 0 || lunch > 600)) { toast.error("Lunch minutes must be 0–600"); return; }
    if (mode === "hours" && on["hours"] && (!Number.isFinite(hours) || hours < 0 || hours > 24)) { toast.error("Hours must be 0–24"); return; }
    if (on["pay"] && v.pay.trim() && (!Number.isFinite(payNum) || payNum < 0 || payNum > 100000)) { toast.error("Manual pay must be an amount from $0 to $100,000"); return; }
    setBusy(true);
    try {
      const targets = await load();
      const rows = targets.map((r) => {
        const patch: Record<string, unknown> = {};
        if (on["employee_id"]) patch["employee_id"] = v.employee_id;
        if (on["date"]) patch["work_date"] = dateMode === "set" ? v.date : addDays(r.work_date, shiftDays);
        if (r.entry_mode === "clock") {
          if (on["clock_in"]) patch["clock_in"] = v.clock_in;
          if (on["clock_out"]) patch["clock_out"] = v.clock_out;
          if (on["lunch_minutes"]) patch["lunch_minutes"] = lunch;
        } else if (on["hours"]) patch["hours"] = hours;
        if (on["note"]) patch["note"] = v.note.trim().slice(0, 300) || null;
        if (on["pay"]) patch["pay_override"] = v.pay.trim() ? Math.round(payNum * 100) / 100 : null;
        return { id: r.id, patch };
      });
      if (!confirm(`Change ${rows.length} record${rows.length === 1 ? "" : "s"}: ${changes.join(", ")}?\n\nA backup is saved first, so you can restore it from Sync & backup.`)) return;
      await backupBefore("record-edit");
      const { error, updated } = await db().updateMany("time_records", rows as never);
      if (error) { toast.error(error.message); if (updated) onDone(); return; }
      toast.success(`Updated ${updated} record${updated === 1 ? "" : "s"}. A backup was saved in Sync & backup.`);
      onDone();
    } catch (e) {
      toast.error(`Nothing was changed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={panel} tabIndex={-1} className="glass-panel scroll-mt-4 space-y-4 p-5 outline-none ring-2 ring-primary/30">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-display font-extrabold tracking-tight">Edit {label}</div>
          <p className="text-xs text-muted-foreground">Tick what to change; everything else stays as it is on each record. Hours for clock entries are recalculated.</p>
        </div>
        <button onClick={onClose} className={btnGhost} aria-label="Close"><X className="h-4 w-4" /></button>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {row("employee_id", "Employee", <EmployeePicker employees={employees} value={v.employee_id} onChange={(id) => set("employee_id", id)} placeholder="Move to employee…" />)}
        {row("date", "Date", (
          <div className="flex gap-2">
            <select className={`${inputCls} w-auto`} value={dateMode} onChange={(e) => { setDateMode(e.target.value as DateMode); setOn((o) => ({ ...o, date: true })); }} aria-label="How to change the date">
              <option value="set">Set to</option>
              <option value="shift">Move by days</option>
            </select>
            {dateMode === "set"
              ? <input type="date" className={inputCls} value={v.date} onChange={(e) => set("date", e.target.value)} aria-label="New date" />
              : <input type="number" step={1} className={inputCls} value={v.shift} onChange={(e) => set("shift", e.target.value)} placeholder="7 or -7" aria-label="Days to move" />}
          </div>
        ))}
        {mode === "clock" ? (
          <>
            {row("clock_in", "Clock in", <input type="time" className={inputCls} value={v.clock_in} onChange={(e) => set("clock_in", e.target.value)} aria-label="New clock in" />)}
            {row("clock_out", "Clock out", <input type="time" className={inputCls} value={v.clock_out} onChange={(e) => set("clock_out", e.target.value)} aria-label="New clock out" />)}
            {row("lunch_minutes", "Lunch (min)", <input type="number" min={0} max={600} className={inputCls} value={v.lunch_minutes} onChange={(e) => set("lunch_minutes", e.target.value)} aria-label="New lunch minutes" />)}
          </>
        ) : row("hours", "Hours", <input type="number" step="0.25" min={0} max={24} className={inputCls} value={v.hours} onChange={(e) => set("hours", e.target.value)} aria-label="New hours" />)}
        {row("note", "Note", <input className={inputCls} value={v.note} placeholder="Leave empty to clear" onChange={(e) => set("note", e.target.value)} aria-label="New note" />)}
        {row("pay", "Manual day pay", <input className={inputCls} inputMode="decimal" value={v.pay} placeholder="Empty = calculate from hours" onChange={(e) => set("pay", e.target.value)} aria-label="New manual pay" />)}
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">{changes.length ? changes.join(" · ") : "Nothing ticked yet."}</div>
        <button onClick={apply} disabled={!changes.length || busy} className={btnPrimary}>{busy ? "Saving…" : "Apply"}</button>
      </div>
    </div>
  );
}
