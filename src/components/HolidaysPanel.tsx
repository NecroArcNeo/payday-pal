import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarPlus, Gift, Plus, Trash2 } from "lucide-react";
import { btnGhost, btnPrimary, inputCls } from "@/components/AppShell";
import { DateInput } from "@/components/DateInput";
import { db } from "@/lib/db/mode";
import { backupBefore } from "@/lib/db/safety";
import { askChoice, askConfirm } from "@/lib/choice-prompt";
import { copyToNextYear, planHolidayPay } from "@/lib/holidays";
import { fullName, money, useEmployees, useHolidays, usePayRates, usePayrollSettings, weekday, type Holiday } from "@/lib/payroll";
import { readAmount } from "@/lib/amount";
import { FoldBox } from "@/components/FoldBox";

// Settings → Holidays: the public holidays the user keeps, each with its own pay rules (a rate for hours worked that
// day, and hours paid to people who are off), "Add holiday pay" for one, and copying a year's list to the next.

type Draft = { date: string; name: string; multiplier: string; paidHours: string };
const toDraft = (h: Pick<Holiday, "holiday_date" | "name" | "multiplier" | "paid_hours">): Draft =>
  ({ date: h.holiday_date, name: h.name, multiplier: String(Number(h.multiplier)), paidHours: String(Number(h.paid_hours)) });

type HolidayInput = { holiday_date: string; name: string; multiplier: number; paid_hours: number };

/** The draft as a row to save, or a message saying what's wrong. */
function checked(d: Draft, list: Holiday[], selfId?: string): HolidayInput | string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return "Pick the holiday's date";
  const name = d.name.trim();
  if (!name || name.length > 60) return "Give the holiday a name (up to 60 characters)";
  const clash = list.find((h) => h.holiday_date === d.date && h.id !== selfId);
  if (clash) return `${weekday(d.date)} ${d.date} is already a holiday (${clash.name})`;
  const multiplier = readAmount(d.multiplier);
  if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 10) return "The rate for hours worked is a multiplier from 1 (normal pay) to 10";
  const paid = readAmount(d.paidHours || "0");
  if (!Number.isFinite(paid) || paid < 0 || paid > 24) return "Paid hours when off are 0 to 24";
  return { holiday_date: d.date, name, multiplier: Math.round(multiplier * 1000) / 1000, paid_hours: Math.round(paid * 100) / 100 };
}

