import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Search, X, ChevronRight, ChevronLeft, Users, UserCheck } from "lucide-react";
import { localDb } from "@/lib/local-db";
import { AppShell, btnPrimary, inputCls } from "@/components/AppShell";
import { RecordsTable } from "@/components/RecordsTable";
import { computeHours, fullName, isoDate, useEmployees, useRecords, type Employee } from "@/lib/payroll";

export const Route = createFileRoute("/_authenticated/records")({
  head: () => ({ meta: [{ title: "Time records — Meridian Payroll" }] }),
  component: RecordsPage,
});

function matchesEmp(e: Employee, q: string): boolean {
  if (!q) return true;
  const t = q.toLowerCase().trim();
  return (
    `${e.first_name} ${e.last_name}`.toLowerCase().includes(t) ||
    e.employee_code.toLowerCase().includes(t) ||
    (e.email ?? "").toLowerCase().includes(t) ||
    (e.department ?? "").toLowerCase().includes(t) ||
    (e.job_title ?? "").toLowerCase().includes(t)
  );
}

function EmpChip({ e, onToggle, selected }: { e: Employee; onToggle: () => void; selected: boolean }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ring-1 transition-all ${
        selected
          ? "bg-primary/10 text-foreground ring-primary/30 hover:bg-primary/20"
          : "bg-secondary text-muted-foreground ring-border hover:text-foreground hover:ring-primary/20"
      }`}
    >
      <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary/15 font-mono text-[10px] font-bold text-primary">
        {e.first_name[0]}{e.last_name[0]}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{fullName(e)}</div>
        <div className="truncate font-mono text-[10px] text-muted-foreground">
          {e.employee_code}{e.job_title ? ` · ${e.job_title}` : ""}{e.department ? ` · ${e.department}` : ""}
        </div>
      </div>
      {selected
        ? <ChevronLeft className="h-4 w-4 shrink-0 text-muted-foreground" />
        : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
    </button>
  );
}

function RecordsPage() {
  const qc = useQueryClient();
  const { data: employees = [] } = useEmployees();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const { data: records = [] } = useRecords(from || undefined, to || undefined);

  const [mode, setMode] = useState<"clock" | "hours">("clock");
  const [f, setF] = useState({ work_date: isoDate(new Date()), clock_in: "09:00", clock_out: "17:00", lunch_minutes: "30", hours: "8" });
  const [picked, setPicked] = useState<string[]>([]);
  const [empSearch, setEmpSearch] = useState("");

  const activeEmployees = useMemo(() => employees.filter((e) => e.active), [employees]);
  const available = useMemo(
    () => activeEmployees.filter((e) => !picked.includes(e.id) && matchesEmp(e, empSearch)),
    [activeEmployees, picked, empSearch],
  );
  const selectedEmps = useMemo(
    () => activeEmployees.filter((e) => picked.includes(e.id) && matchesEmp(e, empSearch)),
    [activeEmployees, picked, empSearch],
  );

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const preview = mode === "clock" ? computeHours(f.clock_in, f.clock_out, Number(f.lunch_minutes) || 0) : Number(f.hours) || 0;

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (picked.length === 0) { toast.error("Pick at least one employee"); return; }
    const lunch = Number(f.lunch_minutes);
    const hours = Number(f.hours);
    if (mode === "clock" && (!Number.isFinite(lunch) || lunch < 0 || lunch > 600)) { toast.error("Lunch minutes must be 0–600"); return; }
    if (mode === "hours" && (!Number.isFinite(hours) || hours < 0 || hours > 24)) { toast.error("Hours must be 0–24"); return; }
    const rows = picked.map((employee_id) =>
      mode === "clock"
        ? { employee_id, work_date: f.work_date, entry_mode: "clock" as const, clock_in: f.clock_in, clock_out: f.clock_out, lunch_minutes: lunch }
        : { employee_id, work_date: f.work_date, entry_mode: "hours" as const, hours });
    try { await localDb.insertRecords(rows); } catch (err) { toast.error((err as Error).message); return; }
    toast.success(rows.length === 1 ? "Record added" : `${rows.length} records added`);
    setPicked([]);
    qc.invalidateQueries({ queryKey: ["records"] });
  };

  const del = async (id: string) => {
    await localDb.deleteRecord(id);
    qc.invalidateQueries({ queryKey: ["records"] });
  };

  const delMany = async (ids: string[]) => {
    for (const id of ids) await localDb.deleteRecord(id);
    qc.invalidateQueries({ queryKey: ["records"] });
    toast.success(`Deleted ${ids.length} record${ids.length > 1 ? "s" : ""}`);
  };

  return (
    <AppShell eyebrow="Ledger" title="Time records">
      {/* New record form */}
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

        {/* Employee picker — two-panel with search */}
        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="label-mono">Select employees</span>
            <div className="flex items-center gap-3 text-xs">
              <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setPicked(activeEmployees.map((e) => e.id))}>Add all</button>
              <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setPicked([])}>Clear all</button>
            </div>
          </div>

          {/* Search bar */}
          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search by name, ID, department, position…"
              className={`${inputCls} pl-9`}
              value={empSearch}
              onChange={(e) => setEmpSearch(e.target.value)}
            />
            {empSearch && (
              <button type="button" onClick={() => setEmpSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Two-panel layout */}
          <div className="grid gap-3 sm:grid-cols-2">
            {/* Available */}
            <div className="rounded-xl border border-border bg-secondary/30 p-3">
              <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                <Users className="h-3.5 w-3.5" />
                <span className="font-medium">Available · {available.length}</span>
              </div>
              <div className="flex max-h-48 flex-col gap-1.5 overflow-y-auto pr-1">
                {available.length === 0 && (
                  <div className="py-6 text-center text-xs text-muted-foreground">
                    {empSearch ? "No matches" : "All employees selected"}
                  </div>
                )}
                {available.map((e) => (
                  <EmpChip key={e.id} e={e} onToggle={() => toggle(e.id)} selected={false} />
                ))}
              </div>
            </div>

            {/* Selected */}
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <UserCheck className="h-3.5 w-3.5 text-primary" />
                  <span className="font-medium">Selected · {selectedEmps.length}</span>
                </div>
                {selectedEmps.length > 0 && (
                  <button type="button" onClick={() => setPicked([])} className="text-[11px] text-muted-foreground hover:text-foreground">Clear</button>
                )}
              </div>
              <div className="flex max-h-48 flex-col gap-1.5 overflow-y-auto pr-1">
                {selectedEmps.length === 0 && (
                  <div className="py-6 text-center text-xs text-muted-foreground">
                    Click employees to add them
                  </div>
                )}
                {selectedEmps.map((e) => (
                  <EmpChip key={e.id} e={e} onToggle={() => toggle(e.id)} selected={true} />
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Date / hours inputs */}
        <div className="grid items-end gap-3 md:grid-cols-6">
          <label><span className="label-mono">Date</span><input type="date" className={`${inputCls} mt-1`} value={f.work_date} onChange={(e) => setF({ ...f, work_date: e.target.value })} required /></label>
          {mode === "clock" ? (
            <>
              <label><span className="label-mono">Clock in</span><input type="time" className={`${inputCls} mt-1`} value={f.clock_in} onChange={(e) => setF({ ...f, clock_in: e.target.value })} required /></label>
              <label><span className="label-mono">Clock out</span><input type="time" className={`${inputCls} mt-1`} value={f.clock_out} onChange={(e) => setF({ ...f, clock_out: e.target.value })} required /></label>
              <label><span className="label-mono">Lunch (min)</span><input type="number" min={0} className={`${inputCls} mt-1`} value={f.lunch_minutes} onChange={(e) => setF({ ...f, lunch_minutes: e.target.value })} /></label>
            </>
          ) : (
            <label className="md:col-span-3"><span className="label-mono">Hours worked</span><input type="number" step="0.25" min={0} max={24} className={`${inputCls} mt-1`} value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} /></label>
          )}
          <div>
            <div className="mb-1 text-right font-mono text-[11px] text-muted-foreground">{preview.toFixed(2)} h per person</div>
            <button className={`${btnPrimary} w-full`}>Add to {selectedEmps.length || "—"}</button>
          </div>
        </div>
      </form>

      {/* Filters for the records table */}
      <div className="glass-panel space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="label-mono">Date range</span>
          <input type="date" className={`${inputCls} max-w-[11rem]`} value={from} onChange={(e) => setFrom(e.target.value)} />
          <span className="text-muted-foreground">→</span>
          <input type="date" className={`${inputCls} max-w-[11rem]`} value={to} onChange={(e) => setTo(e.target.value)} />
          {(from || to) && (
            <button onClick={() => { setFrom(""); setTo(""); }} className="text-xs text-muted-foreground hover:text-foreground">Clear dates</button>
          )}
        </div>
      </div>

      <RecordsTable records={records} employees={employees} title={`${records.length} records`} onDelete={del} onDeleteMany={delMany} />
    </AppShell>
  );
}
