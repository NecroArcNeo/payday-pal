import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Lock } from "lucide-react";
import { useFieldDefs, usePrivateFields } from "@/lib/payroll";
import { EMPLOYEE_SECTIONS } from "@/lib/employee-fields";
import { useLabels } from "@/lib/labels";
import { ALWAYS_SYNCED, customKey, DEFAULT_SHARED, PERSONAL_DETAILS, PRIVATE_COLUMNS } from "@/lib/db/privacy";
import { localDb } from "@/lib/db/local";
import { setPrivateFields } from "@/lib/db/sync";
import { FoldBox } from "@/components/FoldBox";

/** Settings → Privacy: saves the ticked details as this device's private fields (privacy.ts). */
export function PrivateFieldsPanel() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const save = async (keys: string[]) => {
    setBusy(true);
    try {
      await setPrivateFields(await localDb(), keys);
      await qc.invalidateQueries();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return <PrivateFields busy={busy} onChange={(keys) => void save(keys)} />;
}

/** Ticks for the employee details that stay on this device and are never sent to the cloud. */
function PrivateFields({ busy, onChange }: { busy: boolean; onChange: (keys: string[]) => void }) {
  const { data: keys } = usePrivateFields();
  const { data: defs = [] } = useFieldDefs();
  const { label } = useLabels();
  if (!keys) return null;
  const groups = [
    ...EMPLOYEE_SECTIONS.map((s) => ({ title: label(`section:${s.title}`, s.title), items: s.fields.filter((f) => !ALWAYS_SYNCED.includes(f.k)).map((f) => ({ key: f.k, label: label(f.k, f.label) })) })),
    { title: "Other", items: [{ key: "notes", label: label("notes", "Notes") }, ...defs.map((d) => ({ key: customKey(d.id), label: label(customKey(d.id), d.label) }))] },
  ];
  const everything = [...PRIVATE_COLUMNS, ...defs.map((d) => customKey(d.id))];
  const toggle = (k: string, on: boolean) => onChange(on ? [...keys, k] : keys.filter((x) => x !== k));
  const preset = "rounded-lg bg-secondary px-2.5 py-1.5 text-xs text-muted-foreground ring-1 ring-border hover:text-foreground disabled:opacity-50";
  return (
    <FoldBox id="settings:private-fields" title="Private fields">
      <section className="glass-panel space-y-4 p-5">
        <div>
          <div className="flex items-center gap-2 font-display font-extrabold tracking-tight"><Lock className="h-4 w-4" /> Private fields</div>
          <p className="mt-1 text-sm text-muted-foreground">
            Ticked details stay on this device and are never sent to the cloud: pushing leaves them blank in the cloud copy, and pulling keeps this device's values.
            Employee ID, names and hourly rate always sync, since payroll needs them. Categories you add later start out private.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Making a field private after pushing? Push again to remove it from the cloud copy; older copies under "Backups in the cloud" still contain it.
            Backups on this computer and backup files you download keep everything; downloaded files ask for a password.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className={preset} disabled={busy} onClick={() => onChange(everything.filter((k) => !DEFAULT_SHARED.includes(k)))}>Recommended: only work details sync</button>
          <button type="button" className={preset} disabled={busy} onClick={() => onChange(everything)}>Every detail</button>
          <button type="button" className={preset} disabled={busy} onClick={() => onChange(PERSONAL_DETAILS)}>Only personal details</button>
          <button type="button" className={preset} disabled={busy} onClick={() => onChange([])}>Sync everything</button>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((g) => (
            <div key={g.title}>
              <div className="mb-1.5 text-xs font-semibold text-muted-foreground">{g.title}</div>
              <div className="space-y-1">
                {g.items.map((it) => (
                  <label key={it.key} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" disabled={busy} checked={keys.includes(it.key)} onChange={(e) => toggle(it.key, e.target.checked)} />
                    {it.label}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </FoldBox>
  );
}

