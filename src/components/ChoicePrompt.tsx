import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { btnGhost, btnPrimary, inputCls } from "@/components/AppShell";
import { weekday } from "@/lib/payroll";
import { answerChoice, useChoiceRequest } from "@/lib/choice-prompt";
import { DateInput } from "@/components/DateInput";

const SHOWN = 8;

/** The dialog behind askChoice(). Mounted once, in the root layout. */
export function ChoicePrompt() {
  const req = useChoiceRequest();
  const [date, setDate] = useState("");
  useEffect(() => { setDate(req?.date?.value ?? ""); }, [req]);
  if (!req) return null;
  const items = req.items ?? [];
  const d = req.date;
  const dateOk = !d || (!!date && (!d.min || date >= d.min) && (!d.max || date <= d.max));
  return (
    <Dialog open onOpenChange={(open) => { if (!open) answerChoice(null); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{req.title}</DialogTitle>
          {req.detail && <DialogDescription>{req.detail}</DialogDescription>}
        </DialogHeader>
        {items.length > 0 && (
          <ul className="max-h-60 space-y-1 overflow-y-auto rounded-xl bg-secondary/50 p-3 text-sm ring-1 ring-border">
            {items.slice(0, SHOWN).map((x, i) => <li key={i}>{x}</li>)}
            {items.length > SHOWN && <li className="text-muted-foreground">…and {items.length - SHOWN} more</li>}
          </ul>
        )}
        {d && (
          <label className="block">
            <span className="label-mono">{d.label}{date && ` · ${weekday(date)}`}</span>
            <DateInput className={`${inputCls} mt-1 w-auto ${dateOk ? "" : "ring-2 ring-destructive"}`} value={date} min={d.min} max={d.max} onChange={(v) => setDate(v)} />
            {!dateOk && date && d.max && date > d.max && <span className="ml-2 text-xs text-destructive">Can't be after {d.max}</span>}
          </label>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {req.choices.map((c, i) => (
            <button key={c.id} type="button" autoFocus={i === req.choices.length - 1} disabled={c.needsDate && !dateOk} onClick={() => answerChoice({ id: c.id, date })}
              className={`${c.primary ? btnPrimary : `${btnGhost} ${c.danger ? "hover:!text-destructive" : ""}`} disabled:opacity-50`}>
              {c.label}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
