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
import { askChoice } from "@/lib/choice-prompt";
import { describeRecord, sameDayClashes, type Clash } from "@/lib/record-clash";
import { addDays, computeHours, datesBetween, fullName, isoDate, useEmployees, usePayrollSettings, useRecordPay, useShifts, weekday, type Employee, type RecordWithEmp, type TimeRecord } from "@/lib/payroll";
import { shiftFor } from "@/lib/pay";
import { describeTimes, usualTimes, usualTimesFor, type UsualTimes } from "@/lib/shift-times";
import { CalendarPlus, Check, Lock, LockOpen, Pencil, Plus, Trash2, X } from "lucide-react";
import { usePref } from "@/lib/prefs";
import { PayLock } from "@/components/PayLock";
import { setRecordsLocked } from "@/lib/pay-freeze";
import { SortControl } from "@/components/SortControl";
import { CopyWeek } from "@/components/CopyWeek";
import { useCopyToNextWeek } from "@/components/RecordMenu";
import { sortRecords, validSort, type Sort, type SortKey } from "@/lib/record-sort";
import { DateInput } from "@/components/DateInput";

/** One shift's times for "Add each shift's usual hours", as typed (break in minutes). */
type GroupTimes = { clock_in: string; clock_out: string; lunch_minutes: string; hours: string };
type ShiftGroup = { key: string; name: string; times: UsualTimes | null; people: string[] };
const fromUsual = (t: UsualTimes): GroupTimes => ({
  clock_in: t.clock_in, clock_out: t.clock_out, lunch_minutes: String(t.lunch_minutes), hours: String(computeHours(t.clock_in, t.clock_out, t.lunch_minutes)),
});

/** Bulk-edit row keys to the label alias keys used everywhere else (src/lib/labels.ts). */
const RECORD_LABEL_KEYS: Record<string, string> = { employee_id: "employee", shift_id: "shift", pay: "manual_pay" };

/** Links can open the list on some days, for one employee (the Payroll page's "things to check" do). */
type RecordsSearch = { from?: string; to?: string; emp?: string; mode?: EntryMode };
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

export const Route = createFileRoute("/_authenticated/records")({
  head: () => ({ meta: [{ title: "Time records — Meridian Payroll" }] }),
  validateSearch: (s: Record<string, unknown>): RecordsSearch => ({
    ...(isDay(s["from"]) ? { from: s["from"] } : {}),
    ...(isDay(s["to"]) ? { to: s["to"] } : {}),
    ...(typeof s["emp"] === "string" && s["emp"] ? { emp: s["emp"] } : {}),
    ...(s["mode"] === "hours" || s["mode"] === "clock" ? { mode: s["mode"] } : {}),
  }),
  // The page reads the address only when it starts (from, to, emp and mode become its own filters), so arriving
  // with a different address while already here (Ctrl+K's "Time records for …") starts it again. It never writes the
  // address itself, so this only happens on purpose.
  remountDeps: ({ search }) => search,
  component: RecordsPage,
});

/** Records shown at first, and added by each "Load more". */
const PAGE = 50;
const SORT_KEYS = ["date", "employee", "hours", "pay"] as const satisfies readonly SortKey[];
const NEWEST: Sort<(typeof SORT_KEYS)[number]> = { by: "date", desc: true };

