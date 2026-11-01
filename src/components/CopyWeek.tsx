import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, CopyPlus } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { btnGhost, btnPrimary, inputCls } from "@/components/AppShell";
import { SearchInput } from "@/components/EmployeeSearch";
import { askChoice } from "@/lib/choice-prompt";
import { planCopy } from "@/lib/copy-week";
import { db, storeFor, useDataMode } from "@/lib/db/mode";
import { backupBefore } from "@/lib/db/safety";
import { describeEmployeeFilter, isFiltering, NO_FILTER, searchEmployees, type EmployeeFilter } from "@/lib/employee-search";
import { weekStartOf } from "@/lib/export/timesheet-export";
import { addDays, fullName, isoDate, useEmployees, usePayrollSettings, weekday } from "@/lib/payroll";
import { describeRecord, sameDayClashes } from "@/lib/record-clash";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
const monday = (d: string) => weekStartOf(d, 1);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const chip = (on: boolean) => `rounded-lg px-2.5 py-1 text-xs ring-1 ring-border ${on ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`;

/** Time records' "Copy a week": gives a week's shifts again in the weeks after (or before). The deciding is planCopy's. */
export function CopyWeek() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={btnGhost} title="Give people the same shifts as in another week">
        <CopyPlus className="mr-1 inline h-4 w-4" />Copy a week…
      </button>
      {open && <CopyWeekDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function CopyWeekDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const dataMode = useDataMode();
  const today = isoDate(new Date());
  const [from, setFrom] = useState(() => monday(addDays(today, -7)));
  const [to, setTo] = useState(() => monday(today));
  const [weeks, setWeeks] = useState(1);
  const [days, setDays] = useState(ALL_DAYS);
  /** Who to copy for; null until changed, meaning everyone still working who has records that week. */
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [q, setQ] = useState<EmployeeFilter>(NO_FILTER);
  const [busy, setBusy] = useState(false);

  const { data: employees = [] } = useEmployees();
  const { data: settings } = usePayrollSettings();
  const working = useMemo(() => employees.filter((e) => e.active), [employees]);
  const lastDay = addDays(to, 7 * weeks - 1);
  // Under ["records"], so adding records anywhere (and this copy) refreshes them.
  const source = useQuery({
    queryKey: ["records", "copy-from", dataMode, from],
    queryFn: () => storeFor(dataMode).listRecordsMatching({ from, to: addDays(from, 6) }),
  });
  const target = useQuery({
    queryKey: ["records", "copy-to", dataMode, to, lastDay],
    queryFn: () => storeFor(dataMode).listRecordKeys(to, lastDay),
  });

  // Resigned employees can't be given new hours, so they're never copied (as in the New record form).
  const inSource = useMemo(() => new Set((source.data ?? []).map((r) => r.employee_id)), [source.data]);
  const everyoneWhoWorked = useMemo(() => working.filter((e) => inSource.has(e.id)).map((e) => e.id), [working, inSource]);
  const people = chosen ?? everyoneWhoWorked;
  const shown = useMemo(() => searchEmployees(working, q), [working, q]);
  const toggle = (id: string) => setChosen(people.includes(id) ? people.filter((x) => x !== id) : [...people, id]);
  const pickFrom = (d: string) => { if (isDate(d)) { setFrom(monday(d)); setChosen(null); } };

  const sameWeek = from === to;
  const lockedThrough = settings?.locked_through;
  const plan = useMemo(
    () => (source.data && target.data && !sameWeek ? planCopy({ records: source.data, from, to, weeks, days, employeeIds: people, lockedThrough, existing: target.data }) : null),
    [source.data, target.data, from, to, weeks, days, people, lockedThrough, sameWeek],
  );
  const clashes = useMemo(() => (plan && target.data ? sameDayClashes(plan.add, target.data) : []), [plan, target.data]);
  const copiedPeople = new Set(plan?.add.map((r) => r.employee_id)).size;

  const copy = async () => {
    if (!plan?.add.length) return;
    let rows = plan.add;
    // A second record on a day usually pays it twice by mistake, but can be a real second shift: ask once for them all.
    if (clashes.length) {
      const nameOf = (id: string) => { const e = employees.find((x) => x.id === id); return e ? fullName(e) : "Someone"; };
      const all = clashes.length === new Set(rows.map((r) => `${r.employee_id}|${r.work_date}`)).size;
      const answer = await askChoice({
        title: clashes.length === 1 ? "Already has a different record that day" : `${clashes.length} days already have a different record`,
        detail: "Adding the copy as well would pay those days twice. That's right only if they really worked twice, e.g. a day and a night shift.",
        items: clashes.map((c) => `${nameOf(c.employee_id)} · ${weekday(c.work_date)} ${c.work_date} · already ${c.existing.map(describeRecord).join(", ")}`),
        choices: [
          { id: "cancel", label: "Cancel" },
          { id: "all", label: "Add anyway", danger: true },
          ...(all ? [] : [{ id: "skip", label: "Skip those days, copy the rest", primary: true }]),
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
      await backupBefore("copy-week");
      // One insert: all or nothing, and one Ctrl+Z takes the whole copy back.
      const { error } = await db().insert("time_records", rows);
      if (error) throw error;
      toast.success(`Copied ${plural(rows.length, "shift")} into ${weeks === 1 ? `the week of ${to}` : `${weeks} weeks from ${to}`}. Ctrl+Z takes them all back.`);
      qc.invalidateQueries({ queryKey: ["records"] });
      onClose();
    } catch (e) {
      toast.error(`Nothing was copied: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const weekLabel = (d: string) => `${weekday(d)} ${d} to ${weekday(addDays(d, 6))} ${addDays(d, 6)}`;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[92vh] max-w-2xl flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Copy a week</DialogTitle>
          <DialogDescription>Gives people the same shifts as in another week: same days, times, breaks and shift. Pay set by hand isn't copied.</DialogDescription>
        </DialogHeader>
        <div className="-mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto px-1">
          <section className="flex flex-wrap items-end gap-3">
            <label><span className="label-mono">From the week of</span>
              <input type="date" className={`${inputCls} mt-1 w-auto`} value={from} onChange={(e) => pickFrom(e.target.value)} /></label>
            <label><span className="label-mono">To the week of</span>
              <input type="date" className={`${inputCls} mt-1 w-auto ${sameWeek ? "ring-2 ring-destructive" : ""}`} value={to} onChange={(e) => isDate(e.target.value) && setTo(monday(e.target.value))} /></label>
            <label><span className="label-mono">Weeks in a row</span>
              <input type="number" min={1} max={8} className={`${inputCls} mt-1 !w-20`} value={weeks} onChange={(e) => setWeeks(Math.min(8, Math.max(1, Math.round(Number(e.target.value)) || 1)))} /></label>
          </section>
          <div className="-mt-2 text-xs text-muted-foreground">
            {weekLabel(from)} → {weeks === 1 ? weekLabel(to) : `${weekday(to)} ${to} to ${weekday(lastDay)} ${lastDay}`}
            {sameWeek && <span className="text-destructive"> · pick a different week to copy to</span>}
          </div>

          <section>
            <div className="label-mono mb-1">Days</div>
            <div className="flex flex-wrap gap-1.5">
              {DAY_NAMES.map((name, i) => {
                const on = days.includes(i);
                return (
                  <button type="button" key={name} aria-pressed={on} className={chip(on)} title={`${weekday(addDays(from, i))} ${addDays(from, i)}`}
                    onClick={() => setDays(on ? days.filter((d) => d !== i) : [...days, i].sort())}>
                    {on && <Check className="-ml-0.5 mr-1 inline h-3 w-3" />}{name}
                  </button>
                );
              })}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">Untick a day to leave it out, e.g. a public holiday.</div>
          </section>

          <section>
            <div className="mb-1 flex items-center justify-between">
              <span className="label-mono">Employees · {people.length} selected</span>
              <div className="flex gap-3 text-xs text-muted-foreground">
                <button type="button" className="hover:text-foreground" onClick={() => setChosen(null)}>Everyone who worked that week</button>
                <button type="button" className="hover:text-foreground" onClick={() => setChosen([...new Set([...people, ...shown.map((e) => e.id)])])}>
                  {isFiltering(q) ? `Select all ${shown.length} shown` : "Select all"}
                </button>
                <button type="button" className="hover:text-foreground" onClick={() => setChosen([])}>Clear</button>
              </div>
            </div>
            <SearchInput value={q} onChange={setQ} employees={working} className="mb-2" />
            <div className="flex max-h-44 flex-wrap gap-2 overflow-y-auto">
              {working.length === 0 && <span className="text-sm text-muted-foreground">No employees yet.</span>}
              {working.length > 0 && shown.length === 0 && <span className="text-sm text-muted-foreground">No employee matches {describeEmployeeFilter(q)}.</span>}
              {shown.map((e) => {
                const on = people.includes(e.id);
                return (
                  <button type="button" key={e.id} onClick={() => toggle(e.id)} aria-pressed={on} title={on ? "Click to leave out" : "Click to include"}
                    className={`rounded-lg px-3 py-1.5 text-sm ring-1 ring-border ${on ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"} ${inSource.has(e.id) ? "" : "opacity-60"}`}>
                    {on && <Check className="-ml-0.5 mr-1 inline h-3.5 w-3.5" />}
                    {fullName(e)} <span className="font-mono text-[11px] opacity-70">{e.employee_code}</span>
                    {!inSource.has(e.id) && <span className="ml-1 text-[11px] opacity-70">(no records that week)</span>}
                  </button>
                );
              })}
            </div>
          </section>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <div className="text-sm text-muted-foreground" aria-live="polite">
            {source.error || target.error ? <span className="text-destructive">Couldn't read the records: {((source.error ?? target.error) as Error).message}</span>
              : !plan ? (sameWeek ? "" : "Reading the records…")
              : <>
                  <span className="font-medium text-foreground">{plural(plan.add.length, "shift")} for {plural(copiedPeople, "person", "people")}</span>
                  {plan.duplicates > 0 && ` · ${plan.duplicates} already there, skipped`}
                  {plan.locked > 0 && ` · ${plan.locked} on days locked as paid, left out`}
                  {clashes.length > 0 && ` · ${plural(clashes.length, "day")} already ${clashes.length === 1 ? "has" : "have"} a different record (you'll be asked)`}
                </>}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className={btnGhost}>Close</button>
            <button type="button" onClick={() => void copy()} disabled={busy || !plan?.add.length} className={`${btnPrimary} disabled:opacity-50`}>
              {busy ? "Copying…" : `Copy ${plan?.add.length ? plural(plan.add.length, "shift") : ""}`}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
