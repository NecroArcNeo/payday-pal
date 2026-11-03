import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarPlus, CheckSquare, Lock, LockOpen, PanelRightOpen, Trash2, User } from "lucide-react";
import { ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuShortcut } from "@/components/ui/context-menu";
import { askChoice } from "@/lib/choice-prompt";
import { planNextWeek } from "@/lib/copy-week";
import { backupBefore } from "@/lib/db/safety";
import { db, storeFor, useDataMode } from "@/lib/db/mode";
import { addDays, fullName, weekday, type Employee, type RecordWithEmp } from "@/lib/payroll";
import { describeRecord, sameDayClashes } from "@/lib/record-clash";

// The Time records right-click menu: the row's own actions in one place. The table (RecordsLedger) wraps its rows in
// one <ContextMenu> and says which record was right-clicked; this is the menu's content for that record.

export function RecordMenu({ record, employees, selection, lockedThrough, onOpen, onToggle, onDelete, onSetUnlocked }: {
  record: RecordWithEmp; employees: ReadonlyMap<string, Employee>;
  /** The selected records on the list. Right-clicking one of several selected copies them all, as in a file manager. */
  selection: RecordWithEmp[]; lockedThrough: string | null;
  onOpen: () => void; onToggle: () => void; onDelete: () => void; onSetUnlocked: (unlocked: boolean) => void;
}) {
  const navigate = useNavigate();
  const copy = useCopyToNextWeek();
  const lockedDay = !!lockedThrough && record.work_date <= lockedThrough;
  const locked = lockedDay && !record.unlocked;
  const selected = selection.some((r) => r.id === record.id);
  const toCopy = selected && selection.length > 1 ? selection : [record];
  const icon = "mr-2 h-4 w-4 text-muted-foreground";
  return (
    <ContextMenuContent className="w-60">
      <ContextMenuLabel className="truncate text-xs font-normal text-muted-foreground">
        {record.employees ? fullName(record.employees) : "Record"} · {weekday(record.work_date)} {record.work_date}
      </ContextMenuLabel>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={onOpen}><PanelRightOpen className={icon} />Open<ContextMenuShortcut>Click</ContextMenuShortcut></ContextMenuItem>
      <ContextMenuItem onSelect={() => navigate({ to: "/employees/$id", params: { id: record.employee_id } })}><User className={icon} />Open employee</ContextMenuItem>
      <ContextMenuItem onSelect={onToggle}><CheckSquare className={icon} />{selected ? "Deselect" : "Select"}</ContextMenuItem>
      <ContextMenuItem onSelect={() => copy(toCopy, employees, lockedThrough)} disabled={toCopy.every((r) => employees.get(r.employee_id)?.active === false)}>
        <CalendarPlus className={icon} />{toCopy.length > 1 ? `Copy ${toCopy.length} selected to next week` : "Copy to next week"}
      </ContextMenuItem>
      {lockedDay && (
        <>
          <ContextMenuSeparator />
          {locked
            ? <ContextMenuItem onSelect={() => onSetUnlocked(true)}><LockOpen className={icon} />Unlock this record</ContextMenuItem>
            : <ContextMenuItem onSelect={() => onSetUnlocked(false)}><Lock className={icon} />Lock again</ContextMenuItem>}
        </>
      )}
      {!locked && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={onDelete} className="text-destructive focus:text-destructive"><Trash2 className="mr-2 h-4 w-4" />Delete<ContextMenuShortcut>Ctrl+Z undoes</ContextMenuShortcut></ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  );
}

/**
 * Gives records again a week later, by the same rules as "Copy a week" (planNextWeek, built on planCopy): times,
 * break, hours, shift and note come along, manual pay and the lock don't; a shift already there or a locked day is
 * left out, and so are resigned employees; a different record that day is asked about first. Several records are
 * backed up first, like Copy a week, and go in one insert, so one Ctrl+Z takes them all back.
 */
export function useCopyToNextWeek() {
  const mode = useDataMode();
  const qc = useQueryClient();
  return async (records: RecordWithEmp[], employees: ReadonlyMap<string, Employee>, lockedThrough: string | null) => {
    const nameOf = (id: string) => { const e = employees.get(id); return e ? fullName(e) : "This person"; };
    const at = (d: string) => `${weekday(d)} ${d}`;
    const working = records.filter((r) => employees.get(r.employee_id)?.active !== false);
    const resigned = records.length - working.length;
    if (!working.length) { toast.error(resigned === 1 ? `${nameOf(records[0]!.employee_id)} has resigned, so nothing was copied.` : "Everyone chosen has resigned, so nothing was copied."); return; }
    const days = working.map((r) => addDays(r.work_date, 7)).sort();
    const existing = await storeFor(mode).listRecordKeys(days[0]!, days[days.length - 1]!);
    const plan = planNextWeek(working, lockedThrough, existing);
    const one = records.length === 1 ? records[0]! : null;
    if (!plan.add.length) {
      if (one) toast[plan.locked ? "error" : "info"](plan.locked ? `${at(days[0]!)} is locked as paid, so nothing was copied.` : `${nameOf(one.employee_id)} already has this shift on ${at(days[0]!)}.`);
      else toast.info(`Nothing was copied: ${leftOut(plan.duplicates, plan.locked, resigned)}.`);
      return;
    }
    const clashes = sameDayClashes(plan.add, existing);
    if (clashes.length) {
      const answer = await askChoice({
        title: clashes.length === 1 ? "Already has a different record that day" : `${clashes.length} days already have a different record`,
        detail: "Adding the copy as well would pay the day twice. That's right only if they really worked twice, e.g. a day and a night shift.",
        items: clashes.map((c) => `${nameOf(c.employee_id)} · ${at(c.work_date)} · already ${c.existing.map(describeRecord).join(", ")}`),
        choices: [{ id: "cancel", label: "Cancel", primary: true }, { id: "add", label: "Add anyway", danger: true }],
      });
      if (answer?.id !== "add") return;
    }
    if (!one) await backupBefore("copy-week");
    const { error } = await db().insert("time_records", plan.add);
    if (error) { toast.error(`Nothing was copied: ${error.message}`); return; }
    const skipped = leftOut(plan.duplicates, plan.locked, resigned);
    toast.success(one ? `Copied to ${at(plan.add[0]!.work_date)}. Ctrl+Z takes it back.`
      : `Copied ${plan.add.length} record${plan.add.length === 1 ? "" : "s"} to the next week${skipped ? ` (left out: ${skipped})` : ""}. Ctrl+Z takes them back.`);
    qc.invalidateQueries({ queryKey: ["records"] });
  };
}

/** "2 already there, 1 on a locked day" */
function leftOut(duplicates: number, locked: number, resigned: number) {
  return [
    duplicates && `${duplicates} already there`,
    locked && `${locked} on a locked day`,
    resigned && `${resigned} for someone who resigned`,
  ].filter(Boolean).join(", ");
}
