import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BarChart3, CheckSquare, Clock, FileText, MoreHorizontal, PanelRightOpen, Trash2, User, UserCheck, UserX } from "lucide-react";
import { ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuShortcut } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { db, storeFor, useDataMode } from "@/lib/db/mode";
import { fullName, type Employee } from "@/lib/payroll";
import { keepDialogFocus } from "@/lib/choice-prompt";

// An employee's actions on the Employees roster, in one list drawn two ways: the ⋯ button at the end of the row
// (DropdownMenu) and right-clicking the row (ContextMenu, one around the whole table body, like Time records). The two
// menus are separate Radix primitives with the same parts (item, separator, label), so the list is written once and
// handed the parts it draws with.

type Part<P = object> = React.ElementType<P & { className?: string; children?: React.ReactNode }>;
type Parts = { Item: Part<{ onSelect?: () => void }>; Separator: Part; Label: Part; Shortcut: Part };
const DROPDOWN: Parts = { Item: DropdownMenuItem, Separator: DropdownMenuSeparator, Label: DropdownMenuLabel, Shortcut: DropdownMenuShortcut };
const CONTEXT: Parts = { Item: ContextMenuItem, Separator: ContextMenuSeparator, Label: ContextMenuLabel, Shortcut: ContextMenuShortcut };

export type EmployeeMenuProps = {
  emp: Employee; selected: boolean;
  onOpen: () => void; onToggle: () => void; onDelete: () => void;
};

/** Going to an employee's pages: shared by this menu and Ctrl+K. */
export function useEmployeePages() {
  const navigate = useNavigate();
  const mode = useDataMode();
  return {
    profile: (id: string) => navigate({ to: "/employees/$id", params: { id } }),
    /** Time records shows one entry type at a time: open the one their latest record uses, so they aren't hidden. */
    records: async (id: string) => {
      const latest = await storeFor(mode).listRecordsPage({ employeeIds: [id] }, 0, 1).catch(() => null);
      const kind = latest?.rows[0]?.entry_mode;
      return navigate({ to: "/records", search: { emp: id, ...(kind === "clock" || kind === "hours" ? { mode: kind } : {}) } });
    },
    timesheet: (id: string) => navigate({ to: "/timesheet", search: { employee: id, from: undefined, to: undefined } }),
    report: (id: string) => navigate({ to: "/reports", search: { emp: id } }),
  };
}

function Actions({ emp, selected, onOpen, onToggle, onDelete, parts: { Item, Separator, Label, Shortcut } }: EmployeeMenuProps & { parts: Parts }) {
  const pages = useEmployeePages();
  const qc = useQueryClient();
  const icon = "mr-2 h-4 w-4 text-muted-foreground";
  // Resigning keeps every record; they just aren't offered when adding hours. One write, so one Ctrl+Z.
  const setActive = async (active: boolean) => {
    const { error } = await db().update("employees", emp.id, { active });
    if (error) { toast.error(error.message); return; }
    toast.success(`${fullName(emp)} ${active ? "is active again" : "is marked resigned: their records stay, and they aren't offered when adding hours"}. Ctrl+Z undoes it.`);
    qc.invalidateQueries({ queryKey: ["employees"] });
  };
  return (
    <>
      <Label className="truncate text-xs font-normal text-muted-foreground">{fullName(emp)} · {emp.employee_code}</Label>
      <Separator />
      <Item onSelect={onOpen}><PanelRightOpen className={icon} />Open beside the list<Shortcut>Click</Shortcut></Item>
      <Item onSelect={() => pages.profile(emp.id)}><User className={icon} />Open full profile</Item>
      <Item onSelect={onToggle}><CheckSquare className={icon} />{selected ? "Deselect" : "Select"}</Item>
      <Separator />
      <Item onSelect={() => void pages.records(emp.id)}><Clock className={icon} />Time records</Item>
      <Item onSelect={() => pages.timesheet(emp.id)}><FileText className={icon} />Timesheet</Item>
      <Item onSelect={() => pages.report(emp.id)}><BarChart3 className={icon} />Report</Item>
      <Separator />
      {emp.active
        ? <Item onSelect={() => void setActive(false)}><UserX className={icon} />Mark resigned</Item>
        : <Item onSelect={() => void setActive(true)}><UserCheck className={icon} />Mark active again</Item>}
      <Item onSelect={onDelete} className="text-destructive focus:text-destructive"><Trash2 className="mr-2 h-4 w-4" />Delete…</Item>
    </>
  );
}

/** The ⋯ button at the end of a roster row. */
export function EmployeeMenuButton(props: EmployeeMenuProps) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger className="rounded-md p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Actions for ${fullName(props.emp)}`} title="More actions (or right-click the row)">
        <MoreHorizontal className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60" onCloseAutoFocus={keepDialogFocus}><Actions {...props} parts={DROPDOWN} /></DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The right-click menu's content, for the row that was right-clicked. */
export function EmployeeContextMenu(props: EmployeeMenuProps) {
  return <ContextMenuContent className="w-60" onCloseAutoFocus={keepDialogFocus}><Actions {...props} parts={CONTEXT} /></ContextMenuContent>;
}