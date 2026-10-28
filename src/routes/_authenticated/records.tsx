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
import { RecordShiftSelect } from "@/components/RecordPay";
import { BreakHeader, BreakInput, BreakUnitToggle } from "@/components/BreakField";
import { EditableLabel } from "@/components/EditableLabel";
import { breakRangeText, formatBreak, useBreakUnit, validBreak } from "@/lib/breaks";
import { EmployeePicker, SearchInput } from "@/components/EmployeeSearch";
import { ANY, describeEmployeeFilter, describeFacet, facetActive, facetAllows, isFiltering, matchesEmployee, NO_FILTER, searchEmployees, type EmployeeFilter, type Facet } from "@/lib/employee-search";
import { FacetFilter } from "@/components/FacetFilter";
import { addDays, computeHours, datesBetween, fullName, isoDate, useEmployees, useShifts, weekday, type Employee, type TimeRecord } from "@/lib/payroll";
import { shiftFor } from "@/lib/pay";
import { describeTimes, usualTimes, usualTimesFor, type UsualTimes } from "@/lib/shift-times";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";

/** Bulk-edit row keys to the label alias keys used everywhere else (src/lib/labels.ts). */
const RECORD_LABEL_KEYS: Record<string, string> = { employee_id: "employee", shift_id: "shift", pay: "manual_pay" };

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
  const { data: shifts = [] } = useShifts();
  const [f, setF] = useState({ work_date: isoDate(new Date()), until: "", skip_weekends: false, clock_in: "09:00", clock_out: "17:00", lunch_minutes: "30", hours: "8", pay: "", shift_id: "" });
  const [breakUnit] = useBreakUnit();
  // An optional end date adds the same entry for every day in the range.
  const rangeBad = !!f.until && f.until < f.work_date;
  const days = useMemo(() => (f.work_date && !rangeBad ? datesBetween(f.work_date, f.until, f.skip_weekends) : []), [f.work_date, f.until, f.skip_weekends, rangeBad]);
  const [picked, setPicked] = useState<string[]>([]);
  const [pickQ, setPickQ] = useState<EmployeeFilter>(NO_FILTER);
  const [listQ, setListQ] = useState<EmployeeFilter>(NO_FILTER);
  const [listShifts, setListShifts] = useState<Facet>(ANY);
  // Resigned employees can't be given new hours, so they aren't offered here (their old records still list below).
  const working = useMemo(() => employees.filter((e) => e.active), [employees]);
  const resigned = employees.length - working.length;
  const shownEmployees = useMemo(() => searchEmployees(working, pickQ), [working, pickQ]);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  // Drop picks of anyone who resigned or was deleted meanwhile.
  useEffect(() => {
    setPicked((p) => { const ok = p.filter((id) => working.some((e) => e.id === id)); return ok.length === p.length ? p : ok; });
  }, [working]);
  // After "Select all", the few people left out are easier to see than everyone who's in.
  const left = working.filter((e) => !picked.includes(e.id));
  const showLeftOut = picked.length > 0 && left.length > 0 && left.length <= picked.length && left.length <= 20;

  // ---- picking by shift: each shift's working people among those the search shows, and its usual hours
  const byShift = useMemo(() => {
    const m = new Map<string, Employee[]>();
    for (const e of shownEmployees) { const id = shiftFor(e.shift_id, shifts).id; if (id) m.set(id, [...(m.get(id) ?? []), e]); }
    return m;
  }, [shownEmployees, shifts]);
  const toggleShift = (shiftId: string) => {
    const ids = (byShift.get(shiftId) ?? []).map((e) => e.id);
    if (ids.length && ids.every((id) => picked.includes(id))) setPicked((p) => p.filter((id) => !ids.includes(id)));
    else setPicked((p) => [...new Set([...p, ...ids])]);
  };
  // The shift each picked person's record would be on (the one chosen for the record, else their own), with its usual hours.
  const shiftGroups = useMemo(() => {
    const groups = new Map<string, { name: string; times: UsualTimes | null; people: string[] }>();
    for (const id of picked) {
      const emp = employees.find((e) => e.id === id);
      const u = usualTimesFor(emp?.shift_id, f.shift_id, shifts);
      const key = u?.shift.id ?? "";
      const g = groups.get(key) ?? { name: u?.shift.name ?? "No shift", times: u?.times ?? null, people: [] };
      g.people.push(emp ? fullName(emp) : "?");
      groups.set(key, g);
    }
    return [...groups.values()];
  }, [picked, employees, shifts, f.shift_id]);
  const distinctTimes = new Set(shiftGroups.map((g) => (g.times ? JSON.stringify(g.times) : "none")));
  // Everyone picked gets the same usual hours (or nobody's picked yet, but the record's shift has some): show them in the form.
  const uniform: UsualTimes | null = picked.length
    ? (distinctTimes.size === 1 ? shiftGroups[0]!.times : null)
    : usualTimes(shifts.find((x) => x.id === f.shift_id));
  const uniformKey = uniform ? JSON.stringify(uniform) : "";
  useEffect(() => {
    if (!uniform) return;
    setF((x) => ({ ...x, clock_in: uniform.clock_in, clock_out: uniform.clock_out, lunch_minutes: String(uniform.lunch_minutes), hours: String(computeHours(uniform.clock_in, uniform.clock_out, uniform.lunch_minutes)) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refill only when the selection's usual hours change, so edits stick
  }, [uniformKey]);
  // The picked people's shifts have different hours (or only some have usual hours): offer each shift's own.
  const mixed = distinctTimes.size > 1 && shiftGroups.some((g) => g.times);
  const [eachShift, setEachShift] = useState(true);
  useEffect(() => { if (mixed) setEachShift(true); }, [mixed]);
  const useOwn = mixed && eachShift;
  // Every picked person's hours come from their shift, so the form's times aren't used at all.
  const covered = useOwn && shiftGroups.every((g) => g.times);

  const preview = mode === "clock" ? computeHours(f.clock_in, f.clock_out, Number(f.lunch_minutes) || 0) : Number(f.hours) || 0;

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (picked.length === 0) { toast.error("Pick at least one employee"); return; }
    if (rangeBad) { toast.error("The end date is before the start date"); return; }
    if (days.length === 0) { toast.error(f.skip_weekends ? "That range only has weekend days" : "Pick a date"); return; }
    if (days.length > 366) { toast.error("Pick a range of at most a year"); return; }
    const lunch = Number(f.lunch_minutes);
    const hours = Number(f.hours);
    if (mode === "clock" && !validBreak(lunch)) { toast.error(breakRangeText(breakUnit)); return; }
    if (mode === "hours" && (!Number.isFinite(hours) || hours < 0 || hours > 24)) { toast.error("Hours must be 0–24"); return; }
    const pay = f.pay.trim() === "" ? null : Number(f.pay.replace(/[$,\s]/g, ""));
    if (pay !== null && (!Number.isFinite(pay) || pay < 0 || pay > 100000)) { toast.error("Day pay must be an amount from $0 to $100,000, or empty"); return; }
    const manual = pay === null ? {} : { pay_override: Math.round(pay * 100) / 100 };
    // Only store a shift when it differs from the person's usual one.
    const shiftOf = (id: string) => (f.shift_id && f.shift_id !== shiftFor(employees.find((e) => e.id === id)?.shift_id, shifts).id ? { shift_id: f.shift_id } : {});
    // With "each person's shift hours", people whose shift has usual hours get those; everyone else the times typed here.
    const own = (id: string) => (useOwn ? usualTimesFor(employees.find((e) => e.id === id)?.shift_id, f.shift_id, shifts)?.times ?? null : null);
    const rows: TablesInsert<"time_records">[] = days.flatMap((work_date) => picked.map((employee_id) => {
      const t = own(employee_id);
      return mode === "clock"
        ? { employee_id, work_date, entry_mode: "clock", clock_in: t?.clock_in ?? f.clock_in, clock_out: t?.clock_out ?? f.clock_out, lunch_minutes: t?.lunch_minutes ?? lunch, ...manual, ...shiftOf(employee_id) }
        : { employee_id, work_date, entry_mode: "hours", hours: t ? computeHours(t.clock_in, t.clock_out, t.lunch_minutes) : hours, ...manual, ...shiftOf(employee_id) };
    }));
    if (days.length > 1 && !confirm(`Add ${rows.length} records: ${picked.length} employee${picked.length === 1 ? "" : "s"} × ${days.length} days (${weekday(days[0]!)} ${days[0]} to ${weekday(days.at(-1)!)} ${days.at(-1)})?`)) return;
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
  // The shifts the shift filter lets through (excluding some is keeping the rest); undefined when it isn't set.
  const shiftsShown = useMemo(() => (facetActive(listShifts) ? shifts.map((x) => x.id).filter((id) => facetAllows(listShifts, id)) : undefined), [listShifts, shifts]);
  const filter = useMemo<RecordFilter>(() => ({
    from: from || undefined, to: to || undefined, mode: listMode,
    employeeIds: isFiltering(listQ) ? employees.filter((e) => matchesEmployee(e, listQ)).map((e) => e.id) : undefined,
    shifts: shiftsShown ? { ids: shiftsShown, employeeIds: employees.filter((e) => shiftsShown.includes(shiftFor(e.shift_id, shifts).id ?? "")).map((e) => e.id) } : undefined,
  }), [from, to, listMode, listQ, shiftsShown, employees, shifts]);
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
    facetActive(listShifts) ? `on shift ${describeFacet(listShifts, (id) => shifts.find((x) => x.id === id)?.name ?? "deleted")}` : "",
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
            <span className="label-mono">Employees · {picked.length} of {working.length} selected</span>
            <div className="flex gap-3 text-xs text-muted-foreground">
              <button type="button" className="hover:text-foreground"
                onClick={() => setPicked((p) => [...new Set([...p, ...shownEmployees.map((e) => e.id)])])}>
                {isFiltering(pickQ) ? `Select all ${shownEmployees.length} shown` : "Select all"}
              </button>
              <button type="button" className="hover:text-foreground" onClick={() => setPicked([])}>Clear</button>
            </div>
          </div>
          {shifts.length > 1 && working.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
              <span className="label-mono mr-1">By <EditableLabel k="shift" name="Shift" /></span>
              {shifts.map((sh) => {
                const people = byShift.get(sh.id) ?? [];
                const on = people.length > 0 && people.every((e) => picked.includes(e.id));
                const t = usualTimes(sh);
                return (
                  <button type="button" key={sh.id} onClick={() => toggleShift(sh.id)} disabled={!people.length} aria-pressed={on}
                    title={`${on ? "Leave out" : "Select"} everyone${isFiltering(pickQ) ? ` shown (${describeEmployeeFilter(pickQ)})` : ""} on ${sh.name}${!on && t ? ` and fill in its usual hours (${describeTimes(t)})` : ""}`}
                    className={`rounded-lg px-2.5 py-1 ring-1 ring-border disabled:opacity-40 ${on ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`}>
                    {on && <Check className="-ml-0.5 mr-1 inline h-3 w-3" />}
                    {sh.name} · {people.length}
                    {t && <span className="ml-1 font-mono opacity-70">{describeTimes(t)}</span>}
                  </button>
                );
              })}
            </div>
          )}
          <SearchInput value={pickQ} onChange={setPickQ} employees={working} className="mb-2" />
          <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
            {working.length === 0 && <span className="text-sm text-muted-foreground">{resigned ? "Everyone has resigned." : "No employees yet."}</span>}
            {working.length > 0 && shownEmployees.length === 0 && <span className="text-sm text-muted-foreground">No employee matches {describeEmployeeFilter(pickQ)}.</span>}
            {shownEmployees.map((e) => {
              const on = picked.includes(e.id);
              return (
                <button type="button" key={e.id} onClick={() => toggle(e.id)} aria-pressed={on} title={on ? "Click to leave out" : "Click to include"}
                  className={`rounded-lg px-3 py-1.5 text-sm ring-1 ring-border ${on ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`}>
                  {on && <Check className="-ml-0.5 mr-1 inline h-3.5 w-3.5" />}
                  {fullName(e)} <span className="font-mono text-[11px] opacity-70">{e.employee_code}</span>
                </button>
              );
            })}
          </div>
          {showLeftOut && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>Everyone selected except</span>
              {left.map((e) => (
                <button type="button" key={e.id} onClick={() => toggle(e.id)} title="Add back"
                  className="rounded-md bg-secondary px-2 py-0.5 ring-1 ring-border hover:text-foreground">
                  {fullName(e)} <Plus className="inline h-3 w-3" />
                </button>
              ))}
            </div>
          )}
          <div className="mt-1 text-xs text-muted-foreground">
            Click a name to include or leave them out. To add for everyone but a few people, press Select all, then click the ones to leave out.
            {resigned > 0 && ` ${resigned} resigned employee${resigned === 1 ? " is" : "s are"} hidden.`}
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label><span className="label-mono">{f.until ? "From" : "Date"}{f.work_date && ` · ${weekday(f.work_date)}`}</span><input type="date" className={`${inputCls} mt-1 w-auto`} value={f.work_date} onChange={(e) => setF({ ...f, work_date: e.target.value })} required /></label>
          <label title="Leave empty for one day. Set it to add the same entry for every day up to and including this date.">
            <span className="label-mono">To (optional){f.until && ` · ${weekday(f.until)}`}</span>
            <div className="mt-1 flex items-center gap-1">
              <input type="date" className={`${inputCls} w-auto ${rangeBad ? "ring-2 ring-destructive" : ""}`} value={f.until} min={f.work_date} onChange={(e) => setF({ ...f, until: e.target.value })} aria-label="Last date" />
              {f.until && <button type="button" onClick={() => setF({ ...f, until: "" })} className="text-muted-foreground hover:text-foreground" aria-label="Just one day"><X className="h-4 w-4" /></button>}
            </div>
          </label>
          {f.until && (
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input type="checkbox" checked={f.skip_weekends} onChange={(e) => setF({ ...f, skip_weekends: e.target.checked })} /> Skip Saturdays and Sundays
            </label>
          )}
          {f.until && (
            <div className={`pb-2 text-xs ${rangeBad ? "text-destructive" : "text-muted-foreground"}`}>
              {rangeBad ? "The end date is before the start date." : `${days.length} day${days.length === 1 ? "" : "s"} × ${picked.length} employee${picked.length === 1 ? "" : "s"} = ${days.length * picked.length} records`}
            </div>
          )}
        </div>
        <div className="grid items-end gap-3 md:grid-cols-6">
          {mode === "clock" ? (
            <>
              <label title={covered ? "Each shift's usual hours are used (see below)" : undefined}><span className="label-mono"><EditableLabel k="clock_in" name="Clock in" /></span><input type="time" className={`${inputCls} mt-1 disabled:opacity-40`} disabled={covered} value={covered ? "" : f.clock_in} onChange={(e) => setF({ ...f, clock_in: e.target.value })} required={!covered} /></label>
              <label title={covered ? "Each shift's usual hours are used (see below)" : undefined}><span className="label-mono"><EditableLabel k="clock_out" name="Clock out" /></span><input type="time" className={`${inputCls} mt-1 disabled:opacity-40`} disabled={covered} value={covered ? "" : f.clock_out} onChange={(e) => setF({ ...f, clock_out: e.target.value })} required={!covered} /></label>
              <label title={covered ? "Each shift's usual hours are used (see below)" : undefined}>
                <span className="flex items-center justify-between gap-1"><span className="label-mono"><BreakHeader unit={breakUnit} /></span><BreakUnitToggle /></span>
                {covered
                  ? <input className={`${inputCls} mt-1 disabled:opacity-40`} disabled value="" aria-label="Break" />
                  : <BreakInput minutes={f.lunch_minutes} onChange={(m) => setF({ ...f, lunch_minutes: m })} className={`${inputCls} mt-1`} />}
              </label>
            </>
          ) : (
            <label className="md:col-span-3" title={covered ? "Each shift's usual hours are used (see below)" : undefined}><span className="label-mono"><EditableLabel k="hours" name="Hours worked" /></span><input type="number" step="0.25" min={0} max={24} className={`${inputCls} mt-1 disabled:opacity-40`} disabled={covered} value={covered ? "" : f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} /></label>
          )}
          <label title="For covering a different shift than usual, e.g. a night worker on a day shift. Overtime pays the same either way.">
            <span className="label-mono"><EditableLabel k="shift" name="Shift" /></span>
            <RecordShiftSelect value={f.shift_id} onChange={(id) => setF({ ...f, shift_id: id })} shifts={shifts} ownLabel="Each person's usual" className={`${inputCls} mt-1`} />
          </label>
          <label title="Leave empty to pay from hours. Enter an amount to pay exactly that for the day.">
            <span className="label-mono"><EditableLabel k="manual_pay" name="Day pay" /> (optional)</span>
            <input className={`${inputCls} mt-1`} inputMode="decimal" placeholder="auto" value={f.pay} onChange={(e) => setF({ ...f, pay: e.target.value })} />
          </label>
          <div>
            <div className="mb-1 text-right font-mono text-[11px] text-muted-foreground">{useOwn ? "varies" : `${preview.toFixed(2)} h`}</div>
            <button className={`${btnPrimary} w-full`}>Add</button>
          </div>
        </div>
        {mixed && (
          <div className="space-y-1.5 rounded-xl bg-secondary/50 p-3 text-sm ring-1 ring-border">
            <label className="flex items-center gap-2 font-medium">
              <input type="checkbox" checked={eachShift} onChange={(e) => setEachShift(e.target.checked)} />
              Add each shift's usual hours
            </label>
            {eachShift ? (
              <ul className="space-y-1 pl-6 text-xs text-muted-foreground">
                {shiftGroups.map((g) => (
                  <li key={g.name}>
                    <span className="font-medium text-foreground">{g.name}</span>
                    {" · "}{g.people.length} {g.people.length === 1 ? "person" : "people"} ({g.people.slice(0, 3).join(", ")}{g.people.length > 3 ? ` +${g.people.length - 3} more` : ""}):{" "}
                    {g.times
                      ? <span className="font-mono text-foreground">{describeTimes(g.times)}, {formatBreak(g.times.lunch_minutes, breakUnit)} {breakUnit === "h" ? "h" : "min"} break = {computeHours(g.times.clock_in, g.times.clock_out, g.times.lunch_minutes).toFixed(2)} h</span>
                      : <>no usual hours, gets the {mode === "clock" ? "times" : "hours"} above</>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="pl-6 text-xs text-muted-foreground">Everyone gets the {mode === "clock" ? "times" : "hours"} above.</p>
            )}
          </div>
        )}
      </form>

      <div className="flex flex-wrap items-center gap-3">
        <span className="label-mono">Filter</span>
        <input type="date" className={`${inputCls} max-w-[11rem]`} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
        <span className="text-muted-foreground">→</span>
        <input type="date" className={`${inputCls} max-w-[11rem]`} value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
        {shifts.length > 1 && (
          <FacetFilter options={shifts.map((sh) => ({ value: sh.id, label: sh.name }))} value={listShifts} onChange={setListShifts} allLabel="All shifts" label="shift" />
        )}
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
  const { data: shifts = [] } = useShifts();
  const [breakUnit] = useBreakUnit();
  const [v, setV] = useState({ employee_id: "", date: "", shift: "1", clock_in: "09:00", clock_out: "17:00", lunch_minutes: "30", hours: "8", note: "", pay: "", shift_id: "" });
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
      <span className="w-28 shrink-0 text-sm">{k === "lunch_minutes" ? <BreakHeader unit={breakUnit} /> : <EditableLabel k={RECORD_LABEL_KEYS[k] ?? k} name={text} />}</span>
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
    if (on["lunch_minutes"]) changes.push(`break → ${formatBreak(v.lunch_minutes, breakUnit)} ${breakUnit === "h" ? "h" : "min"}`);
  } else if (on["hours"]) changes.push(`hours → ${v.hours}`);
  if (on["shift_id"]) changes.push(v.shift_id ? `shift → ${shifts.find((x) => x.id === v.shift_id)?.name ?? "?"}` : "shift → each person's usual");
  if (on["note"]) changes.push(v.note.trim() ? `note → “${v.note.trim()}”` : "clear note");
  const payNum = Number(v.pay.replace(/[$,\s]/g, ""));
  if (on["pay"]) changes.push(v.pay.trim() ? `day pay → ${Number.isFinite(payNum) ? `$${payNum.toFixed(2)}` : "?"} (manual)` : "calculate day pay from hours");

  const apply = async () => {
    if (on["employee_id"] && !v.employee_id) { toast.error("Pick the employee to move the records to"); return; }
    if (on["date"] && dateMode === "set" && !v.date) { toast.error("Pick a date"); return; }
    if (on["date"] && dateMode === "shift" && (!Number.isFinite(shiftDays) || shiftDays === 0 || Math.abs(shiftDays) > 366)) { toast.error("Move dates by 1 to 366 days (a minus sign moves them earlier)"); return; }
    const lunch = Number(v.lunch_minutes), hours = Number(v.hours);
    if (mode === "clock" && on["lunch_minutes"] && !validBreak(lunch)) { toast.error(breakRangeText(breakUnit)); return; }
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
        if (on["shift_id"]) patch["shift_id"] = v.shift_id || null;
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
        {row("employee_id", "Employee", <EmployeePicker employees={employees} hideResigned value={v.employee_id} onChange={(id) => set("employee_id", id)} placeholder="Move to employee…" />)}
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
            {row("lunch_minutes", "Break", <BreakInput minutes={v.lunch_minutes} onChange={(m) => set("lunch_minutes", m)} className={inputCls} label="New break" />)}
          </>
        ) : row("hours", "Hours", <input type="number" step="0.25" min={0} max={24} className={inputCls} value={v.hours} onChange={(e) => set("hours", e.target.value)} aria-label="New hours" />)}
        {shifts.length > 0 && row("shift_id", "Shift", <RecordShiftSelect value={v.shift_id} onChange={(id) => set("shift_id", id)} shifts={shifts} ownLabel="Each person's usual" className={inputCls} />)}
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
