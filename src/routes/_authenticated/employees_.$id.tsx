import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { localDb } from "@/lib/local-db";
import { AppShell, btnPrimary, inputCls } from "@/components/AppShell";
import { fullName, useEmployees, useFieldDefs } from "@/lib/payroll";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/employees_/$id")({
  head: () => ({ meta: [{ title: "Employee profile — Meridian Payroll" }] }),
  component: ProfilePage,
  notFoundComponent: () => <div className="p-8">Employee not found.</div>,
  errorComponent: ({ error }) => <div className="p-8">{(error as Error).message}</div>,
});

type Field = { k: string; label: string; type?: string; span?: boolean };
const sections: { title: string; fields: Field[] }[] = [
  { title: "Payroll", fields: [
    { k: "employee_code", label: "Employee ID" }, { k: "first_name", label: "First name" }, { k: "last_name", label: "Last name" },
    { k: "hourly_rate", label: "Hourly rate", type: "number" }, { k: "department", label: "Department" }, { k: "job_title", label: "Job title" },
  ] },
  { title: "Contact", fields: [
    { k: "email", label: "Email", type: "email" }, { k: "phone", label: "Phone", type: "tel" },
    { k: "date_of_birth", label: "Date of birth", type: "date" }, { k: "hire_date", label: "Hire date", type: "date" },
  ] },
  { title: "Address", fields: [
    { k: "address_line1", label: "Street address", span: true }, { k: "address_line2", label: "Apt / suite", span: true },
    { k: "city", label: "City" }, { k: "state", label: "State / region" }, { k: "postal_code", label: "Postal code" }, { k: "country", label: "Country" },
  ] },
  { title: "Emergency contact", fields: [
    { k: "emergency_contact_name", label: "Name" }, { k: "emergency_contact_phone", label: "Phone", type: "tel" },
  ] },
];
const required = ["employee_code", "first_name", "last_name"];

