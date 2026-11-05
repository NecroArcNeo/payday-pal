import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { db, storeFor, undoable, useDataMode } from "@/lib/db/mode";
import { backupBefore } from "@/lib/db/safety";
import { AppShell, btnGhost, btnPrimary, inputCls } from "@/components/AppShell";
import { EmployeePicker } from "@/components/EmployeeSearch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DataTable } from "@/components/DataTable";
import { Check, Plus, X } from "lucide-react";
import { TaskProgress } from "@/components/Loading";
import { NO_DEFAULTS } from "@/lib/employee-fields";
import { fullName, useEmployeeDefaults, useEmployees, useFieldDefs, useShifts, type Employee, type FieldDef } from "@/lib/payroll";
import {
  columnLetter, fieldsFor, guessColumns, guessSetup, lastFilledRow, MAX_ROWS, norm, parsePeople, parseRecords, readWorkbook, recordKey, rowNumber,
  type DateOrder, type PersonRow, type RecordRow, type Role, type Sheet, type SheetSetup, type Target,
} from "@/lib/import/parse";

const IMPORT_STEPS = 4;

export const Route = createFileRoute("/_authenticated/import")({
  head: () => ({ meta: [{ title: "Import — KoPayroll" }] }),
  component: ImportPage,
});

const PREVIEW_HEAD = 120;
const PREVIEW_TAIL = 15;
type ClickSets = "header" | "first" | "last";

// ---------------------------------------------------------------- remembered mappings
// Timesheets usually arrive in the same layout every week, so the last mapping
// used for a sheet with the same name and header row is offered again.

type Remembered = Pick<SheetSetup, "role" | "headerRow" | "columns" | "dateOrder"> & { firstFromHeader: number; lastFromEnd: number };
const memoryKey = (sheet: Sheet, headerRow: number | null) =>
  `meridian-import-map:v1:${sheet.name}|${headerRow === null ? "" : (sheet.grid[headerRow] ?? []).map((c) => norm(c.text)).join(",")}`;

function recall(sheet: Sheet, guess: SheetSetup, defs: FieldDef[]): SheetSetup | null {
  try {
    const raw = localStorage.getItem(memoryKey(sheet, guess.headerRow));
    if (!raw) return null;
    const m = JSON.parse(raw) as Remembered;
    if (m.columns.length !== sheet.width) return null;
    const live = new Set(defs.map((d) => `custom:${d.id}`));
    const last = lastFilledRow(sheet);
    return {
      ...guess, role: m.role, headerRow: m.headerRow, dateOrder: m.dateOrder,
      firstRow: (m.headerRow ?? -1) + m.firstFromHeader, lastRow: Math.max(0, last - m.lastFromEnd),
      columns: m.columns.map((t) => (t.startsWith("custom:") && !live.has(t) ? "" : t)),
    };
  } catch {
    return null;
  }
}

function remember(sheet: Sheet, s: SheetSetup, created: Map<Target, string>) {
  try {
    const m: Remembered = {
      role: s.role, headerRow: s.headerRow, dateOrder: s.dateOrder,
      columns: s.columns.map((t) => (created.has(t) ? `custom:${created.get(t)}` : t)),
      firstFromHeader: s.firstRow - (s.headerRow ?? -1), lastFromEnd: lastFilledRow(sheet) - s.lastRow,
    };
    localStorage.setItem(memoryKey(sheet, s.headerRow), JSON.stringify(m));
  } catch { /* not remembering is fine */ }
}

// ---------------------------------------------------------------- template

const template = () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ["Employee ID", "Name", "Email", "Phone", "Job title", "Department", "Hourly rate", "Address", "City", "State", "Zip", "Hire date"],
    ["E100", "Nadia Okafor", "nadia@example.com", "555-0100", "Picker", "Warehouse", 28, "12 Elm St", "Austin", "TX", "78701", "2026-01-15"],
  ]), "New people");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ["Employee ID", "Date", "Clock in", "Clock out", "Break minutes", "Hours"],
    ["E100", "2026-10-05", "09:00", "17:30", 30, ""],
    ["E100", "2026-10-06", "", "", "", 7.5],
  ]), "Hours");
  XLSX.writeFile(wb, "payroll_import_template.xlsx");
};