export function HolidaysPanel() {
  const qc = useQueryClient();
  const { data: holidays = [] } = useHolidays();
  const { data: employees = [] } = useEmployees();
  const { data: rates } = usePayRates();
  const { data: settings } = usePayrollSettings();
  const last = holidays.at(-1);
  const blank = (): Draft => ({ date: "", name: "", multiplier: last ? String(Number(last.multiplier)) : "1.5", paidHours: last ? String(Number(last.paid_hours)) : "8" });
  const [draft, setDraft] = useState<Draft>(blank);
  const changed = () => qc.invalidateQueries();

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const row = checked(draft, holidays);
    if (typeof row === "string") { toast.error(row); return; }
    const { error } = await db().insert("holidays", row);
    if (error) { toast.error(error.message); return; }
    toast.success(`Added ${row.name}`);
    setDraft({ ...blank(), multiplier: draft.multiplier, paidHours: draft.paidHours });
    void changed();
  };

  const save = async (h: Holiday, d: Draft) => {
    const row = checked(d, holidays, h.id);
    if (typeof row === "string") { toast.error(row); return; }
    const { error } = await db().update("holidays", h.id, row);
    if (error) toast.error(error.message); else { toast.success(`${row.name} saved`); void changed(); }
  };

  const remove = async (h: Holiday) => {
    if (!(await askConfirm({
      title: `Delete ${h.name}?`,
      detail: "Hours worked that day go back to their usual pay (days locked as paid keep what they paid). Holiday pay already added stays: delete those records on Time records if they should go too.",
      confirm: "Delete holiday", danger: true,
    }))) return;
    const { error } = await db().remove("holidays", h.id);
    if (error) toast.error(error.message); else void changed();
  };

  const holidayPay = async (h: Holiday) => {
    try {
      const existing = await db().listRecordsMatching({ from: h.holiday_date, to: h.holiday_date });
      const args = { holiday: h, employees, rates, existing, lockedThrough: settings?.locked_through ?? null };
      const off = planHolidayPay({ ...args, includeWorking: false });
      const all = planHolidayPay({ ...args, includeWorking: true });
      if (off.locked) { toast.error(`${weekday(h.holiday_date)} ${h.holiday_date} is locked as paid, so nothing can be added to it. Unlock it on the Payroll page first.`); return; }
      const nameOf = (id: string) => { const e = employees.find((x) => x.id === id); return e ? fullName(e) : "Someone"; };
      const left = [
        all.salaried.length && `${all.salaried.length} salaried (their salary covers the day)`,
        all.notWorking.length && `${all.notWorking.length} resigned or not hired yet`,
        all.already.length && `${all.already.length} already have holiday pay for it`,
        all.noRate.length && `${all.noRate.length} with no pay rate`,
      ].filter(Boolean) as string[];
      if (!all.add.length) { toast.info(`No one to add holiday pay for.${left.length ? ` Left out: ${left.join(", ")}.` : ""}`); return; }
      const working = all.add.length - off.add.length;
      const answer = await askChoice({
        title: `Holiday pay for ${h.name}`,
        detail: `${Number(h.paid_hours)} hours at each person's rate on ${weekday(h.holiday_date)} ${h.holiday_date}, as a record with no hours (so it never adds overtime). ${working ? `${working} ${working === 1 ? "person works" : "people work"} that day: their hours already pay ×${Number(h.multiplier)}; give them holiday pay too only if your rules say so.` : ""}${left.length ? ` Left out: ${left.join(", ")}.` : ""} A backup is saved first, and Ctrl+Z takes it all back.`,
        items: (off.add.length ? off.add : all.add).slice(0, 25).map((r) => `${nameOf(r.employee_id)} · ${money(r.pay_override)}`)
          .concat((off.add.length ? off.add : all.add).length > 25 ? [`…and ${(off.add.length ? off.add : all.add).length - 25} more`] : []),
        choices: [
          { id: "cancel", label: "Cancel" },
          ...(working ? [{ id: "all", label: `Also the ${working} who work${working === 1 ? "s" : ""}` }] : []),
          ...(off.add.length ? [{ id: "off", label: `Add for ${off.add.length} ${off.add.length === 1 ? "person" : "people"} off`, primary: true }] : []),
        ],
      });
      if (!answer || answer.id === "cancel") return;
      const rows = answer.id === "all" ? all.add : off.add;
      await backupBefore("holiday-pay");
      const { error } = await db().insert("time_records", rows);
      if (error) throw error;
      toast.success(`Added holiday pay for ${rows.length} ${rows.length === 1 ? "person" : "people"} (${money(rows.reduce((s, r) => s + r.pay_override, 0))})`);
      void changed();
    } catch (e) {
      toast.error(`Nothing was added: ${(e as Error).message}`);
    }
  };

  const years = [...new Set(holidays.map((h) => Number(h.holiday_date.slice(0, 4))))].sort();
  const copyYear = async (year: number) => {
    const rows: HolidayInput[] = copyToNextYear(holidays, year).map((r) => ({ ...r, multiplier: Number(r.multiplier), paid_hours: Number(r.paid_hours) }));
    if (!rows.length) { toast.info(`${year + 1} already has every ${year} holiday`); return; }
    if (!(await askConfirm({
      title: `Copy ${rows.length} holiday${rows.length === 1 ? "" : "s"} to ${year + 1}?`,
      detail: "Same day and month, same pay rules. Holidays that move each year (like Easter) need their dates changing afterwards.",
      items: rows.map((r) => `${weekday(r.holiday_date)} ${r.holiday_date} · ${r.name}`),
      confirm: `Copy to ${year + 1}`,
    }))) return;
    const { error } = await db().insert("holidays", rows);
    if (error) toast.error(error.message); else { toast.success(`Copied to ${year + 1}`); void changed(); }
  };

  return (
    <FoldBox id="settings:holidays" title="Public holidays">
      <div className="glass-panel overflow-hidden">
        <div className="border-b border-border px-5 py-4">
          <div className="font-display font-extrabold tracking-tight">Public holidays</div>
          <p className="text-xs text-muted-foreground">
            The days you treat as holidays, each with its own rules. <b>Hours worked</b> that day pay the rate × this multiplier when that's more than the shift or overtime rate would pay (they never stack; 1 = normal pay). Salaried pay doesn't change.
            {" "}<b>Paid hours when off</b> is what <i>Add holiday pay</i> gives each hourly employee who doesn't work that day (0 = unpaid): a record with no hours, paid those hours at their rate, which you can see and change on Time records.
            Days locked as paid keep what they paid.
          </p>
        </div>
        <div className="divide-y divide-border">
          {holidays.map((h) => <HolidayRow key={h.id} holiday={h} onSave={save} onRemove={remove} onHolidayPay={holidayPay} />)}
          {holidays.length === 0 && <div className="px-5 py-4 text-sm text-muted-foreground">No holidays yet: every day is paid by the usual rules. Add one below.</div>}
        </div>
        <form onSubmit={add} className="flex flex-wrap items-end gap-3 border-t border-border p-5">
          <label><span className="label-mono">Date</span><DateInput className={`${inputCls} mt-1 w-40`} value={draft.date} onChange={(v) => setDraft({ ...draft, date: v })} aria-label="Holiday date" /></label>
          <label><span className="label-mono">Name</span><input className={`${inputCls} mt-1 w-48`} placeholder="e.g. New Year's Day" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="Holiday name" /></label>
          <label><span className="label-mono">Hours worked ×</span><input className={`${inputCls} mt-1 w-24`} inputMode="decimal" value={draft.multiplier} onChange={(e) => setDraft({ ...draft, multiplier: e.target.value })} aria-label="Rate for hours worked" /></label>
          <label><span className="label-mono">Paid hours when off</span><input className={`${inputCls} mt-1 w-24`} inputMode="decimal" value={draft.paidHours} onChange={(e) => setDraft({ ...draft, paidHours: e.target.value })} aria-label="Paid hours when off" /></label>
          <button className={btnPrimary}><Plus className="mr-1 inline h-4 w-4" />Add holiday</button>
        </form>
        {years.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3 text-xs text-muted-foreground">
            Next year's list:
            {years.map((y) => <button key={y} type="button" onClick={() => void copyYear(y)} className={btnGhost}><CalendarPlus className="mr-1 inline h-3.5 w-3.5" />Copy {y} to {y + 1}</button>)}
          </div>
        )}
      </div>
    </FoldBox>
  );
}

