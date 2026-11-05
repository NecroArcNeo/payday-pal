import { useEffect, useState } from "react";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { btnGhost, btnPrimary, inputCls } from "@/components/AppShell";
import { weekday } from "@/lib/payroll";
import { answerChoice, useChoiceRequest } from "@/lib/choice-prompt";
import { DateInput } from "@/components/DateInput";

const SHOWN = 8;
const btnDanger = "rounded-xl bg-destructive px-4 py-2 text-sm font-semibold text-destructive-foreground shadow-lg shadow-destructive/25 hover:bg-destructive/90 disabled:opacity-50 transition-colors";

/**
 * The dialog behind askChoice() and askConfirm(). Mounted once, in the root layout. An alert dialog (role
 * "alertdialog"): a click beside it doesn't close it, since it's waiting for an answer; Escape answers "no".
 */
export function ChoicePrompt() {
  const req = useChoiceRequest();
  const [date, setDate] = useState("");
  const [text, setText] = useState("");
  useEffect(() => { setDate(req?.date?.value ?? ""); setText(req?.text?.value ?? ""); }, [req]);
  if (!req) return null;
  const items = req.items ?? [];
  const d = req.date;
  const dateOk = !d || (!!date && (!d.min || date >= d.min) && (!d.max || date <= d.max));
  const textOk = !req.text || text.trim() !== "";
  // With a text box, the box has the focus (to type straight away), and Enter in it picks the main answer.
  const focus = req.text ? null : req.focus ?? req.choices.at(-1)?.id;
  const main = req.choices.find((c) => c.primary) ?? req.choices.at(-1);
  const ok = (c: { needsDate?: boolean | undefined; needsText?: boolean | undefined }) => !(c.needsDate && !dateOk) && !(c.needsText && !textOk);
  const paragraphs = req.detail?.split(/\n\s*\n/) ?? [];
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) answerChoice(null); }}>
      {/* Radix's alert dialog focuses its own Cancel part on opening, which this doesn't use: focus the chosen answer
          (or the text box) instead, so Enter does what the request says. */}
      <AlertDialogContent {...(paragraphs.length ? {} : { "aria-describedby": undefined })}
        onOpenAutoFocus={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).querySelector<HTMLElement>("[data-autofocus]")?.focus(); }}>
        <AlertDialogHeader>
          <AlertDialogTitle>{req.title}</AlertDialogTitle>
          {paragraphs.length > 0 && (
            <AlertDialogDescription asChild>
              <div className="space-y-2">{paragraphs.map((p, i) => <p key={i} className="whitespace-pre-line">{p}</p>)}</div>
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
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
        {req.text && (
          <label className="block">
            <span className="label-mono">{req.text.label}</span>
            <input className={`${inputCls} mt-1`} data-autofocus value={text} placeholder={req.text.placeholder} maxLength={req.text.maxLength}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && main && ok(main)) { e.preventDefault(); answerChoice({ id: main.id, date, text }); } }} />
          </label>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {req.choices.map((c) => (
            <button key={c.id} type="button" data-autofocus={c.id === focus || undefined} disabled={!ok(c)} onClick={() => answerChoice({ id: c.id, date, text })}
              // Danger on its own (askConfirm's "Delete"): a red button. Danger among several answers: a quiet button
              // that turns red on hover, as before.
              className={`${c.danger && !c.primary && req.choices.length === 2 ? btnDanger : c.primary ? btnPrimary : `${btnGhost} ${c.danger ? "hover:!text-destructive" : ""}`} disabled:opacity-50`}>
              {c.label}
            </button>
          ))}
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