function RecordsPage() {
  const qc = useQueryClient();
  const dataMode = useDataMode();
  const { data: employees = [] } = useEmployees();
  const search = Route.useSearch();
  const [from, setFrom] = useState(search.from ?? "");
  const [to, setTo] = useState(search.to ?? "");
  // Just this employee, when opened from a link; cleared with the chip by the filters.
  const [onlyEmp, setOnlyEmp] = useState(search.emp ?? null);

  const [mode, setMode] = useState<"clock" | "hours">("clock");
  const { data: shifts = [] } = useShifts();
  const { data: settings } = usePayrollSettings();
  const [f, setF] = useState({ work_date: isoDate(new Date()), until: "", skip_weekends: false, clock_in: "09:00", clock_out: "17:00", lunch_minutes: "30", hours: "8", pay: "", shift_id: "" });
  const [breakUnit] = useBreakUnit();
  // An optional end date adds the same entry for every day in the range.
  const rangeBad = !!f.until && f.until < f.work_date;
  const days = useMemo(() => (f.work_date && !rangeBad ? datesBetween(f.work_date, f.until, f.skip_weekends) : []), [f.work_date, f.until, f.skip_weekends, rangeBad]);
  const [picked, setPicked] = useState<string[]>([]);
  const [pickQ, setPickQ] = useState<EmployeeFilter>(NO_FILTER);
  const [listQ, setListQ] = useState<EmployeeFilter>(NO_FILTER);
  const [listShifts, setListShifts] = useState<Facet>(ANY);
  const [savedSort, setSort] = usePref<Sort>("meridian-records-sort", NEWEST);
  const sort = validSort(savedSort, SORT_KEYS, NEWEST);
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
    const groups = new Map<string, { key: string; name: string; times: UsualTimes | null; people: string[] }>();
    for (const id of picked) {
      const emp = employees.find((e) => e.id === id);
      const u = usualTimesFor(emp?.shift_id, f.shift_id, shifts);
      const key = u?.shift.id ?? "";
      const g = groups.get(key) ?? { key, name: u?.shift.name ?? "No shift", times: u?.times ?? null, people: [] };
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
  // Each shift's times, set in the list below the form: its usual hours (or the form's times when it has none) until changed there.
  const [groupEdits, setGroupEdits] = useState<Record<string, GroupTimes>>({});
  const formTimes: GroupTimes = { clock_in: f.clock_in, clock_out: f.clock_out, lunch_minutes: f.lunch_minutes, hours: f.hours };
  const timesOf = (g: ShiftGroup): GroupTimes => groupEdits[g.key] ?? (g.times ? fromUsual(g.times) : formTimes);
  const editGroup = (g: ShiftGroup, patch: Partial<GroupTimes>) => setGroupEdits((x) => {
    const next = { ...timesOf(g), ...patch };
    // Keep the hours in step with the times, so switching to daily hours shows what the times come to.
    if (!("hours" in patch)) next.hours = String(computeHours(next.clock_in, next.clock_out, Number(next.lunch_minutes) || 0));
    return { ...x, [g.key]: next };
  });
  const resetGroup = (g: ShiftGroup) => setGroupEdits(({ [g.key]: _, ...rest }) => rest);
  // Every picked person's hours come from their shift's times below, so the form's times aren't used at all.
  const covered = useOwn;

  const preview = mode === "clock" ? computeHours(f.clock_in, f.clock_out, Number(f.lunch_minutes) || 0) : Number(f.hours) || 0;

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (picked.length === 0) { toast.error("Pick at least one employee"); return; }
    if (rangeBad) { toast.error("The end date is before the start date"); return; }
    if (days.length === 0) { toast.error(f.skip_weekends ? "That range only has weekend days" : "Pick a date"); return; }
    if (days.length > 366) { toast.error("Pick a range of at most a year"); return; }
    const lockedThrough = settings?.locked_through;
    if (lockedThrough && days[0]! <= lockedThrough) { toast.error(`Days up to ${weekday(lockedThrough)} ${lockedThrough} are locked as paid. Pick a later date, or change the lock above.`); return; }
    const lunch = Number(f.lunch_minutes);
    const hours = Number(f.hours);
    // With each shift's hours, the times come from the list below the form instead of the form's cells.
    const perShift = new Map(useOwn ? shiftGroups.map((g) => [g.key, timesOf(g)] as const) : []);
    const checks = useOwn ? shiftGroups.map((g) => ({ ...timesOf(g), what: `${g.name}: ` })) : [{ ...formTimes, what: "" }];
    for (const c of checks) {
      if (mode === "clock" && (!c.clock_in || !c.clock_out)) { toast.error(`${c.what}enter a clock in and clock out time`); return; }
      if (mode === "clock" && !validBreak(Number(c.lunch_minutes))) { toast.error(c.what + breakRangeText(breakUnit)); return; }
      const h = Number(c.hours);
      if (mode === "hours" && (c.hours.trim() === "" || !Number.isFinite(h) || h < 0 || h > 24)) { toast.error(`${c.what}hours must be 0–24`); return; }
    }
    const pay = f.pay.trim() === "" ? null : Number(f.pay.replace(/[$,\s]/g, ""));
    if (pay !== null && (!Number.isFinite(pay) || pay < 0 || pay > 100000)) { toast.error("Day pay must be an amount from $0 to $100,000, or empty"); return; }
    const manual = pay === null ? {} : { pay_override: Math.round(pay * 100) / 100 };
    // Only store a shift when it differs from the person's usual one.
    const shiftOf = (id: string) => (f.shift_id && f.shift_id !== shiftFor(employees.find((e) => e.id === id)?.shift_id, shifts).id ? { shift_id: f.shift_id } : {});
    // With each shift's hours, everyone gets the times set for the shift their record is on.
    const own = (id: string) => perShift.get(usualTimesFor(employees.find((e) => e.id === id)?.shift_id, f.shift_id, shifts)?.shift.id ?? "");
    let rows: TablesInsert<"time_records">[] = days.flatMap((work_date) => picked.map((employee_id) => {
      const t = own(employee_id);
      return mode === "clock"
        ? { employee_id, work_date, entry_mode: "clock", clock_in: t?.clock_in ?? f.clock_in, clock_out: t?.clock_out ?? f.clock_out, lunch_minutes: t ? Number(t.lunch_minutes) : lunch, ...manual, ...shiftOf(employee_id) }
        : { employee_id, work_date, entry_mode: "hours", hours: t ? Number(t.hours) : hours, ...manual, ...shiftOf(employee_id) };
    }));
    // Someone who already has a record that day is usually a slip (it would pay the day twice), but can be a real
    // second shift, so ask rather than refuse.
    let clashes: Clash[];
    try {
      clashes = sameDayClashes(rows as { employee_id: string; work_date: string }[], await storeFor(dataMode).listRecordKeys(days[0]!, days.at(-1)!));
    } catch (err) { toast.error(`Couldn't check for records already on those days: ${(err as Error).message}`); return; }
    if (clashes.length) {
      const nameOf = (id: string) => { const e = employees.find((x) => x.id === id); return e ? fullName(e) : "Someone"; };
      const all = clashes.length === rows.length;
      const answer = await askChoice({
        title: clashes.length === 1 ? "Already has a record that day" : `${clashes.length} already have a record that day`,
        detail: `Adding another would pay ${clashes.length === 1 ? "that day" : "those days"} twice. That's right only if they really worked twice, e.g. a day and a night shift.`,
        items: clashes.map((c) => `${nameOf(c.employee_id)} · ${weekday(c.work_date)} ${c.work_date} · already ${c.existing.map(describeRecord).join(", ")}`),
        choices: [
          { id: "cancel", label: "Cancel" },
          { id: "all", label: "Add anyway", danger: true },
          ...(all ? [] : [{ id: "skip", label: `Skip ${clashes.length === 1 ? "that one" : "those"}, add the rest`, primary: true }]),
        ],
      });
      if (!answer || answer.id === "cancel") return;
      if (answer.id === "skip") {
        const clash = new Set(clashes.map((c) => `${c.employee_id}|${c.work_date}`));
        rows = rows.filter((r) => !clash.has(`${r.employee_id}|${r.work_date}`));
      }
    } else if (days.length > 1 && !confirm(`Add ${rows.length} records: ${picked.length} employee${picked.length === 1 ? "" : "s"} × ${days.length} days (${weekday(days[0]!)} ${days[0]} to ${weekday(days.at(-1)!)} ${days.at(-1)})?`)) return;
    const { error } = await db().insert("time_records", rows);
    if (error) { toast.error(error.message); return; }
    toast.success(rows.length === 1 ? "Record added" : `${rows.length} records added`);
    setPicked([]);
    setGroupEdits({});
    setF((x) => ({ ...x, pay: "" }));
    qc.invalidateQueries({ queryKey: ["records"] });
  };

  const del = async (id: string) => {
    const { error } = await db().remove("time_records", id);
    if (error) { toast.error(error.message); return; }
    qc.invalidateQueries({ queryKey: ["records"] });
  };

  // ---- the list: filtered in the database, loaded a page at a time
  const [listMode, setListMode] = useState<EntryMode>(search.mode ?? "clock");
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<null | "selected" | "all">(null);
  // The shifts the shift filter lets through (excluding some is keeping the rest); undefined when it isn't set.
  const shiftsShown = useMemo(() => (facetActive(listShifts) ? shifts.map((x) => x.id).filter((id) => facetAllows(listShifts, id)) : undefined), [listShifts, shifts]);
  const filter = useMemo<RecordFilter>(() => ({
    from: from || undefined, to: to || undefined, mode: listMode,
    // The database sorts by everything but pay, which only the app works out (below).
    sort: sort.by === "pay" ? undefined : { by: sort.by, desc: sort.desc },
    employeeIds: onlyEmp || isFiltering(listQ) ? employees.filter((e) => (!onlyEmp || e.id === onlyEmp) && matchesEmployee(e, listQ)).map((e) => e.id) : undefined,
    shifts: shiftsShown ? { ids: shiftsShown, employeeIds: employees.filter((e) => shiftsShown.includes(shiftFor(e.shift_id, shifts).id ?? "")).map((e) => e.id) } : undefined,
  }), [from, to, listMode, sort.by, sort.desc, listQ, onlyEmp, shiftsShown, employees, shifts]);
  const filterKey = JSON.stringify(filter);
  // A new filter starts again from the first page, with nothing selected.
  useEffect(() => { setLimit(PAGE); setSelected(new Set()); setBulk(null); }, [filterKey]);
  const byPay = sort.by === "pay";
  const page = useQuery({
    queryKey: ["records", "page", dataMode, filterKey, limit],
    queryFn: () => storeFor(dataMode).listRecordsPage(filter, 0, limit),
    placeholderData: keepPreviousData,
    enabled: !byPay,
  });
  // Sorting by pay: pay isn't stored, so load every matching record, work out each one's pay (over whole weeks, as the
  // table does), sort, and page through the sorted list here instead of in the database.
  const everything = useQuery({
    queryKey: ["records", "matching", dataMode, filterKey],
    queryFn: () => storeFor(dataMode).listRecordsMatching(filter),
    enabled: byPay,
    placeholderData: keepPreviousData,
  });
  const allPay = useRecordPay(byPay ? everything.data ?? [] : []);
  const byPayRows = useMemo(() => {
    if (!byPay || !everything.data) return [];
    const empById = new Map(employees.map((e) => [e.id, e]));
    const withEmp: RecordWithEmp[] = everything.data.map((r) => {
      const e = empById.get(r.employee_id);
      return { ...r, employees: e ? { first_name: e.first_name, last_name: e.last_name, employee_code: e.employee_code, hourly_rate: e.hourly_rate } : null };
    });
    return sortRecords(withEmp, sort, { pay: (r) => allPay?.get(r.id)?.pay });
  }, [byPay, everything.data, employees, allPay, sort]);
  const rows = byPay ? byPayRows.slice(0, limit) : page.data?.rows ?? [];
  const total = byPay ? byPayRows.length : page.data?.total ?? 0;
  const loading = byPay ? everything.isFetching || (byPayRows.length > 0 && !allPay) : page.isFetching;
  const pickedRows = rows.filter((r) => selected.has(r.id));
  const toggleRow = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAllRows = () => setSelected((s) => (rows.length && rows.every((r) => s.has(r.id)) ? new Set() : new Set(rows.map((r) => r.id))));
  const refresh = () => qc.invalidateQueries({ queryKey: ["records"] });
  const onlyEmployee = onlyEmp ? employees.find((e) => e.id === onlyEmp) : undefined;
  const onlyName = onlyEmployee ? fullName(onlyEmployee) : "one employee";
  const describeFilter = [
    listMode === "clock" ? "clock in/out" : "daily-hours",
    from || to ? `from ${from ? `${weekday(from)} ${from}` : "the start"} to ${to ? `${weekday(to)} ${to}` : "the latest"}` : "",
    onlyEmp ? `for ${onlyName}` : "",
    isFiltering(listQ) ? `for employees matching ${describeEmployeeFilter(listQ)}` : "",
    facetActive(listShifts) ? `on shift ${describeFacet(listShifts, (id) => shifts.find((x) => x.id === id)?.name ?? "deleted")}` : "",
  ].filter(Boolean).join(" ");

  // Selected records on locked days: unlock them one by one, or lock them again.
  const lockedThrough = settings?.locked_through ?? null;
  const onLockedDay = pickedRows.filter((r) => lockedThrough && r.work_date <= lockedThrough);
  const stillLocked = onLockedDay.filter((r) => !r.unlocked);
  const reopened = onLockedDay.filter((r) => r.unlocked);
  const copyToNextWeek = useCopyToNextWeek();
  const empById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const setUnlocked = async (rs: typeof pickedRows, unlocked: boolean) => {
    const { error } = await setRecordsLocked(db(), rs, !unlocked);
    if (error) { toast.error(error.message); return; }
    toast.success(unlocked
      ? `Unlocked ${rs.length} record${rs.length === 1 ? "" : "s"}: paid by the current rules until locked again. Ctrl+Z puts their locked pay back.`
      : `Locked ${rs.length} record${rs.length === 1 ? "" : "s"} again, with pay saved as it is now`);
    refresh();
  };

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
          <div className="flex items-center gap-2">
          <CopyWeek />
          <div className="flex rounded-xl bg-secondary p-1 text-xs font-medium ring-1 ring-border">
            {(["clock", "hours"] as const).map((m) => (
              <button type="button" key={m} onClick={() => setMode(m)} className={`rounded-lg px-3 py-1.5 ${mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                {m === "clock" ? "Clock in / out" : "Daily hours"}
              </button>
            ))}
          </div>
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
          <label><span className="label-mono">{f.until ? "From" : "Date"}{f.work_date && ` · ${weekday(f.work_date)}`}</span><DateInput className={`${inputCls} mt-1 w-auto`} value={f.work_date} onChange={(v) => setF({ ...f, work_date: v })} required /></label>
          <label title="Leave empty for one day. Set it to add the same entry for every day up to and including this date.">
            <span className="label-mono">To (optional){f.until && ` · ${weekday(f.until)}`}</span>
            <div className="mt-1 flex items-center gap-1">
              <DateInput className={`${inputCls} w-auto ${rangeBad ? "ring-2 ring-destructive" : ""}`} value={f.until} min={f.work_date} onChange={(v) => setF({ ...f, until: v })} aria-label="Last date" />
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
              <ul className="space-y-2 pl-6">
                {shiftGroups.map((g) => {
                  const t = timesOf(g);
                  const edited = !!groupEdits[g.key];
                  const h = mode === "clock" ? computeHours(t.clock_in, t.clock_out, Number(t.lunch_minutes) || 0) : Number(t.hours) || 0;
                  const small = `${inputCls} !py-1.5 text-sm ${edited ? "ring-2 ring-primary/40" : ""}`;
                  return (
                    <li key={g.key} className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                      <div className="min-w-[14rem] flex-1 text-xs text-muted-foreground">
                        <span className="text-sm font-medium text-foreground">{g.name}</span>
                        {" · "}{g.people.length} {g.people.length === 1 ? "person" : "people"} ({g.people.slice(0, 3).join(", ")}{g.people.length > 3 ? ` +${g.people.length - 3} more` : ""})
                        <div>{g.times ? (edited ? `Changed from usual ${describeTimes(g.times)}, ${formatBreak(g.times.lunch_minutes, breakUnit)} ${breakUnit === "h" ? "h" : "min"} break` : "Usual hours") : "No usual hours"}</div>
                      </div>
                      {mode === "clock" ? (
                        <>
                          <input type="time" aria-label={`${g.name} clock in`} className={`${small} !w-32`} value={t.clock_in} onChange={(e) => editGroup(g, { clock_in: e.target.value })} />
                          <span className="text-muted-foreground">–</span>
                          <input type="time" aria-label={`${g.name} clock out`} className={`${small} !w-32`} value={t.clock_out} onChange={(e) => editGroup(g, { clock_out: e.target.value })} />
                          <BreakInput label={`${g.name} break`} minutes={t.lunch_minutes} onChange={(m) => editGroup(g, { lunch_minutes: m })} className={`${small} !w-20`} />
                          <span className="text-xs text-muted-foreground">{breakUnit === "h" ? "h" : "min"} break</span>
                        </>
                      ) : (
                        <>
                          <input type="number" step="0.25" min={0} max={24} aria-label={`${g.name} hours`} className={`${small} !w-24`} value={t.hours} onChange={(e) => editGroup(g, { hours: e.target.value })} />
                          <span className="text-xs text-muted-foreground">hours</span>
                        </>
                      )}
                      <span className="w-16 text-right font-mono text-xs">{mode === "clock" ? `= ${h.toFixed(2)} h` : ""}</span>
                      <button type="button" onClick={() => resetGroup(g)} disabled={!edited} className="w-24 text-left text-xs text-muted-foreground hover:text-foreground disabled:invisible">
                        {g.times ? "Back to usual" : "Reset"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="pl-6 text-xs text-muted-foreground">Everyone gets the {mode === "clock" ? "times" : "hours"} above.</p>
            )}
          </div>
        )}
      </form>

      <div className="flex flex-wrap items-center gap-3">
        <span className="label-mono">Filter</span>
        <DateInput className={`${inputCls} max-w-[11rem]`} value={from} onChange={(v) => setFrom(v)} aria-label="From date" />
        <span className="text-muted-foreground">→</span>
        <DateInput className={`${inputCls} max-w-[11rem]`} value={to} onChange={(v) => setTo(v)} aria-label="To date" />
        {shifts.length > 1 && (
          <FacetFilter options={shifts.map((sh) => ({ value: sh.id, label: sh.name }))} value={listShifts} onChange={setListShifts} allLabel="All shifts" label="shift" />
        )}
        {onlyEmp && (
          <button type="button" onClick={() => setOnlyEmp(null)} title="Show everyone again" className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
            Only {onlyName}<X className="h-3.5 w-3.5" />
          </button>
        )}
        <SearchInput value={listQ} onChange={setListQ} employees={employees} placeholder="Filter by employee name, ID, position, department…" className="min-w-[16rem] flex-1" />
      </div>

      <PayLock periodEnd={to || undefined} />

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
          <div className="flex flex-wrap gap-2">
            {stillLocked.length > 0 && <button onClick={() => setUnlocked(stillLocked, true)} className={btnGhost} title="Lets just these records change while the rest of their days stay locked"><LockOpen className="mr-1 inline h-4 w-4" />Unlock {stillLocked.length === pickedRows.length ? "selected" : `${stillLocked.length} locked`}</button>}
            {reopened.length > 0 && <button onClick={() => setUnlocked(reopened, false)} className={btnGhost}><Lock className="mr-1 inline h-4 w-4" />Lock {reopened.length === pickedRows.length ? "selected" : reopened.length} again</button>}
            <button onClick={() => copyToNextWeek(pickedRows, empById, lockedThrough)} className={btnGhost} title="Each selected record again 7 days later, by Copy a week's rules"><CalendarPlus className="mr-1 inline h-4 w-4" />Copy to next week</button>
            <button onClick={() => setBulk("selected")} className={btnPrimary}><Pencil className="mr-1 inline h-4 w-4" />Edit selected</button>
            <button onClick={() => deleteMany("selected")} className={`${btnGhost} hover:!text-destructive`}><Trash2 className="mr-1 inline h-4 w-4" />Delete selected</button>
            <button onClick={() => setSelected(new Set())} className={btnGhost} aria-label="Clear selection"><X className="h-4 w-4" /></button>
          </div>
        </div>
      )}

      <RecordsLedger
        title={<span className="flex items-center gap-3">{total} records
          <SortControl value={sort} onChange={setSort} keys={SORT_KEYS} />
          {loading && <span className="text-xs font-normal text-muted-foreground">{byPay ? "working out pay…" : "loading…"}</span>}</span>}
        rows={rows} total={total} mode={listMode} onModeChange={setListMode} employees={employees}
        selected={selected} onToggle={toggleRow} onToggleAll={toggleAllRows} onChanged={refresh} onDelete={del}
        footer={
          <div className="flex flex-wrap items-center gap-2">
            {total > 0 && <button onClick={() => setBulk("all")} className={btnGhost}>Edit all {total}</button>}
            {total > 0 && <button onClick={() => deleteMany("all")} className={`${btnGhost} hover:!text-destructive`}>Delete all {total}</button>}
            {rows.length < total && (
              <>
                <button onClick={() => setLimit((l) => l + PAGE)} disabled={loading} className={btnPrimary}>Load {Math.min(PAGE, total - rows.length)} more</button>
                <button onClick={() => setLimit(total)} disabled={loading} className={btnGhost}>Load all</button>
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
              ? <DateInput className={inputCls} value={v.date} onChange={(d) => set("date", d)} aria-label="New date" />
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
