import { useMemo, useState } from "react";
import { zipSync } from "fflate";
import { toast } from "sonner";
import { Check, Files, Pencil, Play, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { btnGhost, btnPrimary, inputCls } from "@/components/AppShell";
import { SearchInput } from "@/components/EmployeeSearch";
import { downloadBlob } from "@/lib/db/backups";
import { describeEmployeeFilter, isFiltering, NO_FILTER, searchEmployees, type EmployeeFilter } from "@/lib/employee-search";
import { employeeTimesheet } from "@/lib/export/employee-timesheet";
import { useRoutines, useTemplates, type ExportRoutine } from "@/lib/export/template-store";
import { exportFile, exportKindFrom, type ExportedFile } from "@/lib/export/timesheet-export";
import { weekEnd, weekStart } from "@/lib/pay";
import {
  fullName, isoDate, useAdjustments, useAllRecords, useEmployees, useFieldDefs, usePayRates, usePayrollSettings, useShifts, weekday,
} from "@/lib/payroll";
import { periodPresets } from "@/lib/periods";

const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);

/** The Timesheet page's "Export several": many people's timesheets for one period at once, in a zip, and saved routines to do it again. */
export function BulkExport({ from, to }: { from: string; to: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={btnGhost} title="Export timesheets for several people at once">
        <Files className="mr-1 inline h-4 w-4" />Export several…
      </button>
      {open && <BulkExportDialog initialFrom={from} initialTo={to} onClose={() => setOpen(false)} />}
    </>
  );
}

type Choice = { employeeIds: string[]; output: string; skipEmpty: boolean };
const NEW_CHOICE: Choice = { employeeIds: [], output: "xlsx", skipEmpty: false };

