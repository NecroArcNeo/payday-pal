import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Lock, LockOpen } from "lucide-react";
import { btnGhost, btnPrimary } from "@/components/AppShell";
import { db, storeFor, useDataMode } from "@/lib/db/mode";
import { askChoice } from "@/lib/choice-prompt";
import { lockThrough } from "@/lib/pay-freeze";
import { isWeekend } from "@/lib/pay";
import { addDays, isoDate, usePayrollSettings, weekday } from "@/lib/payroll";

const WHAT = "Time records, extra pay and pay rates on or before that day can't be added, changed or deleted until you unlock them.";
const STILL = "Their pay is saved as it is now: changing overtime rules, shift multipliers or rates later won't change it. Unlocking pays them by the rules of the day again (Ctrl+Z undoes an unlock).";
const RELOCK = "Records you unlocked one by one are locked again.";

/** The last Sunday before today: the end of the latest whole Mon–Sun week. */
function lastSunday() {
  const today = isoDate(new Date());
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  return addDays(today, dow === 0 ? -7 : -dow);
}

/**
 * Shows what's locked as paid, and locks the period shown (or changes the lock). The database enforces it (schema 10).
 * Without `periodEnd` (the Time records page), locking asks for the day. `warnings`: things to check still open in the
 * period (RecordWarnings), mentioned before locking it; they never stop it.
 */
export function PayLock({ periodEnd, warnings = 0 }: { periodEnd?: string | undefined; warnings?: number | undefined }) {
  const qc = useQueryClient();
  const dataMode = useDataMode();
  const { data: settings } = usePayrollSettings();
  const locked = settings?.locked_through ?? null;
  // Under ["records"], so it refreshes whenever records change.
  const { data: count = 0 } = useQuery({ queryKey: ["records", "unlocked", dataMode], queryFn: () => storeFor(dataMode).countUnlockedRecords(), enabled: !!locked });
  const unlocked = locked ? count : 0;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["payroll-settings"] });
    qc.invalidateQueries({ queryKey: ["records"] });
  };
  const save = async (date: string | null, done: string) => {
    const { error } = await lockThrough(db(), date);
    if (error) { toast.error(error.message); return; }
    toast.success(done);
    refresh();
  };

  const lockPeriod = async (end: string) => {
    const answer = await askChoice({
      title: `Lock everything up to ${weekday(end)} ${end} as paid?`,
      detail: `${warnings ? `${warnings} thing${warnings === 1 ? "" : "s"} to check in this period ${warnings === 1 ? "hasn't" : "haven't"} been looked at yet (listed on this page). ` : ""}${WHAT} ${STILL}${unlocked ? ` ${RELOCK}` : ""}${new Date(`${end}T00:00:00Z`).getUTCDay() !== 0 ? " Tip: lock through a Sunday, so a week's overtime and salary can't change from days after the lock." : ""}`,
      choices: [{ id: "cancel", label: "Cancel" }, { id: "lock", label: "Lock as paid", primary: true }],
    });
    if (answer?.id === "lock") await save(end, `Locked through ${weekday(end)} ${end}`);
  };

  const changeLock = async () => {
    const answer = await askChoice({
      title: locked ? "Change the lock" : "Lock days as paid",
      detail: locked
        ? `Days up to ${weekday(locked)} ${locked} are locked as paid. Pick a new last locked day, or unlock everything. Days you unlock can be changed again and are paid by the current rules, not their saved pay (Ctrl+Z puts it back); days you lock get their pay saved as it is now.${unlocked ? ` ${RELOCK}` : ""}`
        : `Pick the last day to lock. ${WHAT} ${STILL}`,
      date: { label: "Locked through", value: locked ?? lastSunday(), max: isoDate(new Date()) },
      choices: [
        { id: "cancel", label: "Cancel" },
        ...(locked ? [{ id: "unlock", label: "Unlock everything", danger: true }] : []),
        { id: "move", label: "Lock through this day", primary: true, needsDate: true },
      ],
    });
    if (answer?.id === "unlock") await save(null, "Unlocked: every day can be changed again");
    else if (answer?.id === "move" && (answer.date !== locked || unlocked)) await save(answer.date, `Locked through ${weekday(answer.date)} ${answer.date}`);
  };

  // Setting the lock again locks every record unlocked one by one.
  const relock = () => save(locked, `Locked ${unlocked} record${unlocked === 1 ? "" : "s"} again`);

  // Never days still to come (as the dialog's date can't be after today): locking the rest of this week would refuse
  // its shifts as "already paid". Until the period has ended, "Lock days as paid…" offers up to today instead.
  const canLockPeriod = !!periodEnd && periodEnd <= isoDate(new Date()) && (!locked || periodEnd > locked);
  return (
    <div className="glass-panel flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
      <span className="flex items-center gap-2">
        {locked ? <Lock className="h-4 w-4 text-primary" /> : <LockOpen className="h-4 w-4 text-muted-foreground" />}
        {locked
          ? <span>Paid and locked through <span className="font-medium">{weekday(locked)} {locked}</span>. Nothing on or before it can change{unlocked ? <>, except <span className="font-medium">{unlocked} record{unlocked === 1 ? "" : "s"} you unlocked</span></> : ""}.</span>
          : <span className="text-muted-foreground">Nothing is locked. Once a period is paid, lock it so its records can't change by accident.</span>}
      </span>
      <span className="flex gap-2">
        {unlocked > 0 && <button type="button" onClick={relock} className={btnGhost}><Lock className="mr-1 inline h-4 w-4" />Lock {unlocked === 1 ? "it" : `all ${unlocked}`} again</button>}
        {(locked || !canLockPeriod) && <button type="button" onClick={changeLock} className={btnGhost}>{locked ? "Change lock…" : <><Lock className="mr-1 inline h-4 w-4" />Lock days as paid…</>}</button>}
        {canLockPeriod && (
          <button type="button" onClick={() => lockPeriod(periodEnd)} className={btnPrimary} title={isWeekend(periodEnd) ? undefined : "The period doesn't end on a weekend; check it's the right end date"}>
            <Lock className="mr-1 inline h-4 w-4" />Lock through {weekday(periodEnd)} {periodEnd}
          </button>
        )}
      </span>
    </div>
  );
}
