import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarRange, Check, Plus, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { btnGhost, btnPrimary, inputCls } from "@/components/AppShell";
import { BreakInput } from "@/components/BreakField";
import { DateInput } from "@/components/DateInput";
import { EmployeePicker, SearchInput } from "@/components/EmployeeSearch";
import { askChoice, askConfirm } from "@/lib/choice-prompt";
import { DEFAULT_BREAK_MINUTES, useBreakUnit, validBreak, breakRangeText, type BreakUnit } from "@/lib/breaks";
import { db } from "@/lib/db/mode";
import { backupBefore } from "@/lib/db/safety";
import { describeEmployeeFilter, isFiltering, NO_FILTER, searchEmployees, type EmployeeFilter } from "@/lib/employee-search";
import { addDays, fullName, isoDate, useEmployees, useHolidays, usePatterns, usePayrollSettings, useShifts, weekday, type Employee, type WorkPattern } from "@/lib/payroll";
import { describeRecord, sameDayClashes } from "@/lib/record-clash";
import { shiftFor, weekStart } from "@/lib/pay";
import { describeTimes, usualTimes } from "@/lib/shift-times";
import { readAmount } from "@/lib/amount";
import { describeWeek, EMPTY_WEEK, planPatterns, readWeek, weekFromRecords, WEEKDAYS, type PatternDay, type PatternWeek } from "@/lib/patterns";
import { confirmLongRecords } from "@/lib/typo-prompt";

// Time records' "Patterns…": usual weeks saved once (src/lib/patterns.ts), used to fill any weeks with records, and
// the editor for them.

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const chip = (on: boolean) => `rounded-lg px-3 py-1.5 text-sm ring-1 ring-border ${on ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`;