function ProfilePage() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const { data: employees = [], isLoading } = useEmployees();
  const emp = employees.find((e) => e.id === id);
  const [form, setForm] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const { data: defs = [] } = useFieldDefs();
  const [newLabel, setNewLabel] = useState("");
  const [newType, setNewType] = useState("text");

  const addCategory = async () => {
    const label = newLabel.trim();
    if (!label) return;
    if (label.length > 60) { toast.error("Keep the category name under 60 characters"); return; }
    try { await localDb.insertFieldDef({ label, field_type: newType, sort_order: defs.length }); } catch (err) { toast.error((err as Error).message); return; }
    setNewLabel("");
    toast.success(`"${label}" added for every employee`);
    qc.invalidateQueries({ queryKey: ["field-defs"] });
  };
  const renameCategory = async (defId: string, label: string) => {
    if (!label.trim()) return;
    try { await localDb.updateFieldDef(defId, { label: label.trim() }); qc.invalidateQueries({ queryKey: ["field-defs"] }); } catch (err) { toast.error((err as Error).message); }
  };
  const removeCategory = async (defId: string, label: string) => {
    if (!confirm(`Remove the "${label}" category for all employees?`)) return;
    try { await localDb.deleteFieldDef(defId); qc.invalidateQueries({ queryKey: ["field-defs"] }); } catch (err) { toast.error((err as Error).message); }
  };

  useEffect(() => {
    if (!emp) return;
    const f: Record<string, string> = {};
    for (const [k, v] of Object.entries(emp)) f[k] = v == null ? "" : String(v);
    setForm(f);
    const c: Record<string, string> = {};
    const raw = (emp.custom_fields ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(raw)) c[k] = v == null ? "" : String(v);
    setCustom(c);
  }, [emp]);

  if (isLoading) return <AppShell eyebrow="Profile" title="Loading…"><div /></AppShell>;
  if (!emp) return <AppShell eyebrow="Profile" title="Not found"><Link to="/employees" className="underline">Back to employees</Link></AppShell>;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    for (const k of required) if (!form[k]?.trim()) { toast.error("Employee ID, first and last name are required"); return; }
    const rate = Number(form["hourly_rate"]);
    if (!Number.isFinite(rate) || rate < 0) { toast.error("Hourly rate must be a positive number"); return; }
    const row: Record<string, string | number | null> = {};
    for (const s of sections) for (const f of s.fields) row[f.k] = form[f.k]?.trim() || null;
    row["hourly_rate"] = rate;
    row["notes"] = form["notes"]?.trim() || null;
    const cf: Record<string, string> = {};
    for (const [k, v] of Object.entries(custom)) if (v.trim()) cf[k] = v.trim().slice(0, 1000);
    (row as Record<string, unknown>)["custom_fields"] = cf;
    try { await localDb.updateEmployee(id, { ...row, custom_fields: cf } as never); } catch (err) { toast.error((err as Error).message); return; }
    toast.success("Profile saved");
    qc.invalidateQueries({ queryKey: ["employees"] });
  };

  return (
    <AppShell eyebrow="Profile" title={fullName(emp)}>
      <Link to="/employees" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> All employees</Link>
      <form onSubmit={save} className="space-y-5">
        {sections.map((s) => (
          <div key={s.title} className="glass-panel p-5">
            <div className="mb-4 font-display font-extrabold tracking-tight">{s.title}</div>
            <div className="grid gap-3 md:grid-cols-3">
              {s.fields.map((f) => (
                <label key={f.k} className={f.span ? "md:col-span-3" : ""}>
                  <span className="label-mono">{f.label}</span>
                  <input className={`${inputCls} mt-1`} type={f.type ?? "text"} step={f.type === "number" ? "0.01" : undefined}
                    value={form[f.k] ?? ""} onChange={(e) => setForm({ ...form, [f.k]: e.target.value })} />
                </label>
              ))}
            </div>
          </div>
        ))}
        <div className="glass-panel p-5">
          <div className="mb-1 font-display font-extrabold tracking-tight">Your categories</div>
          <p className="mb-4 text-xs text-muted-foreground">Categories you add here show up on every employee's profile. Click a name to rename it.</p>
          <div className="grid gap-3 md:grid-cols-3">
            {defs.map((d) => (
              <label key={d.id}>
                <span className="flex items-center justify-between gap-2">
                  <input className="label-mono w-full bg-transparent outline-none" defaultValue={d.label}
                    onBlur={(e) => e.target.value !== d.label && renameCategory(d.id, e.target.value)} aria-label="Category name" />
                  <button type="button" onClick={() => removeCategory(d.id, d.label)} aria-label={`Remove ${d.label}`} className="text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
                </span>
                <input className={`${inputCls} mt-1`} type={d.field_type} value={custom[d.id] ?? ""} onChange={(e) => setCustom({ ...custom, [d.id]: e.target.value })} />
              </label>
            ))}
            {defs.length === 0 && <div className="text-sm text-muted-foreground md:col-span-3">No custom categories yet.</div>}
          </div>
          <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
            <input className={`${inputCls} max-w-xs`} placeholder="New category, e.g. T-shirt size" value={newLabel} onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCategory(); } }} />
            <select className={`${inputCls} max-w-[9rem]`} value={newType} onChange={(e) => setNewType(e.target.value)}>
              <option value="text">Text</option><option value="number">Number</option><option value="date">Date</option>
            </select>
            <button type="button" onClick={addCategory} className={btnPrimary}><Plus className="mr-1 inline h-4 w-4" />Add category</button>
          </div>
        </div>
        <div className="glass-panel p-5">
          <div className="mb-4 font-display font-extrabold tracking-tight">Notes</div>
          <textarea rows={4} className={inputCls} value={form["notes"] ?? ""} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Anything else worth keeping…" />
        </div>
        <button className={btnPrimary}>Save profile</button>
      </form>
    </AppShell>
  );
}
