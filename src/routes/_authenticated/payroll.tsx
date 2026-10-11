import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { localDb } from "@/lib/local-db";
import { AppShell, StatCard, btnGhost, btnPrimary, inputCls } from "@/components/AppShell";
import {
  currentWeek, fullName, money, splitHours, useAdjustments, useEmployees, useFieldDefs, usePayrollSettings, useRecords,
  type Employee,
} from "@/lib/payroll";
import { Settings2, Trash2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/payroll")({
  head: () => ({ meta: [{ title: "Payroll — Meridian Payroll" }] }),
  component: PayrollPage,
});

const builtInCols: { key: string; label: string; get: (e: Employee) => string }[] = [
  { key: "employee_code", label: "ID", get: (e) => e.employee_code },
  { key: "job_title", label: "Job title", get: (e) => e.job_title ?? "" },
  { key: "department", label: "Department", get: (e) => e.department ?? "" },
  { key: "email", label: "Email", get: (e) => e.email ?? "" },
  { key: "phone", label: "Phone", get: (e) => e.phone ?? "" },
  { key: "hire_date", label: "Hire date", get: (e) => e.hire_date ?? "" },
];

function PayrollPage() {
  const w = currentWeek();
  const [from, setFrom] = useState(w.from);
  const [to, setTo] = useState(w.to);
  const [showSettings, setShowSettings] = useState(false);
  const qc = useQueryClient();
  const { data: records = [] } = useRecords(from, to);
  const { data: employees = [] } = useEmployees();
  const { data: adjustments = [] } = useAdjustments(from, to);
  const { data: defs = [] } = useFieldDefs();
  const { data: settings } = usePayrollSettings();
  const threshold = settings?.ot_threshold ?? 40;
  const mult = settings?.ot_multiplier ?? 1.5;
  const visible = settings?.visible_columns ?? [];

  const infoCols = [
    ...builtInCols,
    ...defs.map((d) => ({ key: d.id, label: d.label, get: (e: Employee) => String(((e.custom_fields ?? {}) as Record<string, unknown>)[d.id] ?? "") })),
  ].filter((c) => visible.includes(c.key));
  const showDays = visible.includes("days");
  const showRate = visible.includes("rate");

  const categories = [...new Set(adjustments.map((a) => a.category))].sort();
  const empIds = new Set([...records.map((r) => r.employee_id), ...adjustments.map((a) => a.employee_id)]);
  const list = employees
    .filter((e) => empIds.has(e.id))
    .map((e) => {
      const recs = records.filter((r) => r.employee_id === e.id);
      const { regular, overtime } = splitHours(recs, threshold);
      const rate = Number(e.hourly_rate);
      const extras: Record<string, number> = {};
      for (const a of adjustments) if (a.employee_id === e.id) extras[a.category] = (extras[a.category] ?? 0) + Number(a.amount);
      const regPay = regular * rate;
      const otPay = overtime * rate * mult;
      const extraTotal = Object.values(extras).reduce((s, n) => s + n, 0);
      return { e, days: new Set(recs.map((r) => r.work_date)).size, rate, regular, overtime, regPay, otPay, extras, gross: regPay + otPay + extraTotal };
    })
    .sort((a, b) => fullName(a.e).localeCompare(fullName(b.e)));

  const sum = (f: (r: (typeof list)[number]) => number) => list.reduce((s, r) => s + f(r), 0);

  const exportCsv = () => {
    const head = ["Name", ...infoCols.map((c) => c.label), ...(showDays ? ["Days"] : []), ...(showRate ? ["Rate"] : []),
      "Regular hours", "Overtime hours", "Regular pay", "Overtime pay", ...categories, "Gross pay"];
    const body = list.map((r) => [fullName(r.e), ...infoCols.map((c) => c.get(r.e)), ...(showDays ? [r.days] : []), ...(showRate ? [r.rate.toFixed(2)] : []),
      r.regular.toFixed(2), r.overtime.toFixed(2), r.regPay.toFixed(2), r.otPay.toFixed(2), ...categories.map((c) => (r.extras[c] ?? 0).toFixed(2)), r.gross.toFixed(2)]);
    const csv = [head, ...body].map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `payroll_${from}_${to}.csv`;
    a.click();
  };

  const th = "px-3 py-3 font-medium whitespace-nowrap";
  return (
    <AppShell eyebrow="Payroll run" title={`${from} – ${to}`} actions={
      <div className="flex gap-2">
        <button onClick={() => setShowSettings((s) => !s)} className={btnGhost}><Settings2 className="mr-1 inline h-4 w-4" />Customize</button>
        <button onClick={exportCsv} className={btnGhost}>Export CSV</button>
      </div>
    }>
      <div className="flex items-center gap-3">
        <span className="label-mono">Period</span>
        <input type="date" className={`${inputCls} max-w-[11rem]`} value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="text-muted-foreground">→</span>
        <input type="date" className={`${inputCls} max-w-[11rem]`} value={to} onChange={(e) => setTo(e.target.value)} />
      </div>

      {showSettings && settings && (
        <SettingsPanel settings={settings} cols={[...builtInCols.map((c) => ({ key: c.key, label: c.label })), { key: "days", label: "Days" }, { key: "rate", label: "Rate" }, ...defs.map((d) => ({ key: d.id, label: d.label }))]}
          onSaved={() => qc.invalidateQueries({ queryKey: ["payroll-settings"] })} />
      )}

      <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Gross pay" value={money(sum((r) => r.gross))} highlight />
        <StatCard label="Regular hours" value={sum((r) => r.regular).toFixed(2)} delay={60} />
        <StatCard label="Overtime hours" value={sum((r) => r.overtime).toFixed(2)} delay={120} />
        <StatCard label="Employees paid" value={String(list.length)} delay={180} />
      </section>

      <div className="glass-panel overflow-hidden">
        <div className="border-b border-border px-5 py-3 text-xs text-muted-foreground">
          Overtime: hours over {threshold} per week (Mon–Sun), paid at {mult}× the hourly rate.
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                <th className={`${th} pl-5 text-left`}>Employee</th>
                {infoCols.map((c) => <th key={c.key} className={`${th} text-left`}>{c.label}</th>)}
                {showDays && <th className={`${th} text-right`}>Days</th>}
                {showRate && <th className={`${th} text-right`}>Rate</th>}
                <th className={`${th} text-right`}>Reg hrs</th>
                <th className={`${th} text-right`}>OT hrs</th>
                <th className={`${th} text-right`}>Regular pay</th>
                <th className={`${th} text-right`}>OT pay</th>
                {categories.map((c) => <th key={c} className={`${th} text-right`}>{c}</th>)}
                <th className={`${th} pr-5 text-right`}>Gross pay</th>
              </tr>
            </thead>
            <tbody className="font-mono text-[13px]">
              {list.length === 0 && <tr><td colSpan={20} className="px-5 py-10 text-center font-body text-muted-foreground">No hours in this period.</td></tr>}
              {list.map((r) => (
                <tr key={r.e.id} className="border-b border-border last:border-0 hover:bg-secondary">
                  <td className="px-5 py-3 font-body">{fullName(r.e)}</td>
                  {infoCols.map((c) => <td key={c.key} className="px-3 py-3 font-body">{c.get(r.e) || "—"}</td>)}
                  {showDays && <td className="px-3 py-3 text-right">{r.days}</td>}
                  {showRate && <td className="px-3 py-3 text-right">{money(r.rate)}</td>}
                  <td className="px-3 py-3 text-right">{r.regular.toFixed(2)}</td>
                  <td className="px-3 py-3 text-right">{r.overtime.toFixed(2)}</td>
                  <td className="px-3 py-3 text-right">{money(r.regPay)}</td>
                  <td className="px-3 py-3 text-right">{money(r.otPay)}</td>
                  {categories.map((c) => <td key={c} className="px-3 py-3 text-right">{money(r.extras[c] ?? 0)}</td>)}
                  <td className="px-5 py-3 text-right font-semibold">{money(r.gross)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ExtrasPanel employees={employees} adjustments={adjustments} defaultDate={to} onChange={() => qc.invalidateQueries({ queryKey: ["adjustments"] })} />
    </AppShell>
  );
}

function SettingsPanel({ settings, cols, onSaved }: {
  settings: { ot_threshold: number; ot_multiplier: number; visible_columns: string[] };
  cols: { key: string; label: string }[]; onSaved: () => void;
}) {
  const [threshold, setThreshold] = useState(String(settings.ot_threshold));
  const [mult, setMult] = useState(String(settings.ot_multiplier));
  const [vis, setVis] = useState<string[]>(settings.visible_columns);
  useEffect(() => setVis(settings.visible_columns), [settings.visible_columns]);

  const save = async () => {
    const t = Number(threshold), m = Number(mult);
    if (!Number.isFinite(t) || t < 0 || t > 168) { toast.error("Overtime threshold must be 0–168 hours"); return; }
    if (!Number.isFinite(m) || m < 1 || m > 5) { toast.error("Overtime multiplier must be between 1 and 5"); return; }
    try { await localDb.upsertPayrollSettings({ ot_threshold: t, ot_multiplier: m, visible_columns: vis }); } catch (err) { toast.error((err as Error).message); return; }
    toast.success("Payroll settings saved");
    onSaved();
  };

  return (
    <div className="glass-panel space-y-4 p-5">
      <div className="font-display font-extrabold tracking-tight">Customize payroll</div>
      <div className="flex flex-wrap gap-4">
        <label><span className="label-mono">Overtime after (hrs / week)</span>
          <input type="number" step="0.5" className={`${inputCls} mt-1 max-w-[10rem]`} value={threshold} onChange={(e) => setThreshold(e.target.value)} /></label>
        <label><span className="label-mono">Overtime rate (× hourly)</span>
          <input type="number" step="0.1" className={`${inputCls} mt-1 max-w-[10rem]`} value={mult} onChange={(e) => setMult(e.target.value)} /></label>
      </div>
      <div>
        <div className="label-mono mb-2">Show these columns</div>
        <div className="flex flex-wrap gap-2">
          {cols.map((c) => {
            const on = vis.includes(c.key);
            return (
              <button key={c.key} type="button" onClick={() => setVis(on ? vis.filter((v) => v !== c.key) : [...vis, c.key])}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium ring-1 ring-border ${on ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`}>
                {c.label}
              </button>
            );
          })}
        </div>
      </div>
      <button onClick={save} className={btnPrimary}>Save settings</button>
    </div>
  );
}

function ExtrasPanel({ employees, adjustments, defaultDate, onChange }: {
  employees: Employee[]; adjustments: { id: string; employee_id: string; pay_date: string; category: string; amount: number; note: string | null }[];
  defaultDate: string; onChange: () => void;
}) {
  const [emp, setEmp] = useState("");
  const [category, setCategory] = useState("Bonus");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(defaultDate);
  const [note, setNote] = useState("");
  useEffect(() => setDate(defaultDate), [defaultDate]);
  const known = [...new Set(["Bonus", "Reimbursement", ...adjustments.map((a) => a.category)])];
  const name = (id: string) => { const e = employees.find((x) => x.id === id); return e ? fullName(e) : "—"; };

  const add = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const amt = Number(amount);
    if (!emp) { toast.error("Pick an employee"); return; }
    if (!category.trim() || category.length > 40) { toast.error("Enter a category name (up to 40 characters)"); return; }
    if (!Number.isFinite(amt) || amount === "") { toast.error("Enter an amount"); return; }
    try { await localDb.insertAdjustment({ employee_id: emp, category: category.trim(), amount: amt, pay_date: date, note: note.trim().slice(0, 300) || null }); } catch (err) { toast.error((err as Error).message); return; }
    toast.success("Extra pay added");
    setAmount(""); setNote("");
    onChange();
  };
  const remove = async (id: string) => {
    try { await localDb.deleteAdjustment(id); onChange(); } catch (err) { toast.error((err as Error).message); }
  };

  return (
    <div className="glass-panel overflow-hidden">
      <div className="border-b border-border px-5 py-4">
        <div className="font-display font-extrabold tracking-tight">Extra pay</div>
        <p className="text-xs text-muted-foreground">Bonuses, reimbursements or any category you type. Each category becomes its own payroll column.</p>
      </div>
      <form onSubmit={add} className="grid gap-3 p-5 md:grid-cols-6">
        <select className={inputCls} value={emp} onChange={(e) => setEmp(e.target.value)}>
          <option value="">Employee…</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{fullName(e)}</option>)}
        </select>
        <input className={inputCls} list="extra-cats" placeholder="Category" value={category} onChange={(e) => setCategory(e.target.value)} />
        <datalist id="extra-cats">{known.map((k) => <option key={k} value={k} />)}</datalist>
        <input className={inputCls} type="number" step="0.01" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <input className={inputCls} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <input className={inputCls} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className={btnPrimary}>Add</button>
      </form>
      {adjustments.length > 0 && (
        <table className="w-full text-sm">
          <tbody className="font-mono text-[13px]">
            {adjustments.map((a) => (
              <tr key={a.id} className="border-t border-border hover:bg-secondary">
                <td className="px-5 py-2 font-body">{name(a.employee_id)}</td>
                <td className="px-3 py-2">{a.pay_date}</td>
                <td className="px-3 py-2 font-body">{a.category}</td>
                <td className="px-3 py-2 font-body text-muted-foreground">{a.note ?? ""}</td>
                <td className="px-3 py-2 text-right">{money(Number(a.amount))}</td>
                <td className="w-10 pr-4"><button onClick={() => remove(a.id)} aria-label="Delete extra pay" className="text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
