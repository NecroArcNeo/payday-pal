import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { db } from "@/lib/db/mode";
import { backupBefore } from "@/lib/db/safety";
import { btnPrimary, inputCls } from "@/components/AppShell";
import { EmailLink } from "@/components/EmailLink";
import { fullName, useEmployees, useFieldDefs, type FieldDef } from "@/lib/payroll";
import { OTHER_SECTION, sectionNames } from "@/lib/employee-fields";
import { FIELD_TYPES, fieldType, fieldTypeLabel, fitsType, formatValue, toType } from "@/lib/field-types";
import { EditableLabel } from "@/components/EditableLabel";
import { useLabels } from "@/lib/labels";
import { customKey } from "@/lib/db/privacy";
import { Plus, Trash2, TriangleAlert } from "lucide-react";

const NEW_SECTION = "\u0000new";
const cleanSection = (s: string | null | undefined) => {
  const v = s?.trim() ?? "";
  return !v || v.toLowerCase() === OTHER_SECTION.toLowerCase() ? null : v;
};

/** Add / rename / move / remove the custom categories (employee_field_defs) every profile shares, and their sections. */
export function useCategoryActions() {
  const qc = useQueryClient();
  const { data: defs = [] } = useFieldDefs();
  const { data: employees = [] } = useEmployees();
  const refresh = () => qc.invalidateQueries({ queryKey: ["field-defs"] });

  const add = async (raw: string, fieldType: string, section: string | null) => {
    const label = raw.trim();
    if (!label) return false;
    if (label.length > 60) { toast.error("Keep the category name under 60 characters"); return false; }
    const { error } = await db().insert("employee_field_defs", { label, field_type: fieldType, section: cleanSection(section), sort_order: defs.length });
    if (error) { toast.error(error.message); return false; }
    toast.success(`"${label}" added for every employee`);
    refresh();
    return true;
  };
  const move = async (defId: string, section: string | null) => {
    const { error } = await db().update("employee_field_defs", defId, { section: cleanSection(section) });
    if (error) toast.error(error.message); else refresh();
  };
  const remove = async (defId: string, label: string) => {
    if (!confirm(`Remove the "${label}" category for all employees?`)) return;
    const { error } = await db().remove("employee_field_defs", defId);
    if (error) toast.error(error.message); else refresh();
  };
  /**
   * Changes a category's type. Values that convert cleanly ("$12" → 12, "Y" → yes) are rewritten after a backup;
   * values that don't fit are kept as they are and flagged on the profile, after the user confirms.
   */
  const changeType = async (def: FieldDef, type: string) => {
    if (fieldType(def.field_type) === type) return;
    const values = employees.flatMap((e) => {
      const v = ((e.custom_fields ?? {}) as Record<string, unknown>)[def.id];
      return v === undefined || v === null || v === "" ? [] : [{ e, from: String(v), to: toType(type, String(v)) }];
    });
    const bad = values.filter((x) => !fitsType(type, x.to));
    if (bad.length) {
      const eg = bad.slice(0, 3).map((x) => `${fullName(x.e)}: "${x.from}"`).join(", ");
      const what = bad.length === 1 ? "employee has a value that isn't" : "employees have values that aren't";
      if (!confirm(`${bad.length} ${what} a valid ${fieldTypeLabel(type)} (${eg}${bad.length > 3 ? ", …" : ""}).\n\nThey'll be kept as they are and marked on each profile so you can fix them. Change "${def.label}" to ${fieldTypeLabel(type)}?`)) return;
    }
    const convert = values.filter((x) => x.to !== x.from && fitsType(type, x.to));
    if (convert.length) {
      try {
        await backupBefore("bulk-edit");
      } catch (e) {
        toast.error(`Nothing was changed: ${(e as Error).message}`);
        return;
      }
      const { error } = await db().updateMany("employees", convert.map((x) => ({
        id: x.e.id, patch: { custom_fields: { ...((x.e.custom_fields ?? {}) as Record<string, unknown>), [def.id]: x.to } },
      })) as never);
      if (error) { toast.error(error.message); return; }
      qc.invalidateQueries({ queryKey: ["employees"] });
    }
    const { error } = await db().update("employee_field_defs", def.id, { field_type: type });
    if (error) { toast.error(error.message); return; }
    toast.success(`"${def.label}" is now ${fieldTypeLabel(type)}${convert.length ? ` · ${convert.length} value${convert.length === 1 ? "" : "s"} converted (backup saved)` : ""}`);
    refresh();
  };
  const inSection = (name: string) => defs.filter((d) => d.section?.trim().toLowerCase() === name.toLowerCase());
  const renameSection = async (from: string, to: string) => {
    const name = to.trim();
    if (!name || name === from) return;
    if (name.length > 60) { toast.error("Keep the section name under 60 characters"); return; }
    const { error } = await db().updateMany("employee_field_defs", inSection(from).map((d) => ({ id: d.id, patch: { section: cleanSection(name) } })));
    if (error) toast.error(error.message); else refresh();
  };
  /** Removes a user-made section; its categories (and their values) move to Other details. */
  const removeSection = async (name: string) => {
    const list = inSection(name);
    if (!confirm(`Remove the "${name}" section? Its ${list.length} categor${list.length === 1 ? "y moves" : "ies move"} to ${OTHER_SECTION}, keeping every employee's values.`)) return;
    const { error } = await db().updateMany("employee_field_defs", list.map((d) => ({ id: d.id, patch: { section: null } })));
    if (error) toast.error(error.message); else refresh();
  };
  return { defs, add, move, changeType, remove, renameSection, removeSection };
}

