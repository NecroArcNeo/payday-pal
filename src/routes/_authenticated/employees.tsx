import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { z } from "zod";
import { db, useDataMode } from "@/lib/db/mode";
import { customKey } from "@/lib/db/privacy";
import { backupBefore } from "@/lib/db/safety";
import { AppShell, btnGhost, btnPrimary, inputCls } from "@/components/AppShell";
import { SearchInput } from "@/components/EmployeeSearch";
import { DataTable } from "@/components/DataTable";
import { EmailLink } from "@/components/EmailLink";
import { CategoryInput } from "@/components/ProfileCategories";
import { codeTakenMessage, employeeWithCode, friendlySaveError } from "@/lib/employee-code";
import { planRateChange, type RatePlan } from "@/lib/pay-rates";
import { askRateDate, writeRateHistory } from "@/lib/rate-change";
import { fullName, money, useEmployeeDefaults, useEmployees, useFieldDefs, usePayRates, usePrivateFields, useShifts, type Employee, type FieldDef, type Shift } from "@/lib/payroll";
import { NO_DEFAULTS, withDefaults } from "@/lib/employee-fields";
import { PAY_TYPES, shiftFor } from "@/lib/pay";
import { describeEmployeeFilter, isFiltering, NO_FILTER, searchEmployees, type EmployeeFilter } from "@/lib/employee-search";
import { IdCard, Pencil, Trash2, X } from "lucide-react";
import { EditableLabel } from "@/components/EditableLabel";
import { useLabels } from "@/lib/labels";

export const Route = createFileRoute("/_authenticated/employees")({
  head: () => ({ meta: [{ title: "Employees — Meridian Payroll" }] }),
  component: EmployeesPage,
});

const schema = z.object({
  employee_code: z.string().trim().min(1, "ID required").max(40),
  first_name: z.string().trim().min(1, "First name required").max(80),
  last_name: z.string().trim().min(1, "Last name required").max(80),
  email: z.string().trim().email("Invalid email").max(255).or(z.literal("")),
  department: z.string().trim().max(80),
  hourly_rate: z.coerce.number().min(0).max(10000),
});

const empty = { employee_code: "", first_name: "", last_name: "", email: "", department: "", hourly_rate: "", shift_id: "", pay_type: "hourly" };

