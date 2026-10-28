import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { btnGhost, btnPrimary } from "@/components/AppShell";
import { answerChoice, useChoiceRequest } from "@/lib/choice-prompt";

const SHOWN = 8;

/** The dialog behind askChoice(). Mounted once, in the root layout. */
export function ChoicePrompt() {
  const req = useChoiceRequest();
  if (!req) return null;
  const items = req.items ?? [];
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
        <div className="flex flex-wrap justify-end gap-2">
          {req.choices.map((c, i) => (
            <button key={c.id} type="button" autoFocus={i === req.choices.length - 1} onClick={() => answerChoice(c.id)}
              className={c.primary ? btnPrimary : `${btnGhost} ${c.danger ? "hover:!text-destructive" : ""}`}>
              {c.label}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