function HolidayRow({ holiday, onSave, onRemove, onHolidayPay }: {
  holiday: Holiday; onSave: (h: Holiday, d: Draft) => void; onRemove: (h: Holiday) => void; onHolidayPay: (h: Holiday) => void;
}) {
  const saved = toDraft(holiday);
  const savedKey = JSON.stringify(saved);
  const [d, setD] = useState(saved);
  useEffect(() => { setD(JSON.parse(savedKey) as Draft); }, [savedKey]);
  const dirty = JSON.stringify(d) !== savedKey;
  return (
    <div className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
      <span className="w-9 text-muted-foreground">{weekday(d.date)}</span>
      <DateInput className={`${inputCls} w-36`} value={d.date} onChange={(v) => setD({ ...d, date: v })} aria-label={`${holiday.name} date`} />
      <input className={`${inputCls} w-48`} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} aria-label="Holiday name" />
      <span className="text-xs text-muted-foreground">Hours worked ×</span>
      <input className={`${inputCls} w-20`} inputMode="decimal" value={d.multiplier} onChange={(e) => setD({ ...d, multiplier: e.target.value })} aria-label={`${holiday.name} rate for hours worked`} />
      <span className="text-xs text-muted-foreground">Paid when off</span>
      <input className={`${inputCls} w-20`} inputMode="decimal" value={d.paidHours} onChange={(e) => setD({ ...d, paidHours: e.target.value })} aria-label={`${holiday.name} paid hours when off`} />
      <span className="text-xs text-muted-foreground">h</span>
      <div className="ml-auto flex gap-2">
        {dirty && <button type="button" onClick={() => onSave(holiday, d)} className={btnPrimary}>Save</button>}
        {!dirty && Number(holiday.paid_hours) > 0 && (
          <button type="button" onClick={() => onHolidayPay(holiday)} className={btnGhost} title="Give everyone who's off that day their paid hours"><Gift className="mr-1 inline h-4 w-4" />Add holiday pay</button>
        )}
        <button type="button" onClick={() => onRemove(holiday)} className={btnGhost} aria-label={`Delete ${holiday.name}`}><Trash2 className="h-4 w-4" /></button>
      </div>
    </div>
  );
}
