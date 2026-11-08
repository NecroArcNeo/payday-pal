import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { btnGhost, btnPrimary, inputCls } from "@/components/AppShell";
import { DateInput } from "@/components/DateInput";
import { db } from "@/lib/db/mode";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { askChoice, askConfirm } from "@/lib/choice-prompt";
import { readAmount } from "@/lib/amount";
import { DEDUCTION_KINDS, DEDUCTION_REPEATS, deductionsFor, planBulkDeduction } from "@/lib/deductions";
import { currentWeek, fullName, money, useDeductions, type Deduction, type Employee } from "@/lib/payroll";
import { FoldBox } from "@/components/FoldBox";

type Draft = { name: string; kind: string; amount: string; repeats: string; starts_on: string; ends_on: string; note: string };
const blank: Draft = { name: "", kind: "fixed", amount: "", repeats: "period", starts_on: "", ends_on: "", note: "" };
const draftOf = (d: Deduction): Draft => ({
  name: d.name, kind: d.kind, amount: String(Number(d.amount)), repeats: d.repeats, starts_on: d.starts_on ?? "", ends_on: d.ends_on ?? "", note: d.note ?? "",
});

/** Checks a draft; the row to save, or the reason it can't be. */
function checked(v: Draft): { row: Omit<Draft, "amount" | "starts_on" | "ends_on" | "note"> & { amount: number; starts_on: string | null; ends_on: string | null; note: string | null } } | { error: string } {
  const name = v.name.trim();
  if (!name || name.length > 60) return { error: "Give the deduction a name (up to 60 characters), e.g. Tax or Health plan" };
  const amount = readAmount(v.amount);
  if (!v.amount.trim() || !Number.isFinite(amount) || amount < 0) return { error: "Enter the amount (0 or more)" };
  if (v.kind === "percent" && amount > 100) return { error: "A percent can be at most 100" };
  if (v.repeats === "once" && !v.starts_on) return { error: "A one-off deduction needs the date it's taken" };
  if (v.starts_on && v.ends_on && v.ends_on < v.starts_on) return { error: "It can't end before it starts" };
  return { row: { name, kind: v.kind, amount, repeats: v.kind === "percent" && v.repeats === "week" ? "period" : v.repeats, starts_on: v.starts_on || null, ends_on: v.repeats === "once" ? null : v.ends_on || null, note: v.note.trim().slice(0, 300) || null } };
}

/**
 * An employee's deductions (the profile's Deductions tab): each a fixed amount or a percent of gross, how it repeats,
 * and optionally when it starts and ends. The example line shows what it takes from this week's pay, so a percent and
 * a fixed amount can be told apart at a glance.
 */
export function DeductionsEditor({ employeeId }: { employeeId: string }) {
  const qc = useQueryClient();
  const { data: all } = useDeductions();
  const list = all?.get(employeeId) ?? [];
  const [adding, setAdding] = useState<Draft>(blank);
  const refresh = () => qc.invalidateQueries({ queryKey: ["deductions"] });

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const c = checked(adding);
    if ("error" in c) { toast.error(c.error); return; }
    const { error } = await db().insert("deductions", { employee_id: employeeId, ...c.row, sort_order: list.length });
    if (error) { toast.error(error.message); return; }
    toast.success(`Added ${c.row.name}`);
    setAdding(blank);
    void refresh();
  };
  const save = async (d: Deduction, v: Draft) => {
    const c = checked(v);
    if ("error" in c) { toast.error(c.error); return; }
    const { error } = await db().update("deductions", d.id, c.row);
    if (error) toast.error(error.message); else { toast.success(`${c.row.name} saved`); void refresh(); }
  };
  const remove = async (d: Deduction) => {
    if (!(await askConfirm({ title: `Delete ${d.name}?`, detail: "Pay runs already recorded keep what they took. Ctrl+Z puts it back.", confirm: "Delete deduction", danger: true }))) return;
    const { error } = await db().remove("deductions", d.id);
    if (error) toast.error(error.message); else void refresh();
  };

  return (
    <FoldBox id="profile:deductions" title="Deductions">
      <div className="glass-panel overflow-hidden">
        <div className="border-b border-border px-5 py-4">
          <div className="font-display font-extrabold tracking-tight">Deductions</div>
          <p className="text-xs text-muted-foreground">
            Taken from gross pay, in this order, to give net pay. A fixed amount is taken once per pay period you pay (the period on the Payroll page or a pay run), once for each Mon–Sun week in it, or once on a date; a percent is of the period's gross pay. Leave the dates empty for "always".
          </p>
        </div>
        <div className="divide-y divide-border">
          {list.map((d) => <DeductionRow key={d.id} deduction={d} onSave={save} onRemove={remove} />)}
          {list.length === 0 && <div className="px-5 py-4 text-sm text-muted-foreground">No deductions: net pay is the same as gross pay.</div>}
        </div>
        <form onSubmit={add} className="border-t border-border p-5">
          <div className="label-mono mb-2">Add a deduction</div>
          <Fields v={adding} set={(k, val) => setAdding((x) => ({ ...x, [k]: val }))} />
          <button className={`${btnPrimary} mt-3`}><Plus className="mr-1 inline h-4 w-4" />Add deduction</button>
        </form>
      </div>
    </FoldBox>
  );
}

/**
 * "Add a deduction" for the people selected on the Employees page: the profile tab's fields, then one insert of a row
 * per person (one transaction, so one Ctrl+Z takes them all back). Asks first when some already have one by that name.
 */