// ---------------------------------------------------------------- page

function ImportPage() {
  const qc = useQueryClient();
  const mode = useDataMode();
  const { data: employees = [] } = useEmployees();
  const { data: defs = [] } = useFieldDefs();
  const typeOf = useMemo(() => { const m = new Map(defs.map((d) => [d.id, d.field_type])); return (id: string) => m.get(id); }, [defs]);
  const { data: defaults = NO_DEFAULTS } = useEmployeeDefaults();
  const { data: shifts = [] } = useShifts();
  const [file, setFile] = useState("");
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [setups, setSetups] = useState<SheetSetup[]>([]);
  const [active, setActive] = useState(0);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [busy, setBusy] = useState(false);
  // Which step of the import is running (backing up, categories, people, hours): each is one database call, so the
  // bar moves by step rather than by row.
  const [step, setStep] = useState<{ done: number; label: string } | null>(null);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handle = async (f: File) => {
    if (f.size > 20 * 1024 * 1024) { toast.error("File must be under 20MB"); return; }
    try {
      const list = readWorkbook(await f.arrayBuffer(), f.name);
      if (!list.some((s) => s.grid.length)) { toast.error("This file has no data"); return; }
      setFile(f.name);
      skippedAs.current.clear();
      setSheets(list);
      setSetups(list.map((s) => { const g = guessSetup(s, defs); return recall(s, g, defs) ?? g; }));
      setActive(Math.max(0, list.findIndex((s) => s.grid.length)));
    } catch {
      toast.error("Couldn't read that file. Is it a CSV or Excel file?");
    }
  };

  const update = (i: number, patch: Partial<SheetSetup>) => {
    // Remember what a skipped sheet was, so bringing it back restores it as it was.
    if (patch.role === "ignore" && setups[i] && setups[i]!.role !== "ignore") skippedAs.current.set(i, setups[i]!.role);
    setSetups((all) => all.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  };
  const skippedAs = useRef(new Map<number, Role>());
  const shownSheets = sheets.map((_, i) => i).filter((i) => setups[i]?.role !== "ignore");
  const skipSheet = (i: number) => {
    update(i, { role: "ignore" });
    if (i === active || !shownSheets.includes(active)) setActive(shownSheets.find((j) => j > i) ?? [...shownSheets].reverse().find((j) => j < i) ?? i);
  };
  const restoreSheet = (i: number) => {
    const s = sheets[i]!, setup = setups[i]!;
    let role = skippedAs.current.get(i);
    if (!role) { const g = guessSetup(s, defs).role; role = g === "ignore" ? "people" : g; }
    update(i, { role, columns: role === skippedAs.current.get(i) ? setup.columns : guessColumns(s, setup.headerRow, role, defs) });
    setActive(i);
  };

  // ---- preview: parse exactly what Import would save
  const newCategories = useMemo(() => {
    const labels = new Map<Target, string>();
    setups.forEach((s) => { if (s.role === "people") for (const t of s.columns) if (t.startsWith("new:")) labels.set(t, t.slice(4)); });
    return labels;
  }, [setups]);

  const preview = useMemo(() => {
    const taken = new Set(employees.map((e) => e.employee_code.toLowerCase()));
    const resolve = (t: Target) => (t.startsWith("custom:") ? t.slice(7) : newCategories.has(t) ? t : undefined);
    const people = sheets.map((s, i) => (setups[i]?.role === "people" ? parsePeople(s, setups[i]!, employees, taken, resolve, shifts, defaults, typeOf) : null));
    const newPeople = people.flatMap((r) => r?.ok ?? []);
    const pool = [...employees, ...newPeople.filter((p) => !employees.some((e) => e.employee_code.toLowerCase() === p.employee_code.toLowerCase()))];
    const records = sheets.map((s, i) => (setups[i]?.role === "records" ? parseRecords(s, setups[i]!, pool) : null));
    return { people, newPeople, records };
  }, [sheets, setups, employees, newCategories, shifts, defaults, typeOf]);

  const allRecords = useMemo(() => preview.records.flatMap((r) => r?.ok ?? []), [preview]);
  const range = allRecords.length
    ? allRecords.reduce((a, r) => ({ from: r.work_date < a.from ? r.work_date : a.from, to: r.work_date > a.to ? r.work_date : a.to }), { from: "9999-12-31", to: "0000-01-01" })
    : null;
  const existingKeys = useQuery({
    queryKey: ["import-record-keys", mode, range?.from, range?.to],
    enabled: !!range,
    queryFn: () => storeFor(mode).listRecordKeys(range!.from, range!.to),
  });
  const duplicates = useMemo(() => findDuplicates(allRecords, existingKeys.data ?? []), [allRecords, existingKeys.data]);

  const addedPeople = preview.newPeople.filter((p) => !employees.some((e) => e.employee_code.toLowerCase() === p.employee_code.toLowerCase())).length;
  const recordsToSave = allRecords.length - (skipDuplicates ? duplicates.size : 0);
  const problems = [...preview.people, ...preview.records].flatMap((r) => r?.errs ?? []);
  const total = preview.newPeople.length + recordsToSave;

  const commit = async () => {
    setBusy(true);
    try {
      // 1. Back up what the import is about to change.
      setStep({ done: 0, label: "Backing up first" });
      await backupBefore("import");
      setStep({ done: 1, label: "Adding categories" });

      // 2. Categories the user asked to create from columns.
      const created = new Map<Target, string>();
      if (newCategories.size) {
        const rows = [...newCategories].map(([t, label], i) => {
          const id = crypto.randomUUID();
          created.set(t, id);
          return { id, label: label.slice(0, 60), field_type: "text", sort_order: defs.length + i };
        });
        const { error } = await db().insert("employee_field_defs", rows);
        if (error) throw error;
      }

      // 3. People, then re-read employees so new people's hours can link to them.
      setStep({ done: 2, label: "Adding people" });
      const taken = new Set(employees.map((e) => e.employee_code.toLowerCase()));
      const resolve = (t: Target) => (t.startsWith("custom:") ? t.slice(7) : created.get(t));
      const people: PersonRow[] = sheets.flatMap((s, i) => (setups[i]!.role === "people" ? parsePeople(s, setups[i]!, employees, taken, resolve, shifts, defaults, typeOf).ok : []));
      let fresh: Employee[] = employees;
      if (people.length) {
        const { error } = await db().upsertEmployeesByCode(people as never);
        if (error) throw error;
        fresh = await db().listEmployees();
      }

      // 4. Hours, minus shifts already in the app.
      setStep({ done: 3, label: "Adding time records" });
      let recs: RecordRow[] = sheets.flatMap((s, i) => (setups[i]!.role === "records" ? parseRecords(s, setups[i]!, fresh).ok : []));
      let skipped = 0;
      if (skipDuplicates && recs.length) {
        const from = recs.reduce((a, r) => (r.work_date < a ? r.work_date : a), recs[0]!.work_date);
        const to = recs.reduce((a, r) => (r.work_date > a ? r.work_date : a), recs[0]!.work_date);
        const dup = findDuplicates(recs, await db().listRecordKeys(from, to));
        skipped = dup.size;
        recs = recs.filter((_, i) => !dup.has(i));
      }
      if (recs.length) {
        const { error } = await db().insert("time_records", recs.map(({ _code, _line, ...r }) => r) as never);
        if (error) throw error;
      }

      sheets.forEach((s, i) => { if (setups[i]!.role !== "ignore") remember(s, setups[i]!, created); });
      toast.success(`Imported ${people.length} people and ${recs.length} time records${skipped ? ` (${skipped} already in the app were skipped)` : ""}`);
      setSheets([]); setSetups([]); setFile("");
      qc.invalidateQueries();
    } catch (e) {
      toast.error(`Import stopped: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  // Skipped sheets have no tab; if the open one was just skipped, show the first remaining one.
  const current = shownSheets.includes(active) ? active : shownSheets[0];
  const sheet = current === undefined ? undefined : sheets[current];
  const setup = current === undefined ? undefined : setups[current];

  return (
    <AppShell eyebrow="Import" title="Import from CSV or Excel">
      <div className="glass-panel space-y-4 p-6">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            Choose a file, then for each sheet pick which rows to import and which app field each column goes into. Nothing is saved until you press Import.
          </p>
          <button onClick={template} className={btnGhost}>Download template</button>
        </div>
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) handle(f); }}
          className={`cursor-pointer rounded-xl border-2 border-dashed p-10 text-center transition-colors ${drag ? "border-primary bg-accent" : "border-primary/30 bg-accent/50"}`}
        >
          <div className="font-mono text-sm text-accent-foreground">{file ? `${file} · choose another file` : "Drop CSV / XLSX"}</div>
          <div className="mt-1 text-xs text-muted-foreground">or click to browse · up to {MAX_ROWS.toLocaleString()} rows per sheet</div>
          <input ref={inputRef} type="file" accept=".csv,.xlsx,.xls,.xlsm,.ods" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handle(f); e.target.value = ""; }} />
        </div>
      </div>

      {sheets.length > 0 && (
        <>
          <div className="flex flex-wrap items-stretch gap-2">
            {shownSheets.map((i) => {
              const s = sheets[i]!, role = setups[i]!.role;
              const n = role === "people" ? preview.people[i]?.ok.length ?? 0 : preview.records[i]?.ok.length ?? 0;
              return (
                <div key={s.name} className={`relative rounded-xl ring-1 ${i === current ? "bg-accent ring-primary/30" : "bg-secondary ring-border"}`}>
                  <button onClick={() => setActive(i)} className="py-2 pl-3 pr-8 text-left text-sm">
                    <div className="font-medium">{s.name}</div>
                    <div className="text-[11px] text-muted-foreground">{role === "people" ? "People" : "Hours"} · {n} rows</div>
                  </button>
                  <button onClick={() => skipSheet(i)} aria-label={`Skip sheet ${s.name}`} title="Skip this sheet (bring it back with +)"
                    className="absolute right-1.5 top-1.5 rounded-md p-0.5 text-muted-foreground hover:bg-background hover:text-destructive">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
            {sheets.length > 1 && (
              <Popover>
                <PopoverTrigger asChild>
                  <button className="rounded-xl border border-dashed border-border px-3 text-sm text-muted-foreground hover:text-foreground" aria-label="Sheets in this file" title="Bring back a skipped sheet">
                    <Plus className="inline h-4 w-4" />{shownSheets.length < sheets.length && <span className="ml-1 text-xs">{sheets.length - shownSheets.length} skipped</span>}
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-64 p-1">
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">Sheets in {file}</div>
                  {sheets.map((s, i) => {
                    const skipped = setups[i]!.role === "ignore";
                    return (
                      <button key={s.name} onClick={() => (skipped ? restoreSheet(i) : setActive(i))}
                        className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-secondary">
                        <span className={`truncate ${skipped ? "text-muted-foreground" : ""}`}>{s.name}</span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {skipped ? <><Plus className="mr-0.5 inline h-3 w-3" />{s.grid.length ? "add back" : "empty"}</> : <Check className="inline h-3.5 w-3.5" />}
                        </span>
                      </button>
                    );
                  })}
                </PopoverContent>
              </Popover>
            )}
          </div>

          {(!sheet || !setup || current === undefined) && (
            <div className="glass-panel p-6 text-sm text-muted-foreground">Every sheet is skipped. Press + to bring one back.</div>
          )}
          {sheet && setup && current !== undefined && <SheetEditor
            key={current} sheet={sheet} setup={setup} defs={defs} employees={employees}
            onChange={(p) => update(current, p)}
            result={setup.role === "people" ? { count: preview.people[current]?.ok.length ?? 0, errs: preview.people[current]?.errs.length ?? 0, blank: 0 }
              : setup.role === "records" ? { count: preview.records[current]?.ok.length ?? 0, errs: preview.records[current]?.errs.length ?? 0, blank: preview.records[current]?.blankDays ?? 0 } : null}
          />}

          <div className="glass-panel space-y-3 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm">
                <div className="font-medium">
                  {preview.newPeople.length} people ({addedPeople} new, {preview.newPeople.length - addedPeople} updated) · {recordsToSave} time records
                </div>
                <div className="text-xs text-muted-foreground">
                  Into {mode === "cloud" ? "your cloud account" : "this device"}{newCategories.size ? ` · ${newCategories.size} new categor${newCategories.size === 1 ? "y" : "ies"}` : ""}
                  {problems.length ? ` · ${problems.length} rows won't be imported` : ""} · a backup is saved first
                </div>
              </div>
              <div className="flex items-center gap-3">
                {allRecords.length > 0 && (
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input type="checkbox" checked={skipDuplicates} onChange={(e) => setSkipDuplicates(e.target.checked)} />
                    Skip {duplicates.size} shift{duplicates.size === 1 ? "" : "s"} already in the app
                  </label>
                )}
                <button disabled={!total || busy} onClick={() => undoable("imported a file", commit)} className={btnPrimary}>{busy ? "Importing…" : `Import ${total} rows`}</button>
              </div>
            </div>
            {step && <TaskProgress done={step.done} total={IMPORT_STEPS} label={`${step.label}…`} />}
            {problems.length > 0 && (
              <ul className="max-h-48 space-y-1 overflow-auto rounded-xl bg-secondary p-3 font-mono text-[11px] text-destructive">
                {problems.slice(0, 200).map((e, i) => <li key={i}>{e}</li>)}
                {problems.length > 200 && <li>…and {problems.length - 200} more</li>}
              </ul>
            )}
          </div>
        </>
      )}
    </AppShell>
  );
}

/** Indexes of records that match a shift already saved, or an earlier row in the same import. */
function findDuplicates(records: RecordRow[], existing: { employee_id: string; work_date: string; entry_mode: string; clock_in: string | null; clock_out: string | null; hours: number }[]) {
  const seen = new Set(existing.map(recordKey));
  const dup = new Set<number>();
  records.forEach((r, i) => {
    if (!r.employee_id) return;
    const k = recordKey(r);
    if (seen.has(k)) dup.add(i); else seen.add(k);
  });
  return dup;
}

// ---------------------------------------------------------------- one sheet

/**
 * A row number box that can be cleared and retyped freely. What's typed is
 * applied on Enter or when leaving the box; an empty or out-of-range number
 * shows an error and goes back to the last good value.
 */
function RowNumberInput({ value, min, max, what, onCommit, className, disabled }: {
  value: number | null; min: number; max: number; what: string; onCommit: (n: number) => void; className?: string; disabled?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const n = Number(draft);
  const problem = draft === null ? null
    : draft.trim() === "" ? `${what} needs a number`
    : !Number.isInteger(n) || n < min || n > max ? `${what} must be a whole number from ${min} to ${max}`
    : null;
  const finish = () => {
    if (draft === null) return;
    if (problem) toast.error(problem); else if (n !== value) onCommit(n);
    setDraft(null);
  };
  return (
    <input type="number" inputMode="numeric" className={`${inputCls} ${className ?? ""} ${problem ? "ring-2 ring-destructive" : ""}`} disabled={disabled}
      value={draft ?? (value ?? "")} min={min} max={max} title={problem ?? `${min}–${max}`} aria-invalid={!!problem}
      onChange={(e) => setDraft(e.target.value)} onBlur={finish}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); finish(); } else if (e.key === "Escape") setDraft(null); }} />
  );
}