function BulkExportDialog({ initialFrom, initialTo, onClose }: { initialFrom: string; initialTo: string; onClose: () => void }) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const badRange = !isDate(from) || !isDate(to) || from > to;

  // Everything a timesheet needs, for everyone, over the whole Mon–Sun weeks around the period (as the Timesheet page loads).
  const { data: employees = [] } = useEmployees();
  const { data: rateHistory, isLoading: ratesLoading } = usePayRates();
  const { data: shifts = [] } = useShifts();
  const { data: defs = [] } = useFieldDefs();
  const { data: settings } = usePayrollSettings();
  const { data: records = [], isLoading: recordsLoading } = useAllRecords(weekStart(badRange ? initialFrom : from), weekEnd(badRange ? initialTo : to));
  const { data: adjustments = [], isLoading: adjLoading } = useAdjustments(from, to);
  const loading = ratesLoading || recordsLoading || adjLoading;
  const templates = useTemplates();
  const [routines, setRoutines] = useRoutines();

  const [choice, setChoice] = useState<Choice>(NEW_CHOICE);
  /** The routine loaded into the form to change, if any. */
  const [editing, setEditing] = useState<ExportRoutine | null>(null);
  const [routineName, setRoutineName] = useState("");
  const [q, setQ] = useState<EmployeeFilter>(NO_FILTER);
  const shown = useMemo(() => searchEmployees(employees, q), [employees, q]);
  const toggle = (id: string) => setChoice((c) => ({ ...c, employeeIds: c.employeeIds.includes(id) ? c.employeeIds.filter((x) => x !== id) : [...c.employeeIds, id] }));

  /** What a routine or the form is made as, or why it can't be. */
  const kindOf = (output: string) => exportKindFrom(output, templates);
  const outputName = (output: string) => {
    const k = kindOf(output);
    if (!k) return "A deleted template";
    const format = k.format === "xlsx" ? "Excel" : k.format === "csv" ? "CSV" : "PDF";
    return k.template ? `${k.template.name} (${format})` : `${format} file`;
  };
  // PDFs take a moment each, so the buttons wait while a run is going.
  const [busy, setBusy] = useState(false);

  /** Makes each person's file, then downloads one file, or a zip of them all. */
  const run = async (c: Choice) => {
    if (badRange) { toast.error("Pick a start date on or before the end date."); return; }
    if (loading) { toast.error("Still loading the time records. Try again in a moment."); return; }
    const kind = kindOf(c.output);
    if (!kind) { toast.error("That template has been deleted. Pick another way to make the files."); return; }
    const people = c.employeeIds.map((id) => employees.find((e) => e.id === id)).filter((e) => !!e);
    const rules = { threshold: settings?.ot_threshold ?? 40, otMultiplier: settings?.ot_multiplier ?? 1.5, weekendOvertime: settings?.weekend_overtime ?? true };
    const today = isoDate(new Date());
    const files: Record<string, Uint8Array> = {};
    const failed: string[] = [];
    let skipped = 0;
    let last: ExportedFile | null = null;
    setBusy(true);
    for (const emp of people) {
      if (c.skipEmpty && !records.some((r) => r.employee_id === emp.id && r.work_date >= from && r.work_date <= to)) { skipped++; continue; }
      try {
        const f = await exportFile(kind, employeeTimesheet(emp, { from, to, today, records, adjustments, shifts, defs, rateHistory: rateHistory?.get(emp.id), rules }), `timesheet ${fullName(emp)} ${emp.employee_code} ${from} to ${to}`);
        // Two people can't end up with the same name in the zip, which would keep only one of them.
        let name = f.name;
        for (let i = 2; files[name]; i++) name = f.name.replace(/(\.\w+)$/, ` (${i})$1`);
        files[name] = f.bytes;
        last = { ...f, name };
      } catch (e) { failed.push(`${fullName(emp)}: ${(e as Error).message}`); }
    }
    setBusy(false);
    const made = Object.keys(files).length;
    if (made === 1 && last) downloadBlob(new Blob([last.bytes as Uint8Array<ArrayBuffer>], { type: last.type }), last.name);
    else if (made > 1) downloadBlob(new Blob([zipSync(files) as Uint8Array<ArrayBuffer>], { type: "application/zip" }), `timesheets ${from} to ${to}.zip`);
    const missing = c.employeeIds.length - people.length;
    const notes = [
      skipped && `${skipped} with no time records left out`,
      missing && `${missing} no longer in the employee list`,
    ].filter(Boolean).join("; ");
    if (made) toast.success(`Exported ${made} timesheet${made === 1 ? "" : "s"}${made > 1 ? " in a zip file" : ""}${notes ? ` (${notes})` : ""}.`);
    else if (!failed.length) toast.error(`Nothing to export${notes ? `: ${notes}` : ". Pick some people first."}`);
    if (failed.length) toast.error(`${failed.length} couldn't be exported. ${failed.slice(0, 3).join(" · ")}${failed.length > 3 ? ` · and ${failed.length - 3} more` : ""}`, { duration: 15000 });
  };

  const saveRoutine = (asNew: boolean) => {
    const name = routineName.trim();
    if (!name) { toast.error("Give the routine a name."); return; }
    const r: ExportRoutine = { id: !asNew && editing ? editing.id : crypto.randomUUID(), name, ...choice };
    setRoutines(routines.some((x) => x.id === r.id) ? routines.map((x) => (x.id === r.id ? r : x)) : [...routines, r]);
    setEditing(r);
    toast.success(`Routine "${name}" saved. Next time, pick the dates and press its Export button.`);
  };
  const load = (r: ExportRoutine) => { setEditing(r); setRoutineName(r.name); setChoice({ employeeIds: r.employeeIds, output: r.output, skipEmpty: r.skipEmpty }); };
  const removeRoutine = (r: ExportRoutine) => {
    if (!confirm(`Delete the "${r.name}" routine? No timesheets are affected.`)) return;
    setRoutines(routines.filter((x) => x.id !== r.id));
    if (editing?.id === r.id) { setEditing(null); setRoutineName(""); }
  };
  const summary = (r: Choice) => {
    const here = r.employeeIds.filter((id) => employees.some((e) => e.id === id)).length;
    return `${here} ${here === 1 ? "person" : "people"} · ${outputName(r.output)}${r.skipEmpty ? " · skips people with no records" : ""}`;
  };
  const chip = (on: boolean) => `rounded-lg px-2.5 py-1 text-xs ring-1 ring-border ${on ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[92vh] max-w-3xl flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Export several timesheets</DialogTitle>
          <DialogDescription>Each person gets their own file for the same period, all downloaded together in one zip file. Save the choice as a routine to do it again with other dates.</DialogDescription>
        </DialogHeader>
        <div className="-mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto px-1">
          <section>
            <div className="label-mono mb-1">1 · Period</div>
            <div className="flex flex-wrap items-end gap-3">
              <label><span className="text-xs text-muted-foreground">From{isDate(from) && ` · ${weekday(from)}`}</span>
                <input type="date" className={`${inputCls} mt-0.5 w-auto`} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
              <label><span className="text-xs text-muted-foreground">To{isDate(to) && ` · ${weekday(to)}`}</span>
                <input type="date" className={`${inputCls} mt-0.5 w-auto`} value={to} onChange={(e) => setTo(e.target.value)} /></label>
              <div className="flex flex-wrap gap-1.5">
                {periodPresets().map((p) => <button key={p.key} type="button" className={chip(p.from === from && p.to === to)} onClick={() => { setFrom(p.from); setTo(p.to); }}>{p.label}</button>)}
              </div>
            </div>
            {badRange && <div className="mt-1 text-xs text-destructive">The start date is after the end date.</div>}
          </section>

          {routines.length > 0 && (
            <section>
              <div className="label-mono mb-1">Your routines: export for the period above in one click</div>
              <div className="divide-y divide-border rounded-xl ring-1 ring-border">
                {routines.map((r) => (
                  <div key={r.id} className={`flex items-center gap-2 px-3 py-2 ${editing?.id === r.id ? "bg-primary/10" : ""}`}>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{r.name}</div>
                      <div className="truncate text-xs text-muted-foreground">{summary(r)}</div>
                    </div>
                    <button type="button" onClick={() => void run(r)} disabled={badRange || loading || busy} className={`${btnPrimary} !px-3 !py-1.5 text-xs disabled:opacity-50`} title={`Export for ${from} to ${to}`}>
                      <Play className="mr-1 inline h-3.5 w-3.5" />Export
                    </button>
                    <button type="button" onClick={() => load(r)} className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground" aria-label={`Change the ${r.name} routine`} title="Change it below"><Pencil className="h-3.5 w-3.5" /></button>
                    <button type="button" onClick={() => removeRoutine(r)} className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-destructive" aria-label={`Delete the ${r.name} routine`}><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section>
            <div className="mb-1 flex items-center justify-between">
              <span className="label-mono">2 · Employees · {choice.employeeIds.length} selected{editing ? ` (routine "${editing.name}")` : ""}</span>
              <div className="flex gap-3 text-xs text-muted-foreground">
                <button type="button" className="hover:text-foreground" onClick={() => setChoice((c) => ({ ...c, employeeIds: [...new Set([...c.employeeIds, ...shown.map((e) => e.id)])] }))}>
                  {isFiltering(q) ? `Select all ${shown.length} shown` : "Select all"}
                </button>
                <button type="button" className="hover:text-foreground" onClick={() => setChoice((c) => ({ ...c, employeeIds: [] }))}>Clear</button>
              </div>
            </div>
            <SearchInput value={q} onChange={setQ} employees={employees} className="mb-2" />
            <div className="flex max-h-44 flex-wrap gap-2 overflow-y-auto">
              {employees.length === 0 && <span className="text-sm text-muted-foreground">No employees yet.</span>}
              {employees.length > 0 && shown.length === 0 && <span className="text-sm text-muted-foreground">No employee matches {describeEmployeeFilter(q)}.</span>}
              {shown.map((e) => {
                const on = choice.employeeIds.includes(e.id);
                return (
                  <button type="button" key={e.id} onClick={() => toggle(e.id)} aria-pressed={on} title={on ? "Click to leave out" : "Click to include"}
                    className={`rounded-lg px-3 py-1.5 text-sm ring-1 ring-border ${on ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`}>
                    {on && <Check className="-ml-0.5 mr-1 inline h-3.5 w-3.5" />}
                    {fullName(e)} <span className="font-mono text-[11px] opacity-70">{e.employee_code}</span>{!e.active && <span className="ml-1 text-[11px] opacity-70">(resigned)</span>}
                  </button>
                );
              })}
            </div>
          </section>

          <section className="flex flex-wrap items-end gap-4">
            <label className="min-w-[14rem]"><span className="label-mono">3 · Made as</span>
              <select className={`${inputCls} mt-1`} value={choice.output} onChange={(e) => setChoice({ ...choice, output: e.target.value })}>
                <option value="xlsx">Excel file (.xlsx)</option>
                <option value="csv">CSV file (.csv)</option>
                <option value="pdf">PDF file (.pdf)</option>
                {templates.length > 0 && <optgroup label="Your templates">{templates.flatMap((t) => [
                  <option key={t.id} value={t.id}>{t.name} (Excel)</option>,
                  <option key={`pdf:${t.id}`} value={`pdf:${t.id}`}>{t.name} (PDF)</option>,
                ])}</optgroup>}
                {!kindOf(choice.output) && <option value={choice.output}>A deleted template</option>}
              </select></label>
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input type="checkbox" checked={choice.skipEmpty} onChange={(e) => setChoice({ ...choice, skipEmpty: e.target.checked })} />
              Leave out people with no time records in the period
            </label>
          </section>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <input className={`${inputCls} !w-48 !py-1.5 text-sm`} placeholder="Routine name" value={routineName} onChange={(e) => setRoutineName(e.target.value)} aria-label="Routine name" />
            {editing && <button type="button" onClick={() => saveRoutine(false)} className={btnGhost}>Update "{editing.name}"</button>}
            <button type="button" onClick={() => saveRoutine(true)} disabled={!choice.employeeIds.length} className={`${btnGhost} disabled:opacity-50`}>Save as {editing ? "new " : ""}routine</button>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className={btnGhost}>Close</button>
            <button type="button" onClick={() => void run(choice)} disabled={badRange || loading || busy || !choice.employeeIds.length} className={`${btnPrimary} disabled:opacity-50`}>
              {loading ? "Loading records…" : busy ? "Exporting…" : `Export ${choice.employeeIds.length || ""} timesheet${choice.employeeIds.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