export function BulkDeductionDialog({ people, onClose }: { people: Employee[]; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: all } = useDeductions();
  const [v, setV] = useState<Draft>(blank);
  const [busy, setBusy] = useState(false);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const c = checked(v);
    if ("error" in c) { toast.error(c.error); return; }
    const ids = people.map((p) => p.id);
    const plan = planBulkDeduction(ids, all ?? new Map(), c.row, false);
    const already = plan.already;
    let rows = plan.rows;
    if (already.length) {
      const names = people.filter((p) => already.includes(p.id)).map(fullName);
      const answer = await askChoice({
        title: `${already.length === 1 ? "1 person already has" : `${already.length} people already have`} a deduction called ${c.row.name}`,
        detail: "Adding it again takes it twice from their pay.",
        items: names.length > 8 ? [...names.slice(0, 8), `and ${names.length - 8} more`] : names,
        choices: [
          { id: "cancel", label: "Cancel" },
          { id: "both", label: "Add it to them too" },
          ...(already.length < ids.length ? [{ id: "skip" as const, label: "Skip them, add the rest", primary: true }] : []),
        ],
        // Enter never doubles a deduction: it skips them, or cancels when everyone has it.
        focus: already.length < ids.length ? "skip" : "cancel",
      });
      if (!answer || answer.id === "cancel") return;
      if (answer.id === "skip") rows = planBulkDeduction(ids, all ?? new Map(), c.row, true).rows;
    }
    setBusy(true);
    const { error } = await db().insert("deductions", rows);
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    toast.success(`Added ${c.row.name} to ${rows.length === 1 ? "1 person" : `${rows.length} people`}`, { description: "Ctrl+Z takes it back from all of them." });
    void qc.invalidateQueries({ queryKey: ["deductions"] });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add a deduction to {people.length === 1 ? fullName(people[0]!) : `${people.length} people`}</DialogTitle>
          <DialogDescription>
            Each person gets their own copy, taken after their other deductions; change or delete it later on their profile's Deductions tab.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={add} className="space-y-4">
          <Fields v={v} set={(k, val) => setV((x) => ({ ...x, [k]: val }))} />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className={btnGhost}>Cancel</button>
            <button disabled={busy} className={btnPrimary}><Plus className="mr-1 inline h-4 w-4" />Add to {people.length === 1 ? "1 person" : `${people.length} people`}</button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeductionRow({ deduction: d, onSave, onRemove }: { deduction: Deduction; onSave: (d: Deduction, v: Draft) => void; onRemove: (d: Deduction) => void }) {
  const saved = draftOf(d);
  const savedKey = JSON.stringify(saved);
  const [v, setV] = useState(saved);
  useEffect(() => { setV(JSON.parse(savedKey) as Draft); }, [savedKey]);
  const dirty = JSON.stringify(v) !== savedKey;
  const w = currentWeek();
  const example = deductionsFor([{ ...d, amount: Number(d.amount) }], 1000, w.from, w.to).lines[0];
  return (
    <div className="space-y-2 px-5 py-3">
      <Fields v={v} set={(k, val) => setV((x) => ({ ...x, [k]: val }))} />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {example ? `This week, from gross pay of ${money(1000)}: ${money(example.amount)} (${example.detail})` : "Not taken this week."}
        </span>
        <span className="ml-auto flex gap-2">
          {dirty && <button type="button" onClick={() => onSave(d, v)} className={btnPrimary}>Save</button>}
          {dirty && <button type="button" onClick={() => setV(saved)} className={btnGhost}>Cancel</button>}
          <button type="button" onClick={() => onRemove(d)} className={btnGhost} aria-label={`Delete ${d.name}`}><Trash2 className="h-4 w-4" /></button>
        </span>
      </div>
    </div>
  );
}

function Fields({ v, set }: { v: Draft; set: (k: keyof Draft, val: string) => void }) {
  const percent = v.kind === "percent";
  return (
    <div className="flex flex-wrap items-end gap-3 text-sm">
      <label><span className="label-mono">Name</span><input className={`${inputCls} mt-1 !w-44`} placeholder="e.g. Tax, Health plan" value={v.name} maxLength={60} onChange={(e) => set("name", e.target.value)} /></label>
      <label><span className="label-mono">Kind</span>
        <select className={`${inputCls} mt-1 !w-40`} value={v.kind} onChange={(e) => set("kind", e.target.value)}>
          {Object.entries(DEDUCTION_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      <label><span className="label-mono">{percent ? "Percent" : "Amount"}</span>
        <span className="mt-1 flex items-center gap-1">
          <input className={`${inputCls} !w-28`} inputMode="decimal" value={v.amount} onChange={(e) => set("amount", e.target.value)} aria-label={percent ? "Percent" : "Amount"} />
          {percent && <span className="text-muted-foreground">%</span>}
        </span>
      </label>
      <label><span className="label-mono">Taken</span>
        <select className={`${inputCls} mt-1 !w-40`} value={percent && v.repeats === "week" ? "period" : v.repeats} onChange={(e) => set("repeats", e.target.value)}>
          {Object.entries(DEDUCTION_REPEATS).filter(([k]) => !(percent && k === "week")).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      <label><span className="label-mono">{v.repeats === "once" ? "On" : "From"}</span><DateInput className={`${inputCls} mt-1 !w-36`} value={v.starts_on} onChange={(x) => set("starts_on", x)} placeholder={v.repeats === "once" ? "Date" : "Always"} /></label>
      {v.repeats !== "once" && <label><span className="label-mono">Until</span><DateInput className={`${inputCls} mt-1 !w-36`} value={v.ends_on} onChange={(x) => set("ends_on", x)} placeholder="No end" /></label>}
      <label className="min-w-[10rem] flex-1"><span className="label-mono">Note</span><input className={`${inputCls} mt-1`} value={v.note} maxLength={300} onChange={(e) => set("note", e.target.value)} /></label>
    </div>
  );
}
