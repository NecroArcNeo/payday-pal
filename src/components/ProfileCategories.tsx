import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { db } from "@/lib/db/mode";
import { btnPrimary, inputCls } from "@/components/AppShell";
import { useFieldDefs } from "@/lib/payroll";
import { OTHER_SECTION, sectionNames } from "@/lib/employee-fields";
import { Plus, Trash2 } from "lucide-react";

const NEW_SECTION = "\u0000new";
const cleanSection = (s: string | null | undefined) => {
  const v = s?.trim() ?? "";
  return !v || v.toLowerCase() === OTHER_SECTION.toLowerCase() ? null : v;
};

/** Add / rename / move / remove the custom categories (employee_field_defs) every profile shares, and their sections. */
export function useCategoryActions() {
  const qc = useQueryClient();
  const { data: defs = [] } = useFieldDefs();
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
  const rename = async (defId: string, label: string) => {
    if (!label.trim()) return;
    const { error } = await db().update("employee_field_defs", defId, { label: label.trim() });
    if (error) toast.error(error.message); else refresh();
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
  return { defs, add, rename, move, remove, renameSection, removeSection };
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
  const names = [...new Set([...sectionNames(defs), ...extra])];
  const current = value && names.find((n) => n.toLowerCase() === value.toLowerCase());
  return (
    <select className={className} value={current || ""} aria-label="Section"
      onChange={(e) => {
        if (e.target.value !== NEW_SECTION) { onChange(e.target.value || null); return; }
        const name = askSectionName();
        if (name) onChange(name);
      }}>
      {names.map((n) => <option key={n} value={n}>{n}</option>)}
      <option value="">{OTHER_SECTION}</option>
      <option value={NEW_SECTION}>New section…</option>
    </select>
  );
}

/** Editable category name, the section it shows under, and a remove button, used as a field's label. */
export function CategoryLabel({ id, label, section }: { id: string; label: string; section: string | null }) {
  const { rename, move, remove } = useCategoryActions();
  return (
    <span className="flex items-center justify-between gap-2">
      <input className="label-mono min-w-0 flex-1 bg-transparent outline-none" defaultValue={label}
        onBlur={(e) => e.target.value !== label && rename(id, e.target.value)} aria-label="Category name" title="Click to rename" />
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
      <select className={`${inputCls} max-w-[9rem]`} value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
        <option value="text">Text</option><option value="number">Number</option><option value="date">Date</option>
      </select>
      {/* A new section exists once a category is in it, so offer the one being typed until then. */}
      <SectionSelect value={section} onChange={setSection} extra={section ? [section] : []} className={`${inputCls} max-w-[12rem]`} />
      <button type="button" onClick={submit} className={btnPrimary}><Plus className="mr-1 inline h-4 w-4" />Add category</button>
    </div>
  );
}