function SheetEditor({ sheet, setup, defs, employees, onChange, result }: {
  sheet: Sheet; setup: SheetSetup; defs: FieldDef[]; employees: Employee[];
  onChange: (p: Partial<SheetSetup>) => void;
  result: { count: number; errs: number; blank: number } | null;
}) {
  const [clickSets, setClickSets] = useState<ClickSets>("first");
  const rows = sheet.grid.length;
  const toRowNo = (i: number) => rowNumber(sheet, i);
  const fromRowNo = (n: number) => Math.min(Math.max(n - sheet.rowOffset - 1, 0), Math.max(rows - 1, 0));

  const setRole = (role: Role) => onChange({ role, columns: guessColumns(sheet, setup.headerRow, role, defs) });
  const setHeader = (headerRow: number | null) => {
    const first = headerRow === null ? setup.firstRow : Math.max(setup.firstRow, headerRow + 1);
    onChange({ headerRow, firstRow: first, lastRow: Math.max(setup.lastRow, first), columns: guessColumns(sheet, headerRow, setup.role, defs) });
  };
  const clickRow = (i: number) => {
    if (clickSets === "header") setHeader(i);
    else if (clickSets === "first") onChange({ firstRow: i, lastRow: Math.max(setup.lastRow, i) });
    else onChange({ lastRow: i, firstRow: Math.min(setup.firstRow, i) });
  };
  const setColumn = (j: number, t: Target) => onChange({ columns: setup.columns.map((c, k) => (k === j ? t : c)) });

  const headerText = (j: number) => (setup.headerRow === null ? "" : sheet.grid[setup.headerRow]?.[j]?.text ?? "");
  const fields = fieldsFor(setup.role);
  const shown = rows > PREVIEW_HEAD + PREVIEW_TAIL
    ? [...Array.from({ length: PREVIEW_HEAD }, (_, i) => i), -1, ...Array.from({ length: PREVIEW_TAIL }, (_, i) => rows - PREVIEW_TAIL + i)]
    : Array.from({ length: rows }, (_, i) => i);
  const inRange = (i: number) => i >= setup.firstRow && i <= setup.lastRow && i !== setup.headerRow;
  const hasEmployeeColumn = ["code", "name", "first", "email"].some((k) => setup.columns.includes(k));

  if (!rows) return <div className="glass-panel p-6 text-sm text-muted-foreground">This sheet is empty.</div>;

  return (
    <div className="glass-panel space-y-4 p-5">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <div className="label-mono mb-1">This sheet has</div>
          <div className="flex rounded-xl bg-secondary p-1 text-xs font-medium ring-1 ring-border">
            {(["people", "records", "ignore"] as const).map((r) => (
              <button key={r} onClick={() => setRole(r)}
                className={`rounded-lg px-3 py-1.5 ${setup.role === r ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                {r === "people" ? "Employees" : r === "records" ? "Hours / timesheet" : "Skip sheet"}
              </button>
            ))}
          </div>
        </div>
        {setup.role !== "ignore" && (
          <>
            <label>
              <div className="label-mono mb-1">Header row</div>
              <div className="flex items-center gap-2">
                <RowNumberInput className="w-20" disabled={setup.headerRow === null} what="The header row"
                  value={setup.headerRow === null ? null : toRowNo(setup.headerRow)} min={toRowNo(0)} max={toRowNo(rows - 1)}
                  onCommit={(n) => setHeader(fromRowNo(n))} />
                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  <input type="checkbox" checked={setup.headerRow === null} onChange={(e) => setHeader(e.target.checked ? null : Math.max(setup.firstRow - 1, 0))} /> none
                </label>
              </div>
            </label>
            <div>
              <div className="label-mono mb-1">Import rows</div>
              <div className="flex items-center gap-2 text-sm">
                <RowNumberInput className="w-24" value={toRowNo(setup.firstRow)} min={toRowNo(0)} max={toRowNo(rows - 1)} what="The first row"
                  onCommit={(n) => { const i = fromRowNo(n); onChange({ firstRow: i, lastRow: Math.max(setup.lastRow, i) }); }} />
                to
                <RowNumberInput className="w-24" value={toRowNo(setup.lastRow)} min={toRowNo(0)} max={toRowNo(rows - 1)} what="The last row"
                  onCommit={(n) => { const i = fromRowNo(n); onChange({ lastRow: i, firstRow: Math.min(setup.firstRow, i) }); }} />
              </div>
            </div>
            <label>
              <div className="label-mono mb-1">Dates are written</div>
              <select className={`${inputCls} w-auto`} value={setup.dateOrder} onChange={(e) => onChange({ dateOrder: e.target.value as DateOrder })}>
                <option value="mdy">Month/Day/Year (10/25/2026)</option>
                <option value="dmy">Day/Month/Year (25/10/2026)</option>
                <option value="ymd">Year-Month-Day only</option>
              </select>
            </label>
            {setup.role === "records" && (
              <label>
                <div className="label-mono mb-1">{hasEmployeeColumn ? "Rows with no employee belong to" : "Whose hours are these?"}</div>
                <EmployeePicker employees={employees} hideResigned value={setup.sheetEmployeeId} onChange={(id) => onChange({ sheetEmployeeId: id })}
                  emptyLabel={hasEmployeeColumn ? "— nobody (skip them) —" : "— pick an employee —"} className="w-64"
                  invalid={!hasEmployeeColumn && !setup.sheetEmployeeId} />
              </label>
            )}
          </>
        )}
      </div>

      {setup.role !== "ignore" && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              Clicking a row number sets the
              <div className="flex rounded-lg bg-secondary p-0.5 ring-1 ring-border">
                {(["header", "first", "last"] as const).map((k) => (
                  <button key={k} onClick={() => setClickSets(k)}
                    className={`rounded-md px-2 py-1 ${clickSets === k ? "bg-primary text-primary-foreground" : "hover:text-foreground"}`}>
                    {k === "header" ? "header row" : k === "first" ? "first row" : "last row"}
                  </button>
                ))}
              </div>
            </div>
            {result && (
              <div>
                <span className="font-medium text-foreground">{result.count} {setup.role === "people" ? "employees" : "time records"}</span>
                {result.errs > 0 && <span className="text-destructive"> · {result.errs} problems</span>}
                {result.blank > 0 && <span> · {result.blank} days with no hours skipped</span>}
              </div>
            )}
          </div>

          <div className="max-h-[32rem] overflow-auto rounded-xl ring-1 ring-border">
            <DataTable id="import-preview" className="text-[12px]">
              <thead className="sticky top-0 z-10 bg-background">
                <tr className="border-b border-border">
                  <th className="sticky left-0 z-20 bg-background px-2 py-1" />
                  {Array.from({ length: sheet.width }, (_, j) => (
                    <th key={j} data-col={columnLetter(sheet, j)} className="min-w-[9rem] px-1.5 py-1.5 text-left align-bottom font-normal">
                      <div className="font-mono text-[10px] text-muted-foreground">{columnLetter(sheet, j)}{headerText(j) ? ` · ${headerText(j)}` : ""}</div>
                      <select value={setup.columns[j] ?? ""} onChange={(e) => setColumn(j, e.target.value)}
                        className={`mt-1 w-full rounded-lg px-1.5 py-1 text-[12px] ring-1 ${setup.columns[j] ? "bg-primary/10 font-medium text-primary ring-primary/30" : "bg-secondary text-muted-foreground ring-border"}`}>
                        <option value="">Don't import</option>
                        <optgroup label="App fields">
                          {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                        </optgroup>
                        {setup.role === "people" && (
                          <optgroup label="Employee categories">
                            {defs.map((d) => <option key={d.id} value={`custom:${d.id}`}>{d.label}</option>)}
                            <option value={`new:${headerText(j) || `Column ${columnLetter(sheet, j)}`}`}>+ New category “{headerText(j) || `Column ${columnLetter(sheet, j)}`}”</option>
                          </optgroup>
                        )}
                      </select>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((i) => i === -1 ? (
                  <tr key="gap"><td colSpan={sheet.width + 1} className="px-3 py-1 text-center text-muted-foreground">… rows {toRowNo(PREVIEW_HEAD)}–{toRowNo(rows - PREVIEW_TAIL - 1)} not shown …</td></tr>
                ) : (
                  <tr key={i} className={`border-b border-border/50 ${i === setup.headerRow ? "bg-accent font-semibold" : inRange(i) ? "" : "opacity-35"}`}>
                    <td className="sticky left-0 bg-background px-0 py-0">
                      <button onClick={() => clickRow(i)} title={`Set as ${clickSets === "header" ? "header row" : clickSets === "first" ? "first row" : "last row"}`}
                        className={`w-full px-2 py-1 text-right font-mono text-[10px] hover:bg-primary/15 ${inRange(i) ? "text-primary" : "text-muted-foreground"}`}>
                        {toRowNo(i)}
                      </button>
                    </td>
                    {Array.from({ length: sheet.width }, (_, j) => (
                      <td key={j} className={`max-w-[14rem] truncate px-2 py-1 ${setup.columns[j] && inRange(i) ? "" : "text-muted-foreground"}`} title={sheet.grid[i]?.[j]?.text}>
                        {sheet.grid[i]?.[j]?.text}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
        </>
      )}
    </div>
  );
}
