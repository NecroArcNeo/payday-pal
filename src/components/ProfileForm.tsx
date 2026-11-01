import { useEffect, useState } from "react";
import { btnPrimary, inputCls } from "@/components/AppShell";
import { AddCategory, CategoryInput, CategoryLabel, SectionHeading } from "@/components/ProfileCategories";
import { EmailButton } from "@/components/EmailLink";
import { EditableLabel } from "@/components/EditableLabel";
import { useFieldDefs, usePrivateFields, useShifts, type Employee } from "@/lib/payroll";
import { PAY_TYPES, shiftFor } from "@/lib/pay";
import { fieldSuggestions, PER_PERSON_FIELDS, profileSections } from "@/lib/employee-fields";
import { useDataMode } from "@/lib/db/mode";
import { customKey } from "@/lib/db/privacy";
import { Lock } from "lucide-react";
import { DateInput } from "@/components/DateInput";

/** Marks a private field. In cloud mode it can't be edited, since the cloud never stores it. */
function PrivateMark({ cloud }: { cloud: boolean }) {
  const why = cloud ? "Private: kept on your device only, so it can't be edited in the cloud. Switch to this device's data in Sync & backup." : "Private: stays on this device and is never synced to the cloud";
  return <span title={why} className="inline-flex shrink-0"><Lock className="h-3 w-3 text-muted-foreground" aria-label={why} /></span>;
}

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
  const { data: privateKeys = [] } = usePrivateFields();
  const cloud = useDataMode() === "cloud";
  const isPrivate = (k: string) => privateKeys.includes(k);

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
          {s.custom ? <SectionHeading title={s.title} /> : <div className="mb-4 font-display font-extrabold tracking-tight"><EditableLabel k={`section:${s.title}`} name={s.title} /></div>}
          <div className="grid gap-3 md:grid-cols-3">
            {s.fields.map((f) => {
              const locked = template && PER_PERSON_FIELDS.includes(f.k);
              const privateHere = isPrivate(f.k);
              const off = locked || (cloud && privateHere);
              return (
                <label key={f.k} className={f.span ? "md:col-span-3" : ""}>
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="label-mono flex items-center gap-1"><EditableLabel k={f.k} name={f.label} />{privateHere && <PrivateMark cloud={cloud} />}</span>
                    {f.type === "email" && <EmailButton email={form[f.k] ?? ""} />}
                  </span>
                  {f.type === "date" ? (
                    <DateInput className={`${inputCls} mt-1 disabled:opacity-60`} disabled={off}
                      title={locked ? "Entered for each employee" : off ? "Private: edit it on this device's data" : undefined}
                      placeholder={locked ? "Set for each employee" : off ? "Private, kept on your device" : undefined}
                      value={locked ? "" : form[f.k] ?? ""} onChange={(v) => setForm({ ...form, [f.k]: v })} />
                  ) : (
                    <input className={`${inputCls} mt-1 disabled:opacity-60`} type={f.type ?? "text"} step={f.type === "number" ? "0.01" : undefined}
                      disabled={off} title={locked ? "Entered for each employee" : off ? "Private: edit it on this device's data" : undefined}
                      list={f.suggest ? `suggest-${f.k}` : undefined} placeholder={locked ? "Set for each employee" : off ? "Private, kept on your device" : f.suggest ? "Pick or type your own" : undefined}
                      value={locked ? "" : form[f.k] ?? ""} onChange={(e) => setForm({ ...form, [f.k]: e.target.value })} />
                  )}
                  {f.suggest && <datalist id={`suggest-${f.k}`}>{fieldSuggestions(f.k, employees).map((v) => <option key={v} value={v} />)}</datalist>}
                </label>
              );
            })}
            {s.title === "Payroll" && (
              <label title="Salary pays a full week (the overtime threshold, 40 h) at the hourly rate for every week with time records, however many hours were worked, and never overtime.">
                <span className="label-mono"><EditableLabel k="pay_type" name="Pay type" /></span>
                <select className={`${inputCls} mt-1`} value={form["pay_type"] === "salary" ? "salary" : "hourly"} onChange={(e) => setForm({ ...form, pay_type: e.target.value })}>
                  {PAY_TYPES.map((p) => <option key={p.value} value={p.value}>{p.label}{p.value === "salary" ? " (40 h a week)" : ""}</option>)}
                </select>
              </label>
            )}
            {s.title === "Payroll" && (
              <label title="Resigned employees keep their records but aren't offered when adding new hours.">
                <span className="label-mono"><EditableLabel k="active" name="Status" /></span>
                <select className={`${inputCls} mt-1`} value={form["active"] === "false" ? "false" : "true"} onChange={(e) => setForm({ ...form, active: e.target.value })}>
                  <option value="true">Active</option>
                  <option value="false">Resigned</option>
                </select>
              </label>
            )}
            {s.title === "Payroll" && (
              <label>
                <span className="label-mono"><EditableLabel k="shift" name="Shift" /></span>
                <select className={`${inputCls} mt-1`} value={shiftFor(form["shift_id"], shifts).id ?? ""} onChange={(e) => setForm({ ...form, shift_id: e.target.value })}>
                  {shifts.map((x) => <option key={x.id} value={x.id}>{x.name}{Number(x.multiplier) !== 1 ? ` (×${Number(x.multiplier)} rate)` : ""}</option>)}
                  {shifts.length === 0 && <option value="">Day</option>}
                </select>
              </label>
            )}
            {s.defs.map((d) => (
              <label key={d.id}>
                <span className="flex items-baseline justify-between gap-2">
                  {isPrivate(customKey(d.id)) && <PrivateMark cloud={cloud} />}
                  <CategoryLabel def={d} />
                  {d.field_type === "email" && <EmailButton email={custom[d.id] ?? ""} />}
                </span>
                <CategoryInput type={d.field_type} className={`${inputCls} mt-1 disabled:opacity-60`} disabled={cloud && isPrivate(customKey(d.id))}
                  value={custom[d.id] ?? ""} onChange={(v) => setCustom({ ...custom, [d.id]: v })} />
              </label>
            ))}
          </div>
        </div>
      ))}
      <div className="glass-panel p-5">
        <div className="mb-1 font-display font-extrabold tracking-tight">Add a category</div>
        <p className="mb-4 text-xs text-muted-foreground">
          Categories show up on every employee's profile, in the section you pick. Pick "New section…" to make your own section.
          Click any field's name to give it your own name (clear it to get the original back), or a category's section to move it.
        </p>
        <AddCategory />
      </div>
      <div className="glass-panel p-5">
        <div className="mb-4 flex items-center gap-1.5 font-display font-extrabold tracking-tight"><EditableLabel k="notes" name="Notes" />{isPrivate("notes") && <PrivateMark cloud={cloud} />}</div>
        <textarea rows={4} className={`${inputCls} disabled:opacity-60`} disabled={cloud && isPrivate("notes")} value={form["notes"] ?? ""} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Anything else worth keeping…" />
      </div>
      <button className={btnPrimary}>{submitLabel}</button>
    </form>
  );
}