function EmployeesPage() {
  const { data: employees = [] } = useEmployees();
  const { data: defs = [] } = useFieldDefs();
  const { label } = useLabels();
  const { data: shifts = [] } = useShifts();
  const { data: defaults = NO_DEFAULTS } = useEmployeeDefaults();
  const qc = useQueryClient();
  // The add form starts from the default profile.
  const defaultShift = shiftFor(defaults["shift_id"] as string | undefined, shifts).id ?? "";
  const blank = useMemo(() => {
    const d = (k: string) => (defaults[k] == null ? "" : String(defaults[k]));
    return { ...empty, email: d("email"), department: d("department"), hourly_rate: d("hourly_rate"), pay_type: defaults["pay_type"] === "salary" ? "salary" : "hourly", shift_id: defaultShift };
  }, [defaults, defaultShift]);
  const [form, setForm] = useState<Record<string, string>>(empty);
  useEffect(() => setForm(blank), [blank]);
  const [q, setQ] = useState<EmployeeFilter>(NO_FILTER);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkEdit, setBulkEdit] = useState(false);
  const [busy, setBusy] = useState(false);

  // Forget selections of employees that no longer exist.
  useEffect(() => {
    setSelected((s) => {
      const live = new Set(employees.map((e) => e.id));
      const next = new Set([...s].filter((id) => live.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [employees]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = schema.safeParse(form);
    if (!parsed.success) { toast.error(parsed.error.issues[0]?.message ?? "Invalid input"); return; }
    const owner = employeeWithCode(employees, parsed.data.employee_code);
    if (owner) { toast.error(codeTakenMessage(parsed.data.employee_code, owner)); return; }
    const row = { ...parsed.data, email: parsed.data.email || null, department: parsed.data.department || null, shift_id: form["shift_id"] || shifts[0]?.id || null, pay_type: form["pay_type"] === "salary" ? "salary" : "hourly" };
    const { error } = await db().insert("employees", withDefaults(row, defaults));
    if (error) { toast.error(friendlySaveError(error.message)); return; }
    toast.success("Employee added");
    setForm(blank);
    qc.invalidateQueries({ queryKey: ["employees"] });
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this employee and all their time records?")) return;
    const { error } = await db().remove("employees", id);
    if (error) { toast.error(error.message); return; }
    qc.invalidateQueries();
  };

  const list = useMemo(() => searchEmployees(employees, q), [employees, q]);
  const picked = employees.filter((e) => selected.has(e.id));
  const hiddenPicked = picked.filter((e) => !list.includes(e)).length;
  const allShownPicked = list.length > 0 && list.every((e) => selected.has(e.id));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleShown = () => setSelected((s) => {
    const n = new Set(s);
    for (const e of list) if (allShownPicked) n.delete(e.id); else n.add(e.id);
    return n;
  });

  const removeSelected = async () => {
    const ids = picked.map((e) => e.id);
    setBusy(true);
    try {
      // Show exactly what goes with them before asking.
      const [shifts, extras] = await Promise.all([db().listRecordKeys("0001-01-01", "9999-12-31"), db().listAdjustments()]);
      const set = new Set(ids);
      const recs = shifts.filter((s) => set.has(s.employee_id)).length;
      const adj = extras.filter((a) => set.has(a.employee_id)).length;
      const names = picked.slice(0, 8).map(fullName).join(", ") + (picked.length > 8 ? `, and ${picked.length - 8} more` : "");
      if (!confirm(`Delete ${ids.length} employee${ids.length === 1 ? "" : "s"} (${names})?\n\nThis also deletes their ${recs} time record${recs === 1 ? "" : "s"} and ${adj} extra-pay entr${adj === 1 ? "y" : "ies"}. A backup is saved first, so you can restore it from Sync & backup.`)) return;
      await backupBefore("bulk-delete");
      const { error } = await db().removeMany("employees", ids);
      if (error) throw error;
      toast.success(`Deleted ${ids.length} employee${ids.length === 1 ? "" : "s"}. A backup was saved in Sync & backup.`);
      setSelected(new Set());
      qc.invalidateQueries();
    } catch (e) {
      toast.error(`Nothing was deleted: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const field = (k: string, ph: string, type = "text", bad = false) => (
    <input className={`${inputCls} ${bad ? "ring-2 ring-destructive" : ""}`} type={type} step="0.01" placeholder={label(k, ph)} aria-label={label(k, ph)} aria-invalid={bad || undefined} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
  );
  // Say straight away when the ID being typed is someone else's.
  const codeOwner = employeeWithCode(employees, form["employee_code"] ?? "");

  return (
    <AppShell eyebrow="Directory" title={`${employees.length} employees`}>
      <form onSubmit={save} className="glass-panel grid gap-3 p-5 md:grid-cols-9">
        <div>
          {field("employee_code", "Employee ID", "text", !!codeOwner)}
          {codeOwner && <div className="mt-1 text-[11px] text-destructive">Already used by {fullName(codeOwner)}</div>}
        </div>
        {field("first_name", "First name")}
        {field("last_name", "Last name")}
        {field("email", "Email", "email")}
        {field("department", "Department")}
        {field("hourly_rate", "Hourly rate", "number")}
        <select className={inputCls} value={form["pay_type"]} onChange={(e) => setForm({ ...form, pay_type: e.target.value })} aria-label="Pay type"
          title="Salary pays a full week (40 h) at the hourly rate for every week worked, with no overtime.">
          {PAY_TYPES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        <select className={inputCls} value={form["shift_id"] || shifts[0]?.id || ""} onChange={(e) => setForm({ ...form, shift_id: e.target.value })} aria-label="Shift">
          {shifts.map((s) => <option key={s.id} value={s.id}>{s.name} shift{Number(s.multiplier) !== 1 ? ` ×${Number(s.multiplier)}` : ""}</option>)}
          {shifts.length === 0 && <option value="">Day shift</option>}
        </select>
        <div className="flex gap-2">
          <button className={`${btnPrimary} flex-1`}>Add</button>
        </div>
      </form>


      {bulkEdit && picked.length > 0 && (
        <BulkEditPanel employees={picked} defs={defs} shifts={shifts} onClose={() => setBulkEdit(false)}
          onDone={() => { setBulkEdit(false); qc.invalidateQueries(); }} />
      )}

      <div className="glass-panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="font-display font-extrabold tracking-tight">Roster</div>
            <Link to="/employees/template" className={btnGhost} title="The profile every new employee starts with"><IdCard className="mr-1 inline h-4 w-4" />Default profile</Link>
          </div>
          <SearchInput value={q} onChange={setQ} employees={employees} className="w-full max-w-2xl" />
        </div>

        {picked.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-accent/60 px-5 py-2.5 text-sm">
            <span>
              <span className="font-semibold">{picked.length} selected</span>
              {hiddenPicked > 0 && <span className="text-muted-foreground"> ({hiddenPicked} hidden by the search)</span>}
            </span>
            <div className="flex gap-2">
              <button onClick={() => setBulkEdit(true)} disabled={busy} className={btnPrimary}><Pencil className="mr-1 inline h-4 w-4" />Edit {picked.length}</button>
              <button onClick={removeSelected} disabled={busy} className={`${btnGhost} hover:!text-destructive`}><Trash2 className="mr-1 inline h-4 w-4" />Delete {picked.length}</button>
              <button onClick={() => setSelected(new Set())} className={btnGhost} aria-label="Clear selection"><X className="h-4 w-4" /></button>
            </div>
          </div>
        )}

        <DataTable id="employees" className="w-full text-sm">
          <thead>
            <tr className="border-b border-border font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
              <th className="w-10 pl-5"><input type="checkbox" aria-label="Select all shown" checked={allShownPicked} onChange={toggleShown} disabled={!list.length} /></th>
              <th className="px-3 py-3 text-left font-medium"><EditableLabel k="employee" name="Employee" /></th>
              <th className="px-3 py-3 text-left font-medium"><EditableLabel k="employee_code" name="ID" /></th>
              <th className="px-3 py-3 text-left font-medium"><EditableLabel k="job_title" name="Position" /></th>
              <th className="px-3 py-3 text-left font-medium"><EditableLabel k="department" name="Department" /></th>
              <th className="px-3 py-3 text-left font-medium"><EditableLabel k="shift" name="Shift" /></th>
              <th className="px-3 py-3 text-left font-medium"><EditableLabel k="email" name="Email" /></th>
              <th className="px-3 py-3 text-right font-medium"><EditableLabel k="hourly_rate" name="Rate" /></th>
              <th className="w-20" />
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && (
              <tr><td colSpan={9} className="px-5 py-10 text-center text-muted-foreground">
                {employees.length ? `No employee matches ${describeEmployeeFilter(q)}.` : "No employees yet — add one above or import a file."}
              </td></tr>
            )}
            {list.map((e) => (
              <tr key={e.id} className={`border-b border-border last:border-0 hover:bg-secondary ${selected.has(e.id) ? "bg-accent/40" : ""}`}>
                <td className="pl-5"><input type="checkbox" aria-label={`Select ${fullName(e)}`} checked={selected.has(e.id)} onChange={() => toggle(e.id)} /></td>
                <td className="px-3 py-3 font-medium">
                  <Link to="/employees/$id" params={{ id: e.id }} className="hover:underline">{fullName(e)}</Link>
                  {!e.active && <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground ring-1 ring-border">Resigned</span>}
                </td>
                <td className="px-3 py-3 font-mono text-[13px]">{e.employee_code}</td>
                <td className="px-3 py-3 text-muted-foreground">{e.job_title ?? "—"}</td>
                <td className="px-3 py-3 text-muted-foreground">{e.department ?? "—"}</td>
                <td className="px-3 py-3 text-muted-foreground">{shiftFor(e.shift_id, shifts).name}</td>
                <td className="px-3 py-3 text-muted-foreground">{e.email ? <EmailLink email={e.email} /> : "—"}</td>
                <td className="px-3 py-3 text-right font-mono text-[13px]">{money(Number(e.hourly_rate))}<div className="font-body text-[10px] text-muted-foreground">{e.pay_type === "salary" ? "salary" : "hourly"}</div></td>
                <td className="py-3 pl-3 pr-6">
                  <div className="flex justify-end gap-3.5 text-muted-foreground">
                    <Link to="/employees/$id" params={{ id: e.id }} aria-label={`Edit ${fullName(e)}`} title="Edit profile"><Pencil className="h-4 w-4 hover:text-foreground" /></Link>
                    <button onClick={() => remove(e.id)} aria-label="Delete"><Trash2 className="h-4 w-4 hover:text-destructive" /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
        {isFiltering(q) && list.length > 0 && <div className="border-t border-border px-5 py-2 text-xs text-muted-foreground">Showing {list.length} of {employees.length}</div>}
      </div>
    </AppShell>
  );
}

// ---------------------------------------------------------------- bulk edit

type RateMode = "set" | "pct" | "add";
const textFields = [
  { key: "department", label: "Department", max: 80 },
  { key: "job_title", label: "Position / job title", max: 80 },
  { key: "gender", label: "Gender", max: 80 },
  { key: "nationality", label: "Nationality", max: 80 },
  { key: "residential_status", label: "Residential status", max: 80 },
  { key: "city", label: "City", max: 80 },
  { key: "state", label: "State / region", max: 80 },
] as const;

/** Changes only the fields that are ticked, on every selected employee. */
function BulkEditPanel({ employees, defs, shifts, onClose, onDone }: { employees: Employee[]; defs: FieldDef[]; shifts: Shift[]; onClose: () => void; onDone: () => void }) {
  // Private fields can't be written to the cloud, so they aren't offered when editing it directly.
  const { data: privateKeys = [] } = usePrivateFields();
  const hidden = useDataMode() === "cloud" ? privateKeys : [];
  const fields = textFields.filter((f) => !hidden.includes(f.key));
  const editableDefs = defs.filter((d) => !hidden.includes(customKey(d.id)));
  const [on, setOn] = useState<Record<string, boolean>>({});
  const [vals, setVals] = useState<Record<string, string>>({});
  const [rateMode, setRateMode] = useState<RateMode>("set");
  const { data: rateHistory } = usePayRates();
  const [active, setActive] = useState(true);
  const [shiftId, setShiftId] = useState(shifts[0]?.id ?? "");
  const [payType, setPayType] = useState("hourly");
  const [busy, setBusy] = useState(false);

  const tick = (k: string) => (
    <input type="checkbox" checked={!!on[k]} onChange={(e) => setOn({ ...on, [k]: e.target.checked })} aria-label={`Change ${k}`} />
  );
  const val = (k: string) => vals[k] ?? "";
  const setVal = (k: string, v: string) => { setVals({ ...vals, [k]: v }); setOn((o) => ({ ...o, [k]: true })); };

  const rateNum = Number(val("rate"));
  const newRate = (e: Employee) => {
    const cur = Number(e.hourly_rate);
    const r = rateMode === "set" ? rateNum : rateMode === "pct" ? cur * (1 + rateNum / 100) : cur + rateNum;
    return Math.round(r * 100) / 100;
  };

  const changes: string[] = [];
  for (const f of fields) if (on[f.key]) changes.push(val(f.key).trim() ? `${f.label} → “${val(f.key).trim()}”` : `clear ${f.label}`);
  if (on["rate"]) changes.push(rateMode === "set" ? `rate → ${money(rateNum || 0)}` : rateMode === "pct" ? `rate ${rateNum >= 0 ? "+" : ""}${rateNum || 0}%` : `rate ${rateNum >= 0 ? "+" : "−"}${money(Math.abs(rateNum || 0))}`);
  if (on["active"]) changes.push(active ? "mark active" : "mark resigned");
  if (on["pay_type"]) changes.push(`pay type → ${payType === "salary" ? "salary" : "hourly"}`);
  if (on["shift"]) changes.push(`shift → ${shifts.find((s) => s.id === shiftId)?.name ?? "?"}`);
  for (const d of editableDefs) if (on[`custom:${d.id}`]) changes.push(val(`custom:${d.id}`).trim() ? `${d.label} → “${val(`custom:${d.id}`).trim()}”` : `clear ${d.label}`);

  const apply = async () => {
    if (on["rate"]) {
      if (val("rate").trim() === "" || !Number.isFinite(rateNum)) { toast.error("Enter a number for the hourly rate"); return; }
      const bad = employees.find((e) => newRate(e) < 0 || newRate(e) > 10000);
      if (bad) { toast.error(`That would make ${fullName(bad)}'s rate ${money(newRate(bad))}. Rates must be between $0 and $10,000.`); return; }
    }
    // New rates: ask from which day, and keep everyone's old rate for the days before.
    const ratePlans = new Map<string, RatePlan>();
    if (on["rate"]) {
      const changed = employees.filter((e) => newRate(e) !== Number(e.hourly_rate));
      if (changed.length) {
        const when = await askRateDate(`New hourly rate for ${changed.length} employee${changed.length === 1 ? "" : "s"}`, "their current rates", null);
        if (!when) return;
        for (const e of changed) ratePlans.set(e.id, planRateChange(rateHistory?.get(e.id) ?? [], Number(e.hourly_rate), newRate(e), when));
      }
    }
    const rows = employees.map((e) => {
      const patch: Record<string, unknown> = {};
      for (const f of fields) if (on[f.key]) patch[f.key] = val(f.key).trim().slice(0, f.max) || null;
      if (on["rate"]) patch["hourly_rate"] = ratePlans.get(e.id)?.current ?? newRate(e);
      if (on["active"]) patch["active"] = active;
      if (on["shift"]) patch["shift_id"] = shiftId;
      if (on["pay_type"]) patch["pay_type"] = payType;
      const custom = { ...((e.custom_fields ?? {}) as Record<string, string>) };
      let customChanged = false;
      for (const d of editableDefs) {
        const k = `custom:${d.id}`;
        if (!on[k]) continue;
        customChanged = true;
        const v = val(k).trim().slice(0, 1000);
        if (v) custom[d.id] = v; else delete custom[d.id];
      }
      if (customChanged) patch["custom_fields"] = custom;
      return { id: e.id, patch };
    });
    setBusy(true);
    try {
      await backupBefore("bulk-edit");
      for (const [id, plan] of ratePlans) {
        const err = await writeRateHistory(id, plan);
        if (err) { toast.error(`Stopped partway: ${err}. A backup was saved in Sync & backup.`); onDone(); return; }
      }
      const { error, updated } = await db().updateMany("employees", rows as never);
      if (error) { toast.error(error.message); if (updated) onDone(); return; }
      toast.success(`Updated ${updated} employee${updated === 1 ? "" : "s"}. A backup was saved in Sync & backup.`);
      onDone();
    } catch (e) {
      toast.error(`Nothing was changed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const row = (k: string, label: string, control: React.ReactNode) => (
    <label key={k} className={`flex items-center gap-3 rounded-xl p-2 ring-1 ${on[k] ? "bg-accent/50 ring-primary/25" : "ring-border"}`}>
      {tick(k)}
      <span className="w-40 shrink-0 text-sm"><EditableLabel k={k === "rate" ? "hourly_rate" : k} name={label} /></span>
      <div className="min-w-0 flex-1">{control}</div>
    </label>
  );

  return (
    <div className="glass-panel space-y-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-display font-extrabold tracking-tight">Edit {employees.length} employees</div>
          <p className="text-xs text-muted-foreground">
            Tick what to change. Unticked fields stay as they are for each person; a ticked field left empty is cleared.
            {" "}{employees.slice(0, 6).map(fullName).join(", ")}{employees.length > 6 ? ` and ${employees.length - 6} more` : ""}.
          </p>
        </div>
        <button onClick={onClose} className={btnGhost} aria-label="Close"><X className="h-4 w-4" /></button>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {fields.map((f) => row(f.key, f.label, <input className={inputCls} value={val(f.key)} onChange={(e) => setVal(f.key, e.target.value)} placeholder="New value" />))}
        {row("rate", "Hourly rate", (
          <div className="flex gap-2">
            <select className={`${inputCls} w-auto`} value={rateMode} onChange={(e) => { setRateMode(e.target.value as RateMode); setOn((o) => ({ ...o, rate: true })); }}>
              <option value="set">Set to $</option>
              <option value="pct">Change by %</option>
              <option value="add">Change by $</option>
            </select>
            <input className={inputCls} type="number" step="0.01" value={val("rate")} onChange={(e) => setVal("rate", e.target.value)} placeholder={rateMode === "set" ? "25.00" : rateMode === "pct" ? "5 or -5" : "1.50 or -1.50"} />
          </div>
        ))}
        {row("active", "Status", (
          <select className={inputCls} value={active ? "1" : "0"} onChange={(e) => { setActive(e.target.value === "1"); setOn((o) => ({ ...o, active: true })); }}>
            <option value="1">Active</option>
            <option value="0">Resigned</option>
          </select>
        ))}
        {row("pay_type", "Pay type", (
          <select className={inputCls} value={payType} onChange={(e) => { setPayType(e.target.value); setOn((o) => ({ ...o, pay_type: true })); }}>
            {PAY_TYPES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        ))}
        {shifts.length > 0 && row("shift", "Shift", (
          <select className={inputCls} value={shiftId} onChange={(e) => { setShiftId(e.target.value); setOn((o) => ({ ...o, shift: true })); }}>
            {shifts.map((s) => <option key={s.id} value={s.id}>{s.name}{Number(s.multiplier) !== 1 ? ` (×${Number(s.multiplier)})` : ""}</option>)}
          </select>
        ))}
        {editableDefs.map((d) => row(`custom:${d.id}`, d.label, <div><CategoryInput type={d.field_type} className={`${inputCls} w-full`} value={val(`custom:${d.id}`)} onChange={(v) => setVal(`custom:${d.id}`, v)} placeholder="New value" /></div>))}
      </div>
      {on["rate"] && val("rate").trim() !== "" && Number.isFinite(rateNum) && (
        <div className="text-xs text-muted-foreground">
          New rates: {employees.slice(0, 5).map((e) => `${fullName(e)} ${money(Number(e.hourly_rate))} → ${money(newRate(e))}`).join(" · ")}{employees.length > 5 ? " · …" : ""}
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">{changes.length ? changes.join(" · ") : "Nothing ticked yet."}</div>
        <button onClick={apply} disabled={!changes.length || busy} className={btnPrimary}>{busy ? "Saving…" : `Apply to ${employees.length}`}</button>
      </div>
    </div>
  );
}