export function PatternsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-find="patterns" onClick={() => setOpen(true)} className={btnGhost} title="Fill weeks from saved weekly patterns (Mon–Fri 9–5 and who works it), or edit them">
        <CalendarRange className="mr-1 inline h-4 w-4" />Patterns…
      </button>
      {open && <PatternsDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function PatternsDialog({ onClose }: { onClose: () => void }) {
  const { data: patterns = [], isSuccess } = usePatterns();
  const [tab, setTab] = useState<"fill" | "edit">("fill");
  // With no patterns yet, there's nothing to fill: start in the editor.
  useEffect(() => { if (isSuccess && !patterns.length) setTab("edit"); }, [isSuccess, patterns.length]);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[92vh] max-w-3xl flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Weekly patterns</DialogTitle>
          <DialogDescription>A usual week saved once (days, times or hours, shift, and who works it), then used to fill any weeks with records.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-1 rounded-xl bg-secondary p-1 text-sm ring-1 ring-border">
          {(["fill", "edit"] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)} aria-pressed={tab === t}
              className={`flex-1 rounded-lg px-3 py-1.5 ${tab === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              {t === "fill" ? "Fill weeks" : "Edit patterns"}
            </button>
          ))}
        </div>
        {tab === "fill" ? <FillWeeks patterns={patterns} onClose={onClose} onEdit={() => setTab("edit")} /> : <EditPatterns patterns={patterns} />}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- fill weeks

function FillWeeks({ patterns, onClose, onEdit }: { patterns: WorkPattern[]; onClose: () => void; onEdit: () => void }) {
  const qc = useQueryClient();
  const today = isoDate(new Date());
  const [from, setFrom] = useState(() => weekStart(addDays(today, 7)));
  const [weeks, setWeeks] = useState(1);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [skipHolidays, setSkipHolidays] = useState(true);
  const [busy, setBusy] = useState(false);
  const { data: employees = [] } = useEmployees();
  const { data: settings } = usePayrollSettings();
  const { data: holidays = [] } = useHolidays();
  const chosen = picked ?? patterns.map((p) => p.id);
  const lastDay = addDays(from, 7 * weeks - 1);
  const target = useQuery({ queryKey: ["records", "fill-to", from, lastDay], queryFn: () => db().listRecordKeys(from, lastDay) });
  const holidayDates = holidays.filter((h) => h.holiday_date >= from && h.holiday_date <= lastDay);

  const plan = useMemo(() => (target.data ? planPatterns({
    patterns: patterns.filter((p) => chosen.includes(p.id)), from, weeks, employees, existing: target.data,
    lockedThrough: settings?.locked_through, holidays: skipHolidays ? holidayDates.map((h) => h.holiday_date) : [],
  }) : null), [target.data, patterns, chosen, from, weeks, employees, settings?.locked_through, skipHolidays, holidayDates]);
  const clashes = useMemo(() => (plan && target.data ? sameDayClashes(plan.add as { employee_id: string; work_date: string }[], target.data) : []), [plan, target.data]);
  const nameOf = (id: string) => { const e = employees.find((x) => x.id === id); return e ? fullName(e) : "Someone"; };

  const fill = async () => {
    if (!plan?.add.length) return;
    let rows = plan.add;
    if (!(await confirmLongRecords(rows as (typeof rows[number] & { employee_id: string })[], nameOf))) return;
    if (clashes.length) {
      const all = clashes.length === new Set(rows.map((r) => `${r.employee_id}|${r.work_date}`)).size;
      const answer = await askChoice({
        title: clashes.length === 1 ? "Already has a different record that day" : `${clashes.length} days already have a different record`,
        detail: "Adding the pattern's shift as well would pay those days twice. That's right only if they really worked twice.",
        items: clashes.map((c) => `${nameOf(c.employee_id)} · ${weekday(c.work_date)} ${c.work_date} · already ${c.existing.map(describeRecord).join(", ")}`),
        choices: [
          { id: "cancel", label: "Cancel" },
          { id: "all", label: "Add anyway", danger: true },
          ...(all ? [] : [{ id: "skip", label: "Skip those days, add the rest", primary: true }]),
        ],
      });
      if (!answer || answer.id === "cancel") return;
      if (answer.id === "skip") {
        const clash = new Set(clashes.map((c) => `${c.employee_id}|${c.work_date}`));
        rows = rows.filter((r) => !clash.has(`${r.employee_id}|${r.work_date}`));
      }
    }
    setBusy(true);
    try {
      await backupBefore("fill-weeks");
      // One insert: all or nothing, and one Ctrl+Z takes it all back.
      const { error } = await db().insert("time_records", rows);
      if (error) throw error;
      toast.success(`Added ${plural(rows.length, "shift")} from patterns. Ctrl+Z takes them all back.`);
      await qc.invalidateQueries({ queryKey: ["records"] });
      onClose();
    } catch (e) {
      toast.error(`Nothing was added: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (!patterns.length) {
    return <div className="py-6 text-center text-sm text-muted-foreground">No patterns yet. <button type="button" className="underline" onClick={onEdit}>Make one</button>.</div>;
  }
  return (
    <>
      <div className="-mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto px-1">
        <section className="flex flex-wrap items-end gap-3">
          <label><span className="label-mono">Week of</span>
            <DateInput className={`${inputCls} mt-1 w-auto`} value={from} onChange={(v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && setFrom(weekStart(v))} /></label>
          <label><span className="label-mono">Weeks in a row</span>
            <input type="number" min={1} max={12} className={`${inputCls} mt-1 !w-20`} value={weeks} onChange={(e) => setWeeks(Math.min(12, Math.max(1, Math.round(Number(e.target.value)) || 1)))} /></label>
          <span className="pb-2 text-xs text-muted-foreground">{weekday(from)} {from} to {weekday(lastDay)} {lastDay}</span>
        </section>
        <section>
          <div className="label-mono mb-1">Patterns · {chosen.length} of {patterns.length}</div>
          <div className="flex flex-col gap-1.5">
            {patterns.map((p) => {
              const on = chosen.includes(p.id);
              const ids = Array.isArray(p.employee_ids) ? (p.employee_ids as string[]) : [];
              const people = employees.filter((e) => ids.includes(e.id) && e.active);
              return (
                <button key={p.id} type="button" aria-pressed={on} onClick={() => setPicked(on ? chosen.filter((x) => x !== p.id) : [...chosen, p.id])}
                  className={`flex flex-wrap items-baseline gap-x-3 rounded-lg px-3 py-2 text-left text-sm ring-1 ring-border ${on ? "bg-accent ring-primary/30" : "bg-secondary text-muted-foreground"}`}>
                  <span className="font-medium">{on && <Check className="-ml-0.5 mr-1 inline h-3.5 w-3.5" />}{p.name}</span>
                  <span className="text-xs">{describeWeek(readWeek(p.days))}</span>
                  <span className="text-xs text-muted-foreground">{people.length ? people.slice(0, 4).map(fullName).join(", ") + (people.length > 4 ? ` +${people.length - 4}` : "") : "no one yet"}</span>
                </button>
              );
            })}
          </div>
        </section>
        {holidayDates.length > 0 && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={skipHolidays} onChange={(e) => setSkipHolidays(e.target.checked)} />
            Skip public holidays ({holidayDates.map((h) => `${h.name}, ${weekday(h.holiday_date)} ${h.holiday_date}`).join("; ")})
          </label>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <div className="text-sm text-muted-foreground" aria-live="polite">
          {target.error ? <span className="text-destructive">Couldn't read the records: {(target.error as Error).message}</span>
            : !plan ? "Reading the records…"
            : <>
                <span className="font-medium text-foreground">{plural(plan.add.length, "shift")} for {plural(new Set(plan.add.map((r) => r.employee_id)).size, "person", "people")}</span>
                {plan.duplicates > 0 && ` · ${plan.duplicates} already there, skipped`}
                {plan.locked > 0 && ` · ${plan.locked} on days locked as paid, left out`}
                {plan.holidays > 0 && ` · ${plan.holidays} on holidays, skipped`}
                {plan.leftOut > 0 && ` · ${plan.leftOut} left out (resigned, deleted or not hired yet)`}
                {clashes.length > 0 && ` · ${plural(clashes.length, "day")} already ${clashes.length === 1 ? "has" : "have"} a different record (you'll be asked)`}
              </>}
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className={btnGhost}>Close</button>
          <button type="button" onClick={() => void fill()} disabled={busy || !plan?.add.length} className={`${btnPrimary} disabled:opacity-50`}>
            {busy ? "Adding…" : `Add ${plan?.add.length ? plural(plan.add.length, "shift") : "shifts"}`}
          </button>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- edit patterns

type DayDraft = { on: boolean; mode: "clock" | "hours"; clock_in: string; clock_out: string; lunch: string; hours: string; shift_id: string };
type Draft = { id: string | null; name: string; days: DayDraft[]; people: string[] };

const dayDraft = (d: PatternDay | null): DayDraft => d
  ? d.entry_mode === "clock"
    ? { on: true, mode: "clock", clock_in: d.clock_in, clock_out: d.clock_out, lunch: String(d.lunch_minutes), hours: "8", shift_id: d.shift_id ?? "" }
    : { on: true, mode: "hours", clock_in: "09:00", clock_out: "17:00", lunch: String(DEFAULT_BREAK_MINUTES), hours: String(d.hours), shift_id: d.shift_id ?? "" }
  : { on: false, mode: "clock", clock_in: "09:00", clock_out: "17:00", lunch: String(DEFAULT_BREAK_MINUTES), hours: "8", shift_id: "" };
const draftOf = (p: WorkPattern | null): Draft => ({
  id: p?.id ?? null, name: p?.name ?? "",
  days: (p ? readWeek(p.days) : ([...Array(5).fill({ entry_mode: "clock", clock_in: "09:00", clock_out: "17:00", lunch_minutes: DEFAULT_BREAK_MINUTES }), null, null] as PatternWeek)).map(dayDraft),
  people: p && Array.isArray(p.employee_ids) ? (p.employee_ids as string[]) : [],
});

/** The draft's days as stored, or a message saying what's wrong. */
function weekOf(d: Draft, unit: BreakUnit): PatternWeek | string {
  const week: PatternWeek = [...EMPTY_WEEK];
  for (const [i, x] of d.days.entries()) {
    if (!x.on) continue;
    const shift_id = x.shift_id || null;
    if (x.mode === "clock") {
      if (!x.clock_in || !x.clock_out) return `${WEEKDAYS[i]}: enter a clock in and clock out time`;
      const lunch = Number(x.lunch || 0);
      if (!validBreak(lunch)) return `${WEEKDAYS[i]}: ${breakRangeText(unit)}`;
      week[i] = { entry_mode: "clock", clock_in: x.clock_in, clock_out: x.clock_out, lunch_minutes: lunch, shift_id };
    } else {
      const h = readAmount(x.hours);
      if (!Number.isFinite(h) || h <= 0 || h > 24) return `${WEEKDAYS[i]}: hours must be more than 0 and at most 24`;
      week[i] = { entry_mode: "hours", hours: Math.round(h * 100) / 100, shift_id };
    }
  }
  return week.some(Boolean) ? week : "Tick at least one day";
}

function EditPatterns({ patterns }: { patterns: WorkPattern[] }) {
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | "new">(patterns[0]?.id ?? "new");
  const current = patterns.find((p) => p.id === openId) ?? null;
  // Keyed by the pattern (and what's saved in it), so saving or undoing starts the form again.
  return (
    <div className="-mx-1 flex min-h-0 flex-col gap-3 overflow-y-auto px-1">
      <div className="flex flex-wrap gap-1.5">
        {patterns.map((p) => <button key={p.id} type="button" className={chip(openId === p.id)} onClick={() => setOpenId(p.id)}>{p.name}</button>)}
        <button type="button" className={chip(openId === "new")} onClick={() => setOpenId("new")}><Plus className="-ml-0.5 mr-1 inline h-3.5 w-3.5" />New pattern</button>
      </div>
      <PatternEditor key={`${openId}|${current ? JSON.stringify([current.name, current.days, current.employee_ids]) : ""}`} pattern={current} count={patterns.length}
        onSaved={(id) => { void qc.invalidateQueries({ queryKey: ["work_patterns"] }); setOpenId(id); }}
        onDeleted={() => { void qc.invalidateQueries({ queryKey: ["work_patterns"] }); setOpenId(patterns.find((p) => p.id !== openId)?.id ?? "new"); }} />
    </div>
  );
}

function PatternEditor({ pattern, count, onSaved, onDeleted }: { pattern: WorkPattern | null; count: number; onSaved: (id: string) => void; onDeleted: () => void }) {
  const [d, setD] = useState<Draft>(() => draftOf(pattern));
  const [q, setQ] = useState<EmployeeFilter>(NO_FILTER);
  const [copyWho, setCopyWho] = useState("");
  const [copyWeek, setCopyWeek] = useState(() => weekStart(addDays(isoDate(new Date()), -7)));
  const [busy, setBusy] = useState(false);
  const [unit] = useBreakUnit();
  const { data: employees = [] } = useEmployees();
  const { data: shifts = [] } = useShifts();
  const working = useMemo(() => employees.filter((e) => e.active), [employees]);
  const shown = useMemo(() => searchEmployees(working, q), [working, q]);
  const setDay = (i: number, patch: Partial<DayDraft>) => setD({ ...d, days: d.days.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  // Picking a shift for a day fills in its usual hours, when it has some.
  const setDayShift = (i: number, shift_id: string) => {
    const t = usualTimes(shifts.find((s) => s.id === shift_id));
    setDay(i, t ? { shift_id, clock_in: t.clock_in, clock_out: t.clock_out, lunch: String(t.lunch_minutes) } : { shift_id });
  };
  // Everyone on the pattern is on one shift with usual hours: offer them for the days on "their usual shift".
  const peopleShifts = new Set(d.people.map((id) => shiftFor(employees.find((e) => e.id === id)?.shift_id, shifts).id));
  const shared = peopleShifts.size === 1 ? shifts.find((s) => s.id === [...peopleShifts][0]) : undefined;
  const sharedTimes = usualTimes(shared);
  const useShared = () => sharedTimes && setD({ ...d, days: d.days.map((x) => (x.on && !x.shift_id ? { ...x, mode: "clock", clock_in: sharedTimes.clock_in, clock_out: sharedTimes.clock_out, lunch: String(sharedTimes.lunch_minutes) } : x)) });
  const togglePerson = (id: string) => setD({ ...d, people: d.people.includes(id) ? d.people.filter((x) => x !== id) : [...d.people, id] });

  const save = async () => {
    const name = d.name.trim();
    if (!name || name.length > 60) { toast.error("Give the pattern a name (up to 60 characters)"); return; }
    const week = weekOf(d, unit);
    if (typeof week === "string") { toast.error(week); return; }
    setBusy(true);
    try {
      const row = { name, days: week, employee_ids: d.people };
      if (pattern) {
        const { error } = await db().update("work_patterns", pattern.id, row);
        if (error) throw error;
        toast.success(`${name} saved`);
        onSaved(pattern.id);
      } else {
        const id = crypto.randomUUID();
        const { error } = await db().insert("work_patterns", { id, ...row, sort_order: count });
        if (error) throw error;
        toast.success(`Saved the ${name} pattern`);
        onSaved(id);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!pattern || !(await askConfirm({ title: `Delete the ${pattern.name} pattern?`, detail: "Records it already added stay.", confirm: "Delete pattern", danger: true }))) return;
    const { error } = await db().remove("work_patterns", pattern.id);
    if (error) toast.error(error.message); else onDeleted();
  };
  const copyFrom = async () => {
    if (!copyWho) { toast.error("Pick whose week to copy"); return; }
    const recs = await db().listRecordsMatching({ from: copyWeek, to: addDays(copyWeek, 6), employeeIds: [copyWho] });
    if (!recs.length) { toast.info("They have no records that week"); return; }
    const who = employees.find((e) => e.id === copyWho);
    setD({ ...d, name: d.name || (who ? `${who.first_name}'s week` : ""), days: weekFromRecords(recs, copyWeek).map(dayDraft), people: d.people.includes(copyWho) ? d.people : [...d.people, copyWho] });
    toast.success("Filled in from their week. Check it, then Save.");
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-[14rem] flex-1"><span className="label-mono">Name</span>
          <input className={`${inputCls} mt-1`} placeholder="e.g. Weekdays 9–5" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} aria-label="Pattern name" /></label>
        <div className="flex flex-wrap items-end gap-2 rounded-xl bg-secondary/60 p-2 ring-1 ring-border">
          <span className="label-mono w-full">Copy from someone's week</span>
          <div className="w-48"><EmployeePicker employees={working} value={copyWho} onChange={setCopyWho} placeholder="Who" /></div>
          <DateInput className={`${inputCls} w-36`} value={copyWeek} onChange={(v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && setCopyWeek(weekStart(v))} aria-label="Week to copy from" />
          <button type="button" onClick={() => void copyFrom()} className={btnGhost}>Copy</button>
        </div>
      </div>

      {shared && sharedTimes && (
        <p className="text-xs text-muted-foreground">
          Everyone on this pattern is on {shared.name} ({describeTimes(sharedTimes)}).{" "}
          <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={useShared}>Use its usual hours for every working day</button>
        </p>
      )}
      <div className="divide-y divide-border rounded-xl ring-1 ring-border">
        {d.days.map((x, i) => (
          <div key={WEEKDAYS[i]} className={`flex flex-wrap items-center gap-2 px-3 py-2 text-sm ${x.on ? "" : "opacity-60"}`}>
            <label className="flex w-16 items-center gap-2 font-medium"><input type="checkbox" checked={x.on} onChange={(e) => setDay(i, { on: e.target.checked })} aria-label={`Works ${WEEKDAYS[i]}`} />{WEEKDAYS[i]}</label>
            {x.on && <>
              <div className="flex rounded-lg bg-secondary p-0.5 text-xs ring-1 ring-border">
                {(["clock", "hours"] as const).map((m) => (
                  <button key={m} type="button" onClick={() => setDay(i, { mode: m })} className={`rounded-md px-2 py-1 ${x.mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>{m === "clock" ? "Times" : "Hours"}</button>
                ))}
              </div>
              {x.mode === "clock" ? <>
                <input type="time" className={`${inputCls} !w-[7.5rem]`} value={x.clock_in} onChange={(e) => setDay(i, { clock_in: e.target.value })} aria-label={`${WEEKDAYS[i]} clock in`} />
                <span className="text-muted-foreground">–</span>
                <input type="time" className={`${inputCls} !w-[7.5rem]`} value={x.clock_out} onChange={(e) => setDay(i, { clock_out: e.target.value })} aria-label={`${WEEKDAYS[i]} clock out`} />
                <BreakInput minutes={x.lunch} onChange={(m) => setDay(i, { lunch: m })} className={`${inputCls} !w-20`} label={`${WEEKDAYS[i]} break`} />
                <span className="text-xs text-muted-foreground">{unit === "h" ? "h" : "min"} break</span>
              </> : <>
                <input className={`${inputCls} !w-20`} inputMode="decimal" value={x.hours} onChange={(e) => setDay(i, { hours: e.target.value })} aria-label={`${WEEKDAYS[i]} hours`} />
                <span className="text-xs text-muted-foreground">hours</span>
              </>}
              <select className={`${inputCls} !w-40`} value={x.shift_id} onChange={(e) => setDayShift(i, e.target.value)} aria-label={`${WEEKDAYS[i]} shift`}>
                <option value="">Their usual shift</option>
                {shifts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              {i < 6 && <button type="button" className="ml-auto text-xs text-muted-foreground hover:text-foreground" title="Make the following days the same"
                onClick={() => setD({ ...d, days: d.days.map((y, j) => (j > i && y.on ? { ...x } : y)) })}>Same for later days</button>}
            </>}
          </div>
        ))}
      </div>

      <section>
        <div className="mb-1 flex items-center justify-between">
          <span className="label-mono">Who works it · {d.people.filter((id) => working.some((e) => e.id === id)).length}</span>
          <div className="flex gap-3 text-xs text-muted-foreground">
            <button type="button" className="hover:text-foreground" onClick={() => setD({ ...d, people: [...new Set([...d.people, ...shown.map((e) => e.id)])] })}>{isFiltering(q) ? `Select all ${shown.length} shown` : "Select all"}</button>
            <button type="button" className="hover:text-foreground" onClick={() => setD({ ...d, people: [] })}>Clear</button>
          </div>
        </div>
        <SearchInput value={q} onChange={setQ} employees={working} className="mb-2" />
        <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
          {working.length > 0 && shown.length === 0 && <span className="text-sm text-muted-foreground">No employee matches {describeEmployeeFilter(q)}.</span>}
          {shown.map((e: Employee) => {
            const on = d.people.includes(e.id);
            return (
              <button type="button" key={e.id} onClick={() => togglePerson(e.id)} aria-pressed={on} className={chip(on)}>
                {on && <Check className="-ml-0.5 mr-1 inline h-3.5 w-3.5" />}{fullName(e)} <span className="font-mono text-[11px] opacity-70">{e.employee_code}</span>
              </button>
            );
          })}
        </div>
      </section>

      <div className="flex items-center justify-between border-t border-border pt-3">
        {pattern ? <button type="button" onClick={() => void remove()} className={`${btnGhost} hover:!text-destructive`}><Trash2 className="mr-1 inline h-4 w-4" />Delete</button> : <span />}
        <button type="button" onClick={() => void save()} disabled={busy} className={btnPrimary}>{pattern ? "Save pattern" : "Save new pattern"}</button>
      </div>
    </div>
  );
}
