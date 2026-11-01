import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { db } from "@/lib/db/mode";
import { AppShell, StatCard, btnGhost, btnPrimary, inputCls } from "@/components/AppShell";
import { EmployeePicker, SearchInput } from "@/components/EmployeeSearch";
import { DataTable } from "@/components/DataTable";
import { describeEmployeeFilter, isFiltering, matchesEmployee, NO_FILTER, type EmployeeFilter } from "@/lib/employee-search";
import {
  currentWeek, fullName, money, useAdjustments, useAllRecords, useEmployees, useFieldDefs, usePayRates, usePayrollSettings, useShifts,
  type Employee, type Shift,
} from "@/lib/payroll";
import { employeePay, shiftFor, weekEnd, weekStart } from "@/lib/pay";
import { ratesBetween } from "@/lib/pay-rates";
import { PayLock } from "@/components/PayLock";
import { formatValue } from "@/lib/field-types";
import { labelOf, useLabels } from "@/lib/labels";
import { customKey } from "@/lib/db/privacy";
import { Plus, Settings2, Trash2 } from "lucide-react";
import { EditableLabel } from "@/components/EditableLabel";
import { BreakInput } from "@/components/BreakField";
import { useBreakUnit, validBreak, breakRangeText } from "@/lib/breaks";
import type { TablesUpdate } from "@/integrations/supabase/types";
import { SortControl } from "@/components/SortControl";
import { usePref } from "@/lib/prefs";
import { validSort, type Sort, type SortKey } from "@/lib/record-sort";
import { DateInput } from "@/components/DateInput";

export const Route = createFileRoute("/_authenticated/payroll")({
  head: () => ({ meta: [{ title: "Payroll — Meridian Payroll" }] }),
  component: PayrollPage,
});

/** `key` is also the column's alias key (see src/lib/labels.ts); custom categories use customKey(id). */
const builtInCols: { key: string; label: string; get: (e: Employee) => string; alias?: string }[] = [
  { key: "employee_code", label: "ID", get: (e) => e.employee_code },
  { key: "job_title", label: "Job title", get: (e) => e.job_title ?? "" },
  { key: "department", label: "Department", get: (e) => e.department ?? "" },
  { key: "email", label: "Email", get: (e) => e.email ?? "" },
  { key: "phone", label: "Phone", get: (e) => e.phone ?? "" },
  { key: "hire_date", label: "Hire date", get: (e) => e.hire_date ?? "" },
];

const SORT_KEYS = ["employee", "hours", "pay"] as const satisfies readonly SortKey[];
const BY_NAME: Sort<(typeof SORT_KEYS)[number]> = { by: "employee", desc: false };