/** Asks for a new section's name. Null when cancelled. */
function askSectionName() {
  const name = prompt("Name the new section, e.g. Uniform or Certifications")?.trim();
  if (!name) return null;
  if (name.length > 60) { toast.error("Keep the section name under 60 characters"); return null; }
  return name;
}

/** Built-in sections, the user's own, Other details, and "New section…". Value null = Other details. */
export function SectionSelect({ value, onChange, className, extra = [] }: {
  value: string | null; onChange: (section: string | null) => void; className?: string; extra?: string[];
}) {
  const { defs } = useCategoryActions();
  const { label } = useLabels();
  const names = [...new Set([...sectionNames(defs), ...extra])];
  const current = value && names.find((n) => n.toLowerCase() === value.toLowerCase());
  return (
    <select className={className} value={current || ""} aria-label="Section"
      onChange={(e) => {
        if (e.target.value !== NEW_SECTION) { onChange(e.target.value || null); return; }
        const name = askSectionName();
        if (name) onChange(name);
      }}>
      {names.map((n) => <option key={n} value={n}>{label(`section:${n}`, n)}</option>)}
      <option value="">{label(`section:${OTHER_SECTION}`, OTHER_SECTION)}</option>
      <option value={NEW_SECTION}>New section…</option>
    </select>
  );
}

/** A category's name (click to give it an alias), its type, the section it shows under, and a remove button, used as a field's label. */
export function CategoryLabel({ def }: { def: FieldDef }) {
  const { id, section } = def;
  const { move, changeType, remove } = useCategoryActions();
  const label = useLabels().label(customKey(id), def.label);
  return (
    <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
      <span className="min-w-0 flex-1 truncate"><EditableLabel k={customKey(id)} name={def.label} className="label-mono" /></span>
      <TypeSelect value={fieldType(def.field_type)} onChange={(t) => changeType(def, t)} title="What kind of value this category holds"
        className="max-w-[5.5rem] cursor-pointer truncate rounded bg-transparent text-[10px] text-muted-foreground outline-none hover:text-foreground" />
      <SectionSelect value={section} onChange={(s) => move(id, s)}
        className="max-w-[7rem] cursor-pointer truncate rounded bg-transparent text-[10px] text-muted-foreground outline-none hover:text-foreground" />
      <button type="button" onClick={() => remove(id, label)} aria-label={`Remove ${label}`} className="text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
    </span>
  );
}

