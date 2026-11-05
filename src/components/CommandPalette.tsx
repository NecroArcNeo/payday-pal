import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowRight, BarChart3, CalendarDays, Clock, Database, FileText, Moon, Search, Settings, User, Zap } from "lucide-react";
import { openSettings, SETTINGS_SECTIONS } from "@/lib/settings-window";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { toggleTheme } from "@/components/ThemeToggle";
import { matchCommands } from "@/lib/command-search";
import { searchEmployees } from "@/lib/employee-search";
import { useLabels } from "@/lib/labels";
import { fullName, useEmployees } from "@/lib/payroll";
import { saveBackup } from "@/lib/db/backups";
import { useEmployeePages } from "@/components/EmployeeMenu";
import { localDb } from "@/lib/db/local";
import { exportSnapshot } from "@/lib/db/snapshot";

// Ctrl+K: one box that finds any page, employee or action as you type. Employees are matched by searchEmployees (the
// same search as everywhere else), pages and actions by matchCommands (src/lib/command-search.ts); cmdk only draws the
// list and handles the arrow keys, so its own fuzzy filter is off.

type Page = { readonly to: string; readonly label: string };

/** Words people might type for a page that aren't in its name. */
const PAGE_WORDS: Record<string, string> = {
  "/dashboard": "home overview start",
  "/employees": "staff people workers profiles",
  "/records": "hours shifts clock entries add",
  "/timesheet": "export excel pdf print one person",
  "/import": "excel csv file upload spreadsheet",
  "/payroll": "pay run gross lock wages",
  "/reports": "charts summary graphs compare",
  "/sync": "backup restore cloud push pull",
  "/history": "changes audit log who when undo",
};
/** Extra words that find each Settings section. */
const SECTION_WORDS: Record<string, string> = {
  features: "deductions net pay runs turn on off",
  pay: "overtime threshold multiplier weekend shifts rules",
  checks: "limits warnings long day break colours tags rows",
  display: "theme dark night light breaks minutes hours labels rename",
  privacy: "private fields password recovery key security encryption",
  backups: "copy usb drive folder automatic",
  history: "edit history audit changes keep",
};