function PayrollPage() {
  const w = currentWeek();
  const [from, setFrom] = useState(w.from);
  const [to, setTo] = useState(w.to);
  const [showSettings, setShowSettings] = useState(false);
  const [q, setQ] = useState<EmployeeFilter>(NO_FILTER);
  const [savedSort, setSort] = usePref<Sort>("meridian-payroll-sort", BY_NAME);
  const sort = validSort(savedSort, SORT_KEYS, BY_NAME);
  const qc = useQueryClient();
  // Load whole Mon–Sun weeks around the period, so weekly overtime is right even when the period starts mid-week.
  const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
  const { data: records = [] } = useAllRecords(isDate(from) ? weekStart(from) : from, isDate(to) ? weekEnd(to) : to);
  const { data: shifts = [] } = useShifts();
  const { data: employees = [] } = useEmployees();
  const { data: rateHistory } = usePayRates();
  const { data: adjustments = [] } = useAdjustments(from, to);
  const { data: defs = [] } = useFieldDefs();
  const { data: settings } = usePayrollSettings();
  const threshold = settings?.ot_threshold ?? 40;
  const mult = settings?.ot_multiplier ?? 1.5;
  const weekendOt = settings?.weekend_overtime ?? true;
  const rules = { threshold, otMultiplier: mult, weekendOvertime: weekendOt };
  const visible = settings?.visible_columns ?? [];

  // Categories under Personal are personal details, which stay off payroll.
  const shownDefs = defs.filter((d) => d.section !== "Personal");
  const infoCols = [
    ...builtInCols,
    ...shownDefs.map((d) => ({ key: d.id, alias: customKey(d.id), label: d.label, get: (e: Employee) => formatValue(d.field_type, String(((e.custom_fields ?? {}) as Record<string, unknown>)[d.id] ?? "")) })),
  ].filter((c) => visible.includes(c.key));
  const aliasKey = (c: { key: string; alias?: string }) => c.alias ?? c.key;
  const { label } = useLabels();
  const showDays = visible.includes("days");
  const showRate = visible.includes("rate");
  const showShift = visible.includes("shift");

  const categories = [...new Set(adjustments.map((a) => a.category))].sort();
  const inPeriod = records.filter((r) => r.work_date >= from && r.work_date <= to);
  const empIds = new Set([...inPeriod.map((r) => r.employee_id), ...adjustments.map((a) => a.employee_id)]);
  const byEmp = new Map<string, typeof records>();
  for (const r of records) byEmp.set(r.employee_id, [...(byEmp.get(r.employee_id) ?? []), r]);
  const list = employees
    .filter((e) => empIds.has(e.id))
    .map((e) => {
      const history = rateHistory?.get(e.id);
      // Every rate paid in the period, oldest first (more than one when it changed partway through).
      const rates = ratesBetween(history, e.hourly_rate, from, to);
      const rate = rates.at(-1)!;
      const shift = shiftFor(e.shift_id, shifts);
      const p = employeePay(byEmp.get(e.id) ?? [], { rate: Number(e.hourly_rate), rates: history, shiftMultiplier: shift.multiplier, rules, payType: e.pay_type, shifts, from, to });
      const extras: Record<string, number> = {};
      for (const a of adjustments) if (a.employee_id === e.id) extras[a.category] = (extras[a.category] ?? 0) + Number(a.amount);
      const extraTotal = Object.values(extras).reduce((s, n) => s + n, 0);
      return { e, shift, rate, rates, ...p, extras, gross: p.total + extraTotal };
    })
    .sort((a, b) => {
      // Ties (and the name sort itself) go by name A to Z, so equal amounts stay in a findable order.
      const byName = fullName(a.e).localeCompare(fullName(b.e), undefined, { sensitivity: "base" });
      const diff = sort.by === "hours" ? a.regular + a.overtime - (b.regular + b.overtime) : sort.by === "pay" ? a.gross - b.gross : byName;
      return (sort.desc ? -diff : diff) || byName;
    });

  const sum = (f: (r: (typeof list)[number]) => number) => list.reduce((s, r) => s + f(r), 0);
  const hasManual = list.some((r) => r.manualDays > 0);
  // The search narrows the table only; totals and the CSV export always cover everyone paid.
  const shown = isFiltering(q) ? list.filter((r) => matchesEmployee(r.e, q)) : list;

  const exportCsv = () => {
    const head = [labelOf("employee", "Name"), ...infoCols.map((c) => labelOf(aliasKey(c), c.label)), labelOf("pay_type", "Pay type"), labelOf("shift", "Shift"), "Shift multiplier",
      ...(showDays ? [labelOf("days", "Days")] : []), ...(showRate ? [labelOf("hourly_rate", "Rate")] : []),
      labelOf("reg_hrs", "Regular hours"), labelOf("ot_hrs", "Overtime hours"), "Weekend hours", labelOf("reg_pay", "Regular pay"), labelOf("ot_pay", "Overtime pay"),
      labelOf("manual_pay", "Manual day pay"), ...categories.map((c) => labelOf(`extra:${c}`, c)), labelOf("gross_pay", "Gross pay")];
    const body = list.map((r) => [fullName(r.e), ...infoCols.map((c) => c.get(r.e)), r.e.pay_type === "salary" ? "Salary" : "Hourly", r.shift.name, r.shift.multiplier, ...(showDays ? [r.days] : []), ...(showRate ? [r.rates.map((x) => x.toFixed(2)).join(" → ")] : []),
      r.regular.toFixed(2), r.overtime.toFixed(2), r.weekendHours.toFixed(2), r.regPay.toFixed(2), r.otPay.toFixed(2), r.manualPay.toFixed(2),
      ...categories.map((c) => (r.extras[c] ?? 0).toFixed(2)), r.gross.toFixed(2)]);
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
        <DateInput className={`${inputCls} max-w-[11rem]`} value={from} onChange={(v) => setFrom(v)} />
        <span className="text-muted-foreground">→</span>
        <DateInput className={`${inputCls} max-w-[11rem]`} value={to} onChange={(v) => setTo(v)} />
      </div>
      {to && <PayLock periodEnd={to} />}

      {showSettings && settings && (
        <>
          <SettingsPanel settings={settings} cols={[...builtInCols.map((c) => ({ key: c.key, label: label(c.key, c.label) })), { key: "shift", label: label("shift", "Shift") }, { key: "days", label: label("days", "Days") },
            { key: "rate", label: label("hourly_rate", "Rate") }, ...shownDefs.map((d) => ({ key: d.id, label: label(customKey(d.id), d.label) }))]}
            onSaved={() => qc.invalidateQueries({ queryKey: ["payroll-settings"] })} />
          <ShiftsPanel shifts={shifts} employees={employees} onChange={() => qc.invalidateQueries({ queryKey: ["shifts"] })} />
        </>
      )}

      <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Gross pay" value={money(sum((r) => r.gross))} highlight />
        <StatCard label="Regular hours" value={sum((r) => r.regular).toFixed(2)} delay={60} />
        <StatCard label="Overtime hours" value={sum((r) => r.overtime).toFixed(2)} delay={120} />
        <StatCard label="Employees paid" value={String(list.length)} delay={180} />
      </section>

      <div className="glass-panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
          <span className="text-xs text-muted-foreground">
            Overtime ({mult}× rate): {weekendOt ? `every Saturday and Sunday hour, plus weekday hours over ${threshold}` : `hours over ${threshold}`} in a Mon–Sun week.
            {" "}Shift multipliers scale the rate for regular hours only; overtime is always {mult}× the base rate, never stacked with the shift. Salaried employees get {threshold} h × rate for each week they work, with no overtime. Days with manual pay are paid exactly the amount entered.
            {isFiltering(q) && ` Showing ${shown.length} of ${list.length}; totals above include everyone.`}
          </span>
          <div className="flex w-full flex-wrap items-center gap-3">
            <SearchInput value={q} onChange={setQ} employees={list.map((r) => r.e)} className="min-w-[16rem] max-w-xl flex-1" />
            <SortControl value={sort} onChange={setSort} keys={SORT_KEYS} />
          </div>
        </div>
        <div className="overflow-x-auto">
          <DataTable id="payroll" className="w-full text-sm">
            <thead>
              <tr className="border-b border-border font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                <th className={`${th} pl-5 text-left`}><EditableLabel k="employee" name="Employee" /></th>
                {infoCols.map((c) => <th key={c.key} className={`${th} text-left`}><EditableLabel k={aliasKey(c)} name={c.label} /></th>)}
                {showDays && <th className={`${th} text-right`}><EditableLabel k="days" name="Days" /></th>}
                {showShift && <th className={`${th} text-left`}><EditableLabel k="shift" name="Shift" /></th>}
                {showRate && <th className={`${th} text-right`}><EditableLabel k="hourly_rate" name="Rate" /></th>}
                <th className={`${th} text-right`}><EditableLabel k="reg_hrs" name="Reg hrs" /></th>
                <th className={`${th} text-right`}><EditableLabel k="ot_hrs" name="OT hrs" /></th>
                <th className={`${th} text-right`}><EditableLabel k="reg_pay" name="Regular pay" /></th>
                <th className={`${th} text-right`}><EditableLabel k="ot_pay" name="OT pay" /></th>
                {hasManual && <th className={`${th} text-right`}><EditableLabel k="manual_pay" name="Manual pay" /></th>}
                {categories.map((c) => <th key={c} className={`${th} text-right`}><EditableLabel k={`extra:${c}`} name={c} /></th>)}
                <th className={`${th} pr-5 text-right`}><EditableLabel k="gross_pay" name="Gross pay" /></th>
              </tr>
            </thead>
            <tbody className="font-mono text-[13px]">
              {list.length === 0 && <tr><td colSpan={20} className="px-5 py-10 text-center font-body text-muted-foreground">No hours in this period.</td></tr>}
              {list.length > 0 && shown.length === 0 && <tr><td colSpan={20} className="px-5 py-10 text-center font-body text-muted-foreground">No one paid this period matches {describeEmployeeFilter(q)}.</td></tr>}
              {shown.map((r) => (
                <tr key={r.e.id} className="border-b border-border last:border-0 hover:bg-secondary">
                  <td className="px-5 py-3 font-body">{fullName(r.e)}{r.e.pay_type === "salary" && <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground ring-1 ring-border">Salary</span>}</td>
                  {infoCols.map((c) => <td key={c.key} className="px-3 py-3 font-body">{c.get(r.e) || "—"}</td>)}
                  {showDays && <td className="px-3 py-3 text-right">{r.days}</td>}
                  {showShift && <td className="px-3 py-3 font-body">{r.shift.name}{r.shift.multiplier !== 1 && <span className="text-muted-foreground"> ×{r.shift.multiplier}</span>}</td>}
                  {showRate && <td className="px-3 py-3 text-right" title={r.rates.length > 1 ? "The rate changed during this period; each day is paid at the rate in force that day." : undefined}>{r.rates.map(money).join(" → ")}{r.shift.multiplier !== 1 && <div className="text-[11px] text-muted-foreground">{r.rates.map((x) => money(x * r.shift.multiplier)).join(" → ")} on shift</div>}</td>}
                  <td className="px-3 py-3 text-right">{r.regular.toFixed(2)}</td>
                  <td className="px-3 py-3 text-right">{r.overtime.toFixed(2)}</td>
                  <td className="px-3 py-3 text-right">{money(r.regPay)}</td>
                  <td className="px-3 py-3 text-right">{money(r.otPay)}</td>
                  {hasManual && <td className="px-3 py-3 text-right" title={`${r.manualDays} day(s) with manual pay`}>{r.manualDays ? money(r.manualPay) : "—"}</td>}
                  {categories.map((c) => <td key={c} className="px-3 py-3 text-right">{money(r.extras[c] ?? 0)}</td>)}
                  <td className="px-5 py-3 text-right font-semibold">{money(r.gross)}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </div>
      </div>

      <ExtrasPanel employees={employees} adjustments={adjustments} defaultDate={to} onChange={() => qc.invalidateQueries({ queryKey: ["adjustments"] })} />
    </AppShell>
  );
}

function SettingsPanel({ settings, cols, onSaved }: {
  settings: { ot_threshold: number; ot_multiplier: number; weekend_overtime: boolean; visible_columns: string[] };
  cols: { key: string; label: string }[]; onSaved: () => void;
}) {
  const [threshold, setThreshold] = useState(String(settings.ot_threshold));
  const [mult, setMult] = useState(String(settings.ot_multiplier));
  const [weekend, setWeekend] = useState(settings.weekend_overtime);
  const [vis, setVis] = useState<string[]>(settings.visible_columns);
  useEffect(() => setVis(settings.visible_columns), [settings.visible_columns]);

  const save = async () => {
    const t = Number(threshold), m = Number(mult);
    if (!Number.isFinite(t) || t < 0 || t > 168) { toast.error("Overtime threshold must be 0–168 hours"); return; }
    if (!Number.isFinite(m) || m < 1 || m > 5) { toast.error("Overtime multiplier must be between 1 and 5"); return; }
    const { error } = await db().saveSettings({ ot_threshold: t, ot_multiplier: m, weekend_overtime: weekend, visible_columns: vis });
    if (error) { toast.error(error.message); return; }
    toast.success("Payroll settings saved");
    onSaved();
  };

  return (
    <div className="glass-panel space-y-4 p-5">
      <div className="font-display font-extrabold tracking-tight">Customize payroll</div>
      <div className="flex flex-wrap gap-4">
        <label><span className="label-mono">Weekday overtime after (hrs / week)</span>
          <input type="number" step="0.5" className={`${inputCls} mt-1 max-w-[10rem]`} value={threshold} onChange={(e) => setThreshold(e.target.value)} /></label>
        <label><span className="label-mono">Overtime rate (× hourly)</span>
          <input type="number" step="0.1" className={`${inputCls} mt-1 max-w-[10rem]`} value={mult} onChange={(e) => setMult(e.target.value)} /></label>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" checked={weekend} onChange={(e) => setWeekend(e.target.checked)} />
          Saturday and Sunday hours are always overtime
        </label>
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
    const { error } = await db().insert("pay_adjustments", { employee_id: emp, category: category.trim(), amount: amt, pay_date: date, note: note.trim().slice(0, 300) || null });
    if (error) { toast.error(error.message); return; }
    toast.success("Extra pay added");
    setAmount(""); setNote("");
    onChange();
  };
  const remove = async (id: string) => {
    const { error } = await db().remove("pay_adjustments", id);
    if (error) toast.error(error.message); else onChange();
  };

  return (
    <div className="glass-panel overflow-hidden">
      <div className="border-b border-border px-5 py-4">
        <div className="font-display font-extrabold tracking-tight">Extra pay</div>
        <p className="text-xs text-muted-foreground">Bonuses, reimbursements or any category you type. Each category becomes its own payroll column.</p>
      </div>
      <form onSubmit={add} className="grid gap-3 p-5 md:grid-cols-6">
        <EmployeePicker employees={employees} value={emp} onChange={setEmp} placeholder="Employee…" />
        <input className={inputCls} list="extra-cats" placeholder="Category" value={category} onChange={(e) => setCategory(e.target.value)} />
        <datalist id="extra-cats">{known.map((k) => <option key={k} value={k} />)}</datalist>
        <input className={inputCls} type="number" step="0.01" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <DateInput className={inputCls} value={date} onChange={(v) => setDate(v)} />
        <input className={inputCls} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className={btnPrimary}>Add</button>
      </form>
      {adjustments.length > 0 && (
        <DataTable id="payroll-extra-pay" className="w-full text-sm">
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
        </DataTable>
      )}
    </div>
  );
}

/** The shifts employees can be on, each with a multiplier on the hourly rate. The first one is the default. */
function ShiftsPanel({ shifts, employees, onChange }: { shifts: Shift[]; employees: Employee[]; onChange: () => void }) {
  const [name, setName] = useState("");
  const [multiplier, setMultiplier] = useState("1");
  const counts = new Map<string, number>();
  for (const e of employees) {
    const id = shiftFor(e.shift_id, shifts).id;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const checkMult = (v: string) => {
    const m = Number(v);
    if (!Number.isFinite(m) || m <= 0 || m > 10) { toast.error("A shift multiplier must be above 0 and at most 10 (1 = normal rate)"); return null; }
    return Math.round(m * 1000) / 1000;
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n || n.length > 40) { toast.error("Give the shift a name (up to 40 characters)"); return; }
    if (shifts.some((s) => s.name.toLowerCase() === n.toLowerCase())) { toast.error(`There's already a "${n}" shift`); return; }
    const m = checkMult(multiplier);
    if (m === null) return;
    const { error } = await db().insert("shifts", { name: n, multiplier: m, sort_order: shifts.length });
    if (error) { toast.error(error.message); return; }
    toast.success(`Added the ${n} shift`);
    setName(""); setMultiplier("1");
    onChange();
  };
  const save = async (s: Shift, patch: TablesUpdate<"shifts">) => {
    const { error } = await db().update("shifts", s.id, patch);
    if (error) toast.error(error.message); else { toast.success(`${patch.name ?? s.name} shift saved`); onChange(); }
  };
  const remove = async (s: Shift) => {
    const rest = shifts.filter((x) => x.id !== s.id);
    if (!rest.length) { toast.error("Keep at least one shift"); return; }
    const n = counts.get(s.id) ?? 0;
    if (!confirm(`Delete the ${s.name} shift?${n ? `\n\n${n} employee${n === 1 ? "" : "s"} on it will move to the default shift (${rest[0]!.name}).` : ""}`)) return;
    const { error } = await db().remove("shifts", s.id);
    if (error) { toast.error(error.message); return; }
    onChange();
  };

  return (
    <div className="glass-panel overflow-hidden">
      <div className="border-b border-border px-5 py-4">
        <div className="font-display font-extrabold tracking-tight">Shifts</div>
        <p className="text-xs text-muted-foreground">
          Each employee is on one shift. The multiplier scales their rate for regular hours (1 = normal, 1.1 = 10% more). Overtime hours are paid at the overtime rate instead, not stacked with the shift. A single day can be put on another shift on the Time records page.
          New employees start on the first shift. A shift's usual hours (optional) fill in the clock-in, clock-out and break when you add records for its people on the Time records page.
        </p>
      </div>
      <div className="divide-y divide-border">
        {shifts.map((s, i) => <ShiftRow key={s.id} shift={s} isDefault={i === 0} count={counts.get(s.id) ?? 0} onSave={save} onRemove={remove} checkMult={checkMult} />)}
        {shifts.length === 0 && <div className="px-5 py-4 text-sm text-muted-foreground">No shifts yet: everyone is paid their normal rate. Add one below.</div>}
      </div>
      <form onSubmit={add} className="flex flex-wrap items-end gap-3 border-t border-border p-5">
        <label><span className="label-mono">New shift</span><input className={`${inputCls} mt-1`} placeholder="e.g. Swing, Weekend" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label><span className="label-mono">Multiplier</span><input type="number" step="0.05" min="0.05" max="10" className={`${inputCls} mt-1 w-28`} value={multiplier} onChange={(e) => setMultiplier(e.target.value)} /></label>
        <button className={btnPrimary}><Plus className="mr-1 inline h-4 w-4" />Add shift</button>
      </form>
    </div>
  );
}

function ShiftRow({ shift, isDefault, count, onSave, onRemove, checkMult }: {
  shift: Shift; isDefault: boolean; count: number;
  onSave: (s: Shift, patch: TablesUpdate<"shifts">) => void; onRemove: (s: Shift) => void; checkMult: (v: string) => number | null;
}) {
  const [unit] = useBreakUnit();
  const saved = {
    name: shift.name, mult: String(Number(shift.multiplier)),
    start: shift.default_clock_in?.slice(0, 5) ?? "", end: shift.default_clock_out?.slice(0, 5) ?? "",
    brk: shift.default_lunch_minutes === null ? "" : String(shift.default_lunch_minutes),
  };
  const [v, setV] = useState(saved);
  const savedKey = JSON.stringify(saved);
  useEffect(() => { setV(JSON.parse(savedKey) as typeof saved); }, [savedKey]);
  const set = (k: keyof typeof saved, val: string) => setV((x) => ({ ...x, [k]: val }));
  const dirty = v.name.trim() !== saved.name || Number(v.mult) !== Number(saved.mult) || v.start !== saved.start || v.end !== saved.end || (!!v.start && v.brk !== saved.brk);
  const save = () => {
    if (!v.name.trim()) { toast.error("A shift needs a name"); return; }
    const m = checkMult(v.mult);
    if (m === null) return;
    if (!v.start !== !v.end) { toast.error("Set both the usual start and end, or clear both"); return; }
    const brk = v.start ? Number(v.brk || 0) : null;
    if (brk !== null && !validBreak(brk)) { toast.error(breakRangeText(unit)); return; }
    onSave(shift, { name: v.name.trim().slice(0, 40), multiplier: m, default_clock_in: v.start || null, default_clock_out: v.end || null, default_lunch_minutes: brk });
  };
  return (
    <div className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
      <input className={`${inputCls} max-w-[12rem]`} value={v.name} onChange={(e) => set("name", e.target.value)} aria-label="Shift name" />
      <span className="text-muted-foreground">×</span>
      <input type="number" step="0.05" min="0.05" max="10" className={`${inputCls} w-24`} value={v.mult} onChange={(e) => set("mult", e.target.value)} aria-label={`${shift.name} multiplier`} />
      <span className="ml-2 text-xs text-muted-foreground">Usual hours</span>
      <input type="time" className={`${inputCls} !w-[7.5rem]`} value={v.start} onChange={(e) => set("start", e.target.value)} aria-label={`${shift.name} usual start`} />
      <span className="text-muted-foreground">–</span>
      <input type="time" className={`${inputCls} !w-[7.5rem]`} value={v.end} onChange={(e) => set("end", e.target.value)} aria-label={`${shift.name} usual end`} />
      <BreakInput minutes={v.brk} onChange={(m) => set("brk", m)} className={`${inputCls} !w-20`} label={`${shift.name} usual break`} />
      <span className="text-xs text-muted-foreground">{unit === "h" ? "h" : "min"} break</span>
      <span className="text-xs text-muted-foreground">{count} employee{count === 1 ? "" : "s"}{isDefault ? " · default" : ""}</span>
      <div className="ml-auto flex gap-2">
        {dirty && <button onClick={save} className={btnPrimary}>Save</button>}
        <button onClick={() => onRemove(shift)} className={btnGhost} aria-label={`Delete ${shift.name} shift`}><Trash2 className="h-4 w-4" /></button>
      </div>
    </div>
  );
}
