import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { supabase } from "@/integrations/supabase/client";
import { AppShell, btnGhost, btnPrimary } from "@/components/AppShell";
import { useEmployees } from "@/lib/payroll";

export const Route = createFileRoute("/_authenticated/import")({
  head: () => ({ meta: [{ title: "Import — Meridian Payroll" }] }),
  component: ImportPage,
});

type Kind = "records" | "employees";
type Row = Record<string, string>;

const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
const pick = (r: Row, ...keys: string[]) => {
  for (const k of keys) if (r[k] != null && String(r[k]).trim() !== "") return String(r[k]).trim();
  return "";
};

function parseTime(v: string): string | null {
  if (!v) return null;
  const m = v.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = m[3]?.toLowerCase();
  if (ap?.startsWith("p") && h < 12) h += 12;
  if (ap?.startsWith("a") && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function parseDate(v: string): string | null {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

const templates: Record<Kind, string> = {
  records: "employee_id,date,clock_in,clock_out,lunch_minutes,hours\nE100,2026-10-05,09:00,17:30,30,\nE101,2026-10-05,,,,7.5\n",
  employees: "employee_id,first_name,last_name,email,department,hourly_rate\nE100,Nadia,Okafor,nadia@example.com,Warehouse,28\n",
};

function ImportPage() {
  const qc = useQueryClient();
  const { data: employees = [] } = useEmployees();
  const [kind, setKind] = useState<Kind>("records");
  const [file, setFile] = useState<string>("");
  const [valid, setValid] = useState<Record<string, unknown>[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handle = async (f: File) => {
    if (f.size > 10 * 1024 * 1024) return toast.error("File must be under 10MB");
    setFile(f.name);
    const wb = XLSX.read(await f.arrayBuffer(), { cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { raw: false, defval: "", dateNF: "yyyy-mm-dd" });
    const rows: Row[] = raw.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [norm(k), String(v ?? "")])));
    const ok: Record<string, unknown>[] = [];
    const errs: string[] = [];
    const byCode = new Map(employees.map((e) => [e.employee_code.toLowerCase(), e.id]));
    const byEmail = new Map(employees.filter((e) => e.email).map((e) => [e.email!.toLowerCase(), e.id]));

    rows.slice(0, 5000).forEach((r, i) => {
      const line = i + 2;
      if (kind === "employees") {
        const code = pick(r, "employeeid", "employeecode", "id", "code");
        const first = pick(r, "firstname", "first");
        const last = pick(r, "lastname", "last", "surname");
        const rate = Number(pick(r, "hourlyrate", "rate", "payrate", "wage").replace(/[$,]/g, "") || 0);
        const email = pick(r, "email", "emailaddress");
        if (!code || !first || !last) return errs.push(`Row ${line}: needs employee_id, first_name, last_name`);
        if (!Number.isFinite(rate) || rate < 0) return errs.push(`Row ${line}: invalid hourly rate`);
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return errs.push(`Row ${line}: invalid email`);
        ok.push({ employee_code: code.slice(0, 40), first_name: first.slice(0, 80), last_name: last.slice(0, 80), email: email || null, department: pick(r, "department", "dept").slice(0, 80) || null, hourly_rate: rate });
      } else {
        const code = pick(r, "employeeid", "employeecode", "id", "code").toLowerCase();
        const email = pick(r, "email").toLowerCase();
        const empId = byCode.get(code) ?? byEmail.get(email);
        if (!empId) return errs.push(`Row ${line}: unknown employee "${code || email}"`);
        const date = parseDate(pick(r, "date", "workdate", "day"));
        if (!date) return errs.push(`Row ${line}: invalid date`);
        const cin = parseTime(pick(r, "clockin", "timein", "in", "start"));
        const cout = parseTime(pick(r, "clockout", "timeout", "out", "end"));
        if (cin && cout) {
          const lunch = Number(pick(r, "lunchminutes", "lunch", "break", "breakminutes") || 0);
          if (!Number.isFinite(lunch) || lunch < 0 || lunch > 600) return errs.push(`Row ${line}: invalid lunch minutes`);
          ok.push({ employee_id: empId, work_date: date, entry_mode: "clock", clock_in: cin, clock_out: cout, lunch_minutes: lunch });
        } else {
          const hours = Number(pick(r, "hours", "totalhours", "hoursworked"));
          if (!Number.isFinite(hours) || hours <= 0 || hours > 24) return errs.push(`Row ${line}: needs clock in/out or hours (0–24)`);
          ok.push({ employee_id: empId, work_date: date, entry_mode: "hours", hours });
        }
      }
    });
    setValid(ok);
    setErrors(errs);
  };

  const commit = async () => {
    setBusy(true);
    const { error } =
      kind === "employees"
        ? await supabase.from("employees").upsert(valid as never, { onConflict: "employee_code" })
        : await supabase.from("time_records").insert(valid as never);
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success(`Imported ${valid.length} rows`);
    setValid([]); setErrors([]); setFile("");
    qc.invalidateQueries();
  };

  const download = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([templates[kind]], { type: "text/csv" }));
    a.download = `${kind}_template.csv`;
    a.click();
  };

  return (
    <AppShell eyebrow="Import" title="Import from CSV or Excel">
      <div className="glass-panel space-y-4 p-6">
        <div className="flex items-center justify-between">
          <div className="flex rounded-xl bg-secondary p-1 text-xs font-medium ring-1 ring-border">
            {(["records", "employees"] as const).map((k) => (
              <button key={k} onClick={() => { setKind(k); setValid([]); setErrors([]); setFile(""); }} className={`rounded-lg px-3 py-1.5 ${kind === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                {k === "records" ? "Time records" : "Employees"}
              </button>
            ))}
          </div>
          <button onClick={download} className={btnGhost}>Download template</button>
        </div>
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) handle(f); }}
          className={`cursor-pointer rounded-xl border-2 border-dashed p-12 text-center transition-colors ${drag ? "border-primary bg-accent" : "border-primary/30 bg-accent/50"}`}
        >
          <div className="font-mono text-sm text-accent-foreground">Drop CSV / XLSX</div>
          <div className="mt-1 text-xs text-muted-foreground">or click to browse · up to 5,000 rows</div>
          <input ref={inputRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handle(f); e.target.value = ""; }} />
        </div>
        <p className="text-xs text-muted-foreground">
          {kind === "records"
            ? "Columns: employee_id (or email), date, and either clock_in + clock_out + lunch_minutes, or hours. Rows with both clock times are saved as clock in/out; otherwise as daily hours."
            : "Columns: employee_id, first_name, last_name, email, department, hourly_rate. Existing IDs are updated."}
        </p>
      </div>

      {file && (
        <div className="glass-panel space-y-3 p-6">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-mono text-[12px]">{file}</div>
              <div className="text-xs text-muted-foreground">{valid.length} rows ready · {errors.length} with problems</div>
            </div>
            <button disabled={!valid.length || busy} onClick={commit} className={btnPrimary}>{busy ? "Importing…" : `Import ${valid.length} rows`}</button>
          </div>
          {errors.length > 0 && (
            <ul className="max-h-48 space-y-1 overflow-auto rounded-xl bg-secondary p-3 font-mono text-[11px] text-destructive">
              {errors.slice(0, 100).map((e) => <li key={e}>{e}</li>)}
            </ul>
          )}
        </div>
      )}
    </AppShell>
  );
}
