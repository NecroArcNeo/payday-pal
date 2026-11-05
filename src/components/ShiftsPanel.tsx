import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { btnGhost, btnPrimary, inputCls } from "@/components/AppShell";
import { BreakInput } from "@/components/BreakField";
import { db } from "@/lib/db/mode";
import { askConfirm } from "@/lib/choice-prompt";
import { useBreakUnit, validBreak, breakRangeText } from "@/lib/breaks";
import { shiftFor } from "@/lib/pay";
import type { Employee, Shift } from "@/lib/payroll";
import type { TablesUpdate } from "@/integrations/supabase/types";

/** The shifts employees can be on, each with a multiplier on the hourly rate. The first one is the default. */
export function ShiftsPanel({ shifts, employees, onChange }: { shifts: Shift[]; employees: Employee[]; onChange: () => void }) {
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
    if (!(await askConfirm({
      title: `Delete the ${s.name} shift?`,
      ...(n ? { detail: `${n} employee${n === 1 ? "" : "s"} on it will move to the default shift (${rest[0]!.name}).` } : {}),
      confirm: "Delete shift", danger: true,
    }))) return;
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
