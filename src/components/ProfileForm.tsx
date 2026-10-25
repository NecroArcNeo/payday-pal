import { useEffect, useState } from "react";
import { btnPrimary, inputCls } from "@/components/AppShell";
import { AddCategory, CategoryLabel, SectionHeading } from "@/components/ProfileCategories";
import { useFieldDefs, useShifts, type Employee } from "@/lib/payroll";
import { PAY_TYPES, shiftFor } from "@/lib/pay";
import { fieldSuggestions, PER_PERSON_FIELDS, profileSections } from "@/lib/employee-fields";

export type ProfileValues = { form: Record<string, string>; custom: Record<string, string> };

const asText = (o: Record<string, unknown> | null | undefined) => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o ?? {})) if (typeof v !== "object" || v === null) out[k] = v == null ? "" : String(v);
  return out;
};

/** Form values for an employee row or the default profile (custom_fields split out). */
export function profileValues(row: Record<string, unknown>): ProfileValues {
  return { form: asText(row), custom: asText(row["custom_fields"] as Record<string, unknown>) };
}

/**
 * The profile page's form. `template` shows the default profile: the same
 * layout, with the per-person fields (ID and name) locked.
 */
export function ProfileForm({ source, employees, template, submitLabel, onSave }: {
  /** Reloads the form whenever this changes. */
  source: ProfileValues | null;
  employees: Employee[];
  template?: boolean;
  submitLabel: string;
  onSave: (v: ProfileValues) => void | Promise<void>;
}) {
  const [form, setForm] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const { data: defs = [] } = useFieldDefs();
  const { data: shifts = [] } = useShifts();

  useEffect(() => {
    if (!source) return;
    setForm(source.form);
    setCustom(source.custom);
  }, [source]);

  const submit = (e: React.FormEvent) => { e.preventDefault(); onSave({ form, custom }); };

  return (
    <form onSubmit={submit} className="space-y-5">
      {profileSections(defs).filter((s) => s.fields.length || s.defs.length).map((s) => (
        <div key={s.title} className="glass-panel p-5">
          {s.custom ? <SectionHeading title={s.title} /> : <div className="mb-4 font-display font-extrabold tracking-tight">{s.title}</div>}
          <div className="grid gap-3 md:grid-cols-3">
            {s.fields.map((f) => {
              const locked = template && PER_PERSON_FIELDS.includes(f.k);
              return (
                <label key={f.k} className={f.span ? "md:col-span-3" : ""}>
                  <span className="label-mono">{f.label}</span>
                  <input className={`${inputCls} mt-1 disabled:opacity-60`} type={f.type ?? "text"} step={f.type === "number" ? "0.01" : undefined}
                    disabled={locked} title={locked ? "Entered for each employee" : undefined}
                    list={f.suggest ? `suggest-${f.k}` : undefined} placeholder={locked ? "Set for each employee" : f.suggest ? "Pick or type your own" : undefined}
                    value={locked ? "" : form[f.k] ?? ""} onChange={(e) => setForm({ ...form, [f.k]: e.target.value })} />
                  {f.suggest && <datalist id={`suggest-${f.k}`}>{fieldSuggestions(f.k, employees).map((v) => <option key={v} value={v} />)}</datalist>}
                </label>
              );
            })}
            {s.title === "Payroll" && (
              <label title="Salary pays a full week (the overtime threshold, 40 h) at the hourly rate for every week with time records, however many hours were worked, and never overtime.">
                <span className="label-mono">Pay type</span>
                <select className={`${inputCls} mt-1`} value={form["pay_type"] === "salary" ? "salary" : "hourly"} onChange={(e) => setForm({ ...form, pay_type: e.target.value })}>
                  {PAY_TYPES.map((p) => <option key={p.value} value={p.value}>{p.label}{p.value === "salary" ? " (40 h a week)" : ""}</option>)}
                </select>
              </label>
            )}
            {s.title === "Payroll" && (
              <label title="Resigned employees keep their records but aren't offered when adding new hours.">
                <span className="label-mono">Status</span>
                <select className={`${inputCls} mt-1`} value={form["active"] === "false" ? "false" : "true"} onChange={(e) => setForm({ ...form, active: e.target.value })}>
                  <option value="true">Active</option>
                  <option value="false">Resigned</option>
                </select>
              </label>
            )}
            {s.title === "Payroll" && (
              <label>
                <span className="label-mono">Shift</span>
                <select className={`${inputCls} mt-1`} value={shiftFor(form["shift_id"], shifts).id ?? ""} onChange={(e) => setForm({ ...form, shift_id: e.target.value })}>
                  {shifts.map((x) => <option key={x.id} value={x.id}>{x.name}{Number(x.multiplier) !== 1 ? ` (×${Number(x.multiplier)} rate)` : ""}</option>)}
                  {shifts.length === 0 && <option value="">Day</option>}
                </select>
              </label>
            )}
            {s.defs.map((d) => (
              <label key={d.id}>
                <CategoryLabel id={d.id} label={d.label} section={d.section} />
                <input className={`${inputCls} mt-1`} type={d.field_type} value={custom[d.id] ?? ""} onChange={(e) => setCustom({ ...custom, [d.id]: e.target.value })} />
              </label>
            ))}
          </div>
        </div>
      ))}
      <div className="glass-panel p-5">
        <div className="mb-1 font-display font-extrabold tracking-tight">Add a category</div>
        <p className="mb-4 text-xs text-muted-foreground">
          Categories show up on every employee's profile, in the section you pick. Pick "New section…" to make your own section.
          On a category, click its name to rename it, or its section to move it.
        </p>
        <AddCategory />
      </div>
      <div className="glass-panel p-5">
        <div className="mb-4 font-display font-extrabold tracking-tight">Notes</div>
        <textarea rows={4} className={inputCls} value={form["notes"] ?? ""} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Anything else worth keeping…" />
      </div>
      <button className={btnPrimary}>{submitLabel}</button>
    </form>
  );
}