/** The header's search button, and the box it opens. Ctrl+K (⌘K on a Mac) opens or closes it from anywhere. */
export function CommandPalette({ pages }: { pages: readonly Page[] }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title="Find a page, an employee or an action (Ctrl+K)"
        className="flex items-center gap-2 rounded-xl bg-secondary px-3 py-2 text-xs text-muted-foreground ring-1 ring-border hover:text-foreground">
        <Search className="h-3.5 w-3.5" />Search
        <kbd className="rounded bg-background px-1.5 py-0.5 font-mono text-[10px] ring-1 ring-border">Ctrl K</kbd>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="top-[20%] max-w-xl translate-y-0 overflow-hidden p-0 sm:max-w-xl">
          <DialogTitle className="sr-only">Search pages, employees and actions</DialogTitle>
          {/* Only there while open, so it starts empty each time and loads nothing until it's used. */}
          {open && <Palette pages={pages} onDone={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

type Item = { id: string; label: string; keywords?: string; hint?: string; icon: ReactNode; run: () => void };

function Palette({ pages, onDone }: { pages: readonly Page[]; onDone: () => void }) {
  const [q, setQ] = useState("");
  const navigate = useNavigate();
  const qc = useQueryClient();
  const empPages = useEmployeePages();
  const { label } = useLabels();
  const { data: employees = [] } = useEmployees();
  const icon = (I: typeof Search) => <I className="mr-2 h-4 w-4 text-muted-foreground" />;

  const pageItems: Item[] = pages.map((p) => ({
    id: `page:${p.to}`, label: label(`nav:${p.to}`, p.label), keywords: PAGE_WORDS[p.to] ?? "", icon: icon(ArrowRight),
    run: () => navigate({ to: p.to }),
  }));
  const go = (to: string, hint: string) => () => { navigate({ to }); toast.info(hint); };
  const actions: Item[] = [
    { id: "backup", label: "Back up now", keywords: "save copy safe", icon: icon(Database), run: async () => {
      try {
        await saveBackup("manual", await exportSnapshot(await localDb()));
        qc.invalidateQueries({ queryKey: ["backups"] });
        toast.success("Backup saved. It's kept until you delete it.");
      } catch (e) { toast.error(`The backup wasn't saved: ${(e as Error).message}`); }
    } },
    { id: "theme", label: document.documentElement.classList.contains("dark") ? "Switch to light mode" : "Switch to night mode", keywords: "dark night light theme colours", icon: icon(Moon), run: toggleTheme },
    { id: "add-records", label: "Add time records", keywords: "hours shift clock enter new", icon: icon(Clock), run: () => navigate({ to: "/records" }) },
    { id: "copy-week", label: "Copy a week of shifts", keywords: "repeat roster next", icon: icon(CalendarDays), run: go("/records", "Copy a week is the button above the list on Time records.") },
    { id: "lock", label: "Lock a paid period", keywords: "payroll close finish", icon: icon(Zap), run: () => navigate({ to: "/payroll" }) },
    { id: "export", label: "Export a timesheet", keywords: "excel pdf csv template print", icon: icon(FileText), run: () => navigate({ to: "/timesheet" }) },
    { id: "export-many", label: "Export several timesheets", keywords: "bulk zip everyone routine", icon: icon(FileText), run: go("/timesheet", "Export several… is on the Timesheet page.") },
    { id: "import", label: "Import a file", keywords: "excel csv upload", icon: icon(FileText), run: () => navigate({ to: "/import" }) },
    { id: "add-employee", label: "Add an employee", keywords: "new hire staff person", icon: icon(User), run: () => navigate({ to: "/employees" }) },
    { id: "colours", label: "Choose row colours", keywords: "overtime tags highlight", icon: icon(Zap), run: () => openSettings("checks") },
    { id: "settings", label: "Settings", keywords: "preferences options configure", hint: "Ctrl+,", icon: icon(Settings), run: () => openSettings() },
    ...SETTINGS_SECTIONS.map((s): Item => ({ id: `settings:${s.id}`, label: `Settings: ${s.label}`, keywords: SECTION_WORDS[s.id] ?? "", icon: icon(Settings), run: () => openSettings(s.id) })),
  ];

  const typed = q.trim() !== "";
  const people = typed ? searchEmployees(employees, q).slice(0, 6) : [];
  const top = people[0];
  const forTop: Item[] = top ? [
    { id: `rec:${top.id}`, label: `Time records for ${fullName(top)}`, icon: icon(Clock), run: () => void empPages.records(top.id) },
    { id: `ts:${top.id}`, label: `Timesheet for ${fullName(top)}`, icon: icon(FileText), run: () => void empPages.timesheet(top.id) },
    { id: `rep:${top.id}`, label: `Report for ${fullName(top)}`, icon: icon(BarChart3), run: () => void empPages.report(top.id) },
  ] : [];
  const shownPages = matchCommands(pageItems, q);
  const shownActions = matchCommands(actions, q);

  const row = (it: Item, extra?: ReactNode) => (
    <CommandItem key={it.id} value={it.id} onSelect={() => { onDone(); it.run(); }}>
      {it.icon}<span className="truncate">{it.label}</span>{extra}
    </CommandItem>
  );
  return (
    <Command shouldFilter={false} loop className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2.5">
      <CommandInput value={q} onValueChange={setQ} placeholder="Find a page, an employee or an action…" className="h-12" />
      <CommandList className="max-h-[min(26rem,60vh)]">
        <CommandEmpty>Nothing matches “{q}”.</CommandEmpty>
        {people.length > 0 && (
          <CommandGroup heading="Employees">
            {people.map((e) => row(
              { id: `emp:${e.id}`, label: fullName(e), icon: icon(User), run: () => navigate({ to: "/employees/$id", params: { id: e.id } }) },
              <span className="ml-2 truncate text-xs text-muted-foreground">{[e.employee_code, e.job_title, e.department].filter(Boolean).join(" · ")}{e.active === false ? " · resigned" : ""}</span>,
            ))}
          </CommandGroup>
        )}
        {forTop.length > 0 && <CommandGroup heading={fullName(top!)}>{forTop.map((it) => row(it))}</CommandGroup>}
        {shownPages.length > 0 && <CommandGroup heading="Pages">{shownPages.map((it) => row(it, <CommandShortcut>page</CommandShortcut>))}</CommandGroup>}
        {shownActions.length > 0 && <CommandGroup heading="Actions">{shownActions.map((it) => row(it))}</CommandGroup>}
      </CommandList>
    </Command>
  );
}
