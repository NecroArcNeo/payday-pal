import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Lock, LockOpen } from "lucide-react";
import { btnGhost, btnPrimary } from "@/components/AppShell";
import { db } from "@/lib/db/mode";
import { askChoice } from "@/lib/choice-prompt";
import { isWeekend } from "@/lib/pay";
import { usePayrollSettings, weekday } from "@/lib/payroll";

const WHAT = "Time records, extra pay and pay rates on or before that day can't be added, changed or deleted until you unlock them.";
const STILL = "Changing overtime rules or shift multipliers would still change how those days are calculated.";

/** Shows what's locked as paid, and locks the period shown (or changes the lock). The database enforces it (schema 10). */
export function PayLock({ periodEnd }: { periodEnd: string }) {
  const qc = useQueryClient();
  const { data: settings } = usePayrollSettings();
  const locked = settings?.locked_through ?? null;
  const save = async (date: string | null, done: string) => {
    const { error } = await db().setLockedThrough(date);
    if (error) { toast.error(error.message); return; }
    toast.success(done);
    qc.invalidateQueries({ queryKey: ["payroll-settings"] });
  };

  const lockPeriod = async () => {
    const answer = await askChoice({
      title: `Lock everything up to ${weekday(periodEnd)} ${periodEnd} as paid?`,
      detail: `${WHAT} ${STILL}${new Date(`${periodEnd}T00:00:00Z`).getUTCDay() !== 0 ? " Tip: lock through a Sunday, so a week's overtime and salary can't change from days after the lock." : ""}`,
      choices: [{ id: "cancel", label: "Cancel" }, { id: "lock", label: "Lock as paid", primary: true }],
    });
    if (answer?.id === "lock") await save(periodEnd, `Locked through ${weekday(periodEnd)} ${periodEnd}`);
  };

  const changeLock = async () => {
    const answer = await askChoice({
      title: "Change the lock",
      detail: `Days up to ${weekday(locked!)} ${locked} are locked as paid. Pick a new last locked day, or unlock everything. Unlocked days can be changed again, which changes what they pay.`,
      date: { label: "Locked through", value: locked! },
      choices: [{ id: "cancel", label: "Cancel" }, { id: "unlock", label: "Unlock everything", danger: true }, { id: "move", label: "Lock through this day", primary: true, needsDate: true }],
    });
    if (answer?.id === "unlock") await save(null, "Unlocked: every day can be changed again");
    else if (answer?.id === "move" && answer.date !== locked) await save(answer.date, `Locked through ${weekday(answer.date)} ${answer.date}`);
  };

  const canLockPeriod = !locked || periodEnd > locked;
  return (
    <div className="glass-panel flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
      <span className="flex items-center gap-2">
        {locked ? <Lock className="h-4 w-4 text-primary" /> : <LockOpen className="h-4 w-4 text-muted-foreground" />}
        {locked
          ? <span>Paid and locked through <span className="font-medium">{weekday(locked)} {locked}</span>. Nothing on or before it can change.</span>
          : <span className="text-muted-foreground">Nothing is locked. Once a period is paid, lock it so its records can't change by accident.</span>}
      </span>
      <span className="flex gap-2">
        {locked && <button type="button" onClick={changeLock} className={btnGhost}>Change lock…</button>}
        {canLockPeriod && (
          <button type="button" onClick={lockPeriod} className={btnPrimary} title={isWeekend(periodEnd) ? undefined : "The period doesn't end on a weekend; check it's the right end date"}>
            <Lock className="mr-1 inline h-4 w-4" />Lock through {weekday(periodEnd)} {periodEnd}
          </button>
        )}
      </span>
    </div>
  );
}
