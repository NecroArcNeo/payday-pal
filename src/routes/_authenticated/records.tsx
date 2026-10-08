import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { TablesInsert } from "@/integrations/supabase/types";
import { AppShell, btnPrimary, inputCls } from "@/components/AppShell";
import { RecordsTable } from "@/components/RecordsTable";
import { computeHours, fullName, isoDate, useEmployees, useRecords } from "@/lib/payroll";

export const Route = createFileRoute("/_authenticated/records")({
  head: () => ({ meta: [{ title: "Time records — Meridian Payroll" }] }),
  component: RecordsPage,
});

function RecordsPage() {
  const qc = useQueryClient();
  const { data: employees = [] } = useEmployees();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const { data: records = [] } = useRecords(from || undefined, to || undefined);

  const [mode, setMode] = useState<"clock" | "hours">("clock");
  const [f, setF] = useState({ employee_id: "", work_date: isoDate(new Date()), clock_in: "09:00", clock_out: "17:00", lunch_minutes: "30", hours: "8" });

  const preview = mode === "clock" ? computeHours(f.clock_in, f.clock_out, Number(f.lunch_minutes) || 0) : Number(f.hours) || 0;

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.employee_id) { toast.error("Pick an employee"); return; }
    const lunch = Number(f.lunch_minutes);
    const hours = Number(f.hours);
    if (mode === "clock" && (!Number.isFinite(lunch) || lunch < 0 || lunch > 600)) { toast.error("Lunch minutes must be 0–600"); return; }
    if (mode === "hours" && (!Number.isFinite(hours) || hours < 0 || hours > 24)) { toast.error("Hours must be 0–24"); return; }
    const row: TablesInsert<"time_records"> =
      mode === "clock"
        ? { employee_id: f.employee_id, work_date: f.work_date, entry_mode: "clock", clock_in: f.clock_in, clock_out: f.clock_out, lunch_minutes: lunch }
        : { employee_id: f.employee_id, work_date: f.work_date, entry_mode: "hours", hours };
    const { error } = await supabase.from("time_records").insert(row);
    if (error) { toast.error(error.message); return; }
    toast.success("Record added");
    qc.invalidateQueries({ queryKey: ["records"] });
  };

  const del = async (id: string) => {
    const { error } = await supabase.from("time_records").delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    qc.invalidateQueries({ queryKey: ["records"] });
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
        <div className="grid items-end gap-3 md:grid-cols-7">
          <label className="md:col-span-2"><span className="label-mono">Employee</span>
            <select className={`${inputCls} mt-1`} value={f.employee_id} onChange={(e) => setF({ ...f, employee_id: e.target.value })}>
              <option value="">Select…</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{fullName(e)} · {e.employee_code}</option>)}
            </select>
          </label>
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
            <div className="mb-1 text-right font-mono text-[11px] text-muted-foreground">{preview.toFixed(2)} h</div>
            <button className={`${btnPrimary} w-full`}>Add</button>
          </div>
        </div>
      </form>

      <div className="flex items-center gap-3">
        <span className="label-mono">Filter</span>
        <input type="date" className={`${inputCls} max-w-[11rem]`} value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="text-muted-foreground">→</span>
        <input type="date" className={`${inputCls} max-w-[11rem]`} value={to} onChange={(e) => setTo(e.target.value)} />
      </div>

      <RecordsTable records={records} title={`${records.length} records`} onDelete={del} />
    </AppShell>
  );
}