/** A user-made section's heading: rename it in place, or remove it (its categories move to Other details). */
export function SectionHeading({ title }: { title: string }) {
  const { renameSection, removeSection } = useCategoryActions();
  return (
    <div className="mb-4 flex items-center justify-between gap-2">
      <input key={title} className="min-w-0 flex-1 bg-transparent font-display font-extrabold tracking-tight outline-none" defaultValue={title}
        onBlur={(e) => { if (e.target.value.trim() !== title) renameSection(title, e.target.value); }} aria-label="Section name" title="Click to rename" />
      <button type="button" onClick={() => removeSection(title)} aria-label={`Remove section ${title}`} title="Remove this section" className="text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
    </div>
  );
}

export function AddCategory() {
  const { add } = useCategoryActions();
  const [label, setLabel] = useState("");
  const [type, setType] = useState("text");
  const [section, setSection] = useState<string | null>(null);
  const submit = async () => { if (await add(label, type, section)) setLabel(""); };
  return (
    <div className="flex flex-wrap gap-2">
      <input className={`${inputCls} max-w-xs`} placeholder="New category, e.g. T-shirt size" value={label} onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }} />
      <TypeSelect value={type} onChange={setType} className={`${inputCls} max-w-[9rem]`} />
      {/* A new section exists once a category is in it, so offer the one being typed until then. */}
      <SectionSelect value={section} onChange={setSection} extra={section ? [section] : []} className={`${inputCls} max-w-[12rem]`} />
      <button type="button" onClick={submit} className={btnPrimary}><Plus className="mr-1 inline h-4 w-4" />Add category</button>
    </div>
  );
}

export function TypeSelect({ value, onChange, className, title }: { value: string; onChange: (type: string) => void; className?: string; title?: string }) {
  return (
    <select className={className} value={value} onChange={(e) => onChange(e.target.value)} aria-label="Type" title={title}>
      {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
    </select>
  );
}

const badValue = (type: string | null | undefined) => `Not a valid ${fieldTypeLabel(type).toLowerCase()}. Fix or clear it.`;

/** The input for a category value, matching its type. A stored value that doesn't fit is edited as text so it's never hidden. */
export function CategoryInput({ type, value, onChange, className = "", placeholder, disabled }: {
  type: string | null | undefined; value: string; onChange: (v: string) => void; className?: string; placeholder?: string; disabled?: boolean;
}) {
  const t = fieldType(type);
  const fits = fitsType(t, value);
  const common = { className, value, placeholder, disabled, onChange: (e: { target: { value: string } }) => onChange(e.target.value) };
  let input: React.ReactNode;
  if (t === "yesno" && fits) {
    input = <select {...common}><option value="">—</option><option value="yes">Yes</option><option value="no">No</option></select>;
  } else if (t === "longtext") {
    input = <textarea rows={2} {...common} />;
  } else {
    // Browsers blank out a number/date/time input holding anything else, so a mismatched value is edited as text.
    const html = !fits || t === "yesno" || t === "text" ? "text" : t === "money" || t === "number" ? "number" : t;
    input = <input {...common} type={html} step={t === "money" ? "0.01" : t === "number" ? "any" : undefined}
      onBlur={(e) => { const v = toType(t, e.target.value); if (v !== e.target.value) onChange(v); }} />;
  }
  return (
    <>
      {input}
      {!fits && <span className="mt-1 flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"><TriangleAlert className="h-3.5 w-3.5" />{badValue(t)}</span>}
    </>
  );
}

/** A category value for reading: emails, links and phones are clickable; money and yes/no are formatted. */
export function CategoryValue({ type, value }: { type: string | null | undefined; value: string }) {
  if (!value) return null;
  const t = fieldType(type);
  if (!fitsType(t, value)) {
    return <span title={badValue(t)}>{value}<TriangleAlert className="ml-1 inline h-3.5 w-3.5 align-[-2px] text-amber-500 print:hidden" aria-label={badValue(t)} /></span>;
  }
  const link = "text-primary underline-offset-2 hover:underline print:text-foreground";
  if (t === "email") return <EmailLink email={value} />;
  if (t === "url") return <a href={value} target="_blank" rel="noreferrer noopener" className={link}>{value.replace(/^https?:\/\//, "")}</a>;
  if (t === "tel") return <a href={`tel:${value.replace(/[^\d+]/g, "")}`} className={link}>{value}</a>;
  return <>{formatValue(t, value)}</>;
}
