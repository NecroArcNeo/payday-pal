import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowRight, BarChart3, CalendarHeart, CalendarRange, ChevronsUpDown, ClipboardPaste, Clock, Cloud, Columns3, CopyPlus, Database, Download, FileSpreadsheet,
  Files, FileText, Gift, Grid3x3, History, HardDriveDownload, Lock, Moon, Percent, Receipt, RotateCcw, Search, Settings, ShieldCheck, Tag, Timer,
  TriangleAlert, Undo2, Upload, UserPlus, Users, Zap,
} from "lucide-react";
import { openSettings, SETTINGS_SECTIONS } from "@/lib/settings-window";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { toggleTheme } from "@/components/ThemeToggle";
import { matchCommands } from "@/lib/command-search";
import { useLabels } from "@/lib/labels";
import { usePayrollSettings } from "@/lib/payroll";
import { revealFeature, type JumpOptions } from "@/lib/jump";
import { FOLD_PREF } from "@/lib/fold";
import { setPref } from "@/lib/prefs";
import { saveBackup } from "@/lib/db/backups";
import { localDb } from "@/lib/db/local";
import { exportSnapshot } from "@/lib/db/snapshot";

// Ctrl+K: one box that finds any page or feature as you type, matched by matchCommands (src/lib/command-search.ts);
// cmdk only draws the list and handles the arrow keys, so its own fuzzy filter is off. It deliberately never lists
// employees or anything about them (names, IDs, departments): it only takes you to features. People are found with the
// search on Employees, Time records and the other pages.

type Page = { readonly to: string; readonly label: string };

/** Words people might type for a page that aren't in its name: other names for it, and what it's for. */
const PAGE_WORDS: Record<string, string> = {
  "/dashboard": "home overview start main summary this week",
  "/employees": "staff people workers team roster profiles personnel crew members hire",
  "/records": "hours shifts clock in out entries add punch timecard time card log attendance rota schedule",
  "/timesheet": "export excel pdf print one person payslip pay slip stub statement",
  "/import": "excel csv file upload spreadsheet load bring in xlsx paste",
  "/payroll": "pay run gross wages salary salaries calculate pay day period lock overtime",
  "/reports": "charts summary graphs compare statistics stats trends analysis totals",
  "/sync": "backup restore cloud push pull save copy recover",
  "/history": "changes audit log who when undo trail activity edits",
};
/** Extra words that find each Settings section. */
const SECTION_WORDS: Record<string, string> = {
  features: "deductions net pay runs turn on off enable disable options",
  pay: "overtime threshold multiplier weekend shifts rules time and a half double usual hours rates",
  holidays: "public holiday bank christmas new year paid day off holiday pay vacation leave festive stat statutory",
  checks: "limits warnings long day break colours colors tags rows highlight mistakes",
  display: "theme dark night light breaks minutes hours labels rename appearance look",
  privacy: "private fields password recovery key security encryption lock protect",
  backups: "copy usb drive folder automatic external disk",
  history: "edit history audit changes keep delete old",
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
      <button type="button" onClick={() => setOpen(true)} title="Find a page or a feature (Ctrl+K)"
        className="flex items-center gap-2 rounded-xl bg-secondary px-3 py-2 text-xs text-muted-foreground ring-1 ring-border hover:text-foreground">
        <Search className="h-3.5 w-3.5" />Search
        <kbd className="rounded bg-background px-1.5 py-0.5 font-mono text-[10px] ring-1 ring-border">Ctrl K</kbd>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="top-[20%] max-w-xl translate-y-0 overflow-hidden p-0 sm:max-w-xl">
          <DialogTitle className="sr-only">Search pages and features</DialogTitle>
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
  const { label } = useLabels();
  const { data: settings } = usePayrollSettings();
  const icon = (I: typeof Search) => <I className="mr-2 h-4 w-4 text-muted-foreground" />;

  const pageItems: Item[] = pages.map((p) => ({
    id: `page:${p.to}`, label: label(`nav:${p.to}`, p.label), keywords: PAGE_WORDS[p.to] ?? "", icon: icon(ArrowRight),
    run: () => navigate({ to: p.to }),
  }));
  // Most actions go to the page and point at the feature there (revealFeature: unfolds its box, scrolls, flashes it,
  // and presses it when it opens a dialog), so a search ends on the thing itself rather than somewhere on a page.
  const jump = (to: string, find: string, opts: JumpOptions & { hint?: string } = {}) => () => {
    void navigate({ to });
    revealFeature(find, opts);
    if (opts.hint) toast.info(opts.hint);
  };
  const go = (to: string, hint: string) => () => { void navigate({ to }); toast.info(hint); };
  // Features switched off in Settings: say so and open the switch, rather than pointing at a button that isn't there.
  const needs = (on: boolean | undefined, name: string, run: () => void) => (on ? run : () => {
    openSettings("features");
    toast.info(`${name} is switched off. Turn it on here (your data is kept either way).`);
  });
  const actions: Item[] = [
    // Time records
    { id: "add-records", label: "Add time records", keywords: "new record enter hours clock in out shift punch timecard log time entry attendance", icon: icon(Clock), run: jump("/records", "records:new", { focus: true }) },
    { id: "paste-rows", label: "Paste rows from Excel", keywords: "clipboard spreadsheet google sheets copy paste table rows import", icon: icon(ClipboardPaste), run: jump("/records", "paste-rows", { hint: "Copy rows in Excel (or anywhere), then press Paste rows or Ctrl+V on this page." }) },
    { id: "copy-week", label: "Copy a week of shifts", keywords: "repeat roster schedule rota next week duplicate again", icon: icon(CopyPlus), run: jump("/records", "copy-week", { click: true }) },
    { id: "patterns", label: "Fill weeks from a pattern", keywords: "patterns usual week template schedule roster rota repeat recurring regular", icon: icon(CalendarRange), run: jump("/records", "patterns", { click: true }) },
    { id: "grid", label: "Edit records like a spreadsheet", keywords: "edit in cells grid excel inline type table quick change", icon: icon(Grid3x3), run: jump("/records", "edit-in-cells", { box: "records:list", hint: "Switch on Edit in cells, then click a cell and type." }) },
    { id: "find-records", label: "Find time records", keywords: "search filter list entries look up shifts hours", icon: icon(Search), run: jump("/records", "records:list") },
    // Payroll
    { id: "run-payroll", label: "Run payroll", keywords: "pay period gross wages salary calculate pay day how much owed", icon: icon(Zap), run: jump("/payroll", "payroll:table") },
    { id: "lock", label: "Lock a paid period", keywords: "payroll close finish freeze paid lock done", icon: icon(Lock), run: jump("/payroll", "pay-lock") },
    { id: "pay-run", label: "Record a pay run", keywords: "paid payday pay run save mark as paid", icon: icon(Receipt), run: needs(settings?.pay_runs_on, "Pay runs", jump("/payroll", "record-pay-run")) },
    { id: "pay-runs", label: "Past pay runs", keywords: "pay runs list previous paid periods history", icon: icon(Receipt), run: needs(settings?.pay_runs_on, "Pay runs", jump("/payroll", "payroll:runs")) },
    { id: "checks", label: "Things to check before paying", keywords: "warnings errors problems mistakes long day missing break overlap issues review", icon: icon(TriangleAlert), run: jump("/payroll", "payroll:checks") },
    { id: "extra-pay", label: "Add extra pay or a bonus", keywords: "bonus reimbursement tips commission allowance extra expenses", icon: icon(Gift), run: jump("/payroll", "payroll:extra-pay", { focus: true }) },
    { id: "columns", label: "Choose payroll columns", keywords: "columns show hide table fields", icon: icon(Columns3), run: jump("/payroll", "payroll-columns", { click: true }) },
    { id: "deductions", label: "Deductions and net pay", keywords: "tax taxes withholding garnishment deduct net take home insurance pension union dues", icon: icon(Percent),
      run: needs(settings?.deductions_on, "Deductions", go("/employees", "Open someone's profile and choose the Deductions tab, or tick several people and press Add deduction.")) },
    { id: "bulk-deduction", label: "Add a deduction to several people", keywords: "tax withholding everyone bulk many", icon: icon(Percent),
      run: needs(settings?.deductions_on, "Deductions", go("/employees", "Tick the people in the roster, then press Add deduction in the bar that appears.")) },
    // Timesheets and payslips
    { id: "export", label: "Export a timesheet", keywords: "excel pdf csv template print download one person", icon: icon(FileText), run: jump("/timesheet", "timesheet-export", { hint: "Pick the person and dates, then Export." }) },
    { id: "payslips", label: "Make payslips", keywords: "payslip pay slip pay stub paystub wage slip statement everyone", icon: icon(Files), run: jump("/timesheet", "export-several", { click: true }) },
    { id: "export-many", label: "Export several timesheets", keywords: "bulk zip everyone routine all at once", icon: icon(Files), run: jump("/timesheet", "export-several", { click: true }) },
    { id: "templates", label: "Timesheet templates", keywords: "excel template own layout format design form", icon: icon(FileSpreadsheet), run: jump("/timesheet", "timesheet-export", { hint: "Templates are in the Export menu: use one, or add your own Excel file." }) },
    // Importing
    { id: "import", label: "Import a file", keywords: "excel csv upload xlsx spreadsheet load bring in", icon: icon(Upload), run: () => navigate({ to: "/import" }) },
    // Employees
    { id: "add-employee", label: "Add an employee", keywords: "new hire staff person worker onboard recruit", icon: icon(UserPlus), run: jump("/employees", "employees:add", { focus: true }) },
    { id: "bulk-employees", label: "Edit several employees", keywords: "bulk change many department rate everyone", icon: icon(Users), run: go("/employees", "Tick the people in the roster (or drag across them), then press Edit.") },
    { id: "rate", label: "Change someone's pay rate", keywords: "raise wage increase hourly rate salary pay rise", icon: icon(Users), run: go("/employees", "Open their profile and change the hourly rate; you'll be asked from which day.") },
    { id: "roster", label: "Find an employee", keywords: "staff list roster search people", icon: icon(Users), run: jump("/employees", "employees:roster") },
    // Reports
    { id: "reports", label: "Charts and reports", keywords: "graph chart statistics compare trends analysis totals", icon: icon(BarChart3), run: () => navigate({ to: "/reports" }) },
    { id: "compare", label: "Compare with last year", keywords: "previous period year over year compare trend", icon: icon(BarChart3), run: go("/reports", "Pick Compare with: Same time last year above the chart.") },
    // Rules and settings
    { id: "overtime", label: "Overtime rules", keywords: "overtime threshold 40 hours multiplier time and a half double weekend", icon: icon(Settings), run: () => openSettings("pay") },
    { id: "shifts", label: "Shifts and their usual hours", keywords: "shift night day swing usual hours default times start end break multiplier", icon: icon(Timer), run: () => openSettings("pay") },
    { id: "holidays", label: "Public holidays", keywords: "bank holiday christmas new year vacation leave festive statutory", icon: icon(CalendarHeart), run: () => openSettings("holidays") },
    { id: "holiday-pay", label: "Add holiday pay", keywords: "paid day off holiday pay public bank", icon: icon(CalendarHeart), run: () => openSettings("holidays") },
    { id: "colours", label: "Choose row colours", keywords: "overtime tags highlight colors marks", icon: icon(Tag), run: () => openSettings("checks") },
    { id: "password", label: "App password and recovery key", keywords: "password lock security encryption protect recovery key", icon: icon(ShieldCheck), run: () => openSettings("privacy") },
    { id: "private", label: "Private fields", keywords: "privacy personal cloud hide sensitive", icon: icon(ShieldCheck), run: () => openSettings("privacy") },
    { id: "rename", label: "Rename labels", keywords: "rename column alias label wording words", icon: icon(Settings), run: () => openSettings("display") },
    { id: "break-unit", label: "Show breaks in minutes or hours", keywords: "break lunch unit minutes hours", icon: icon(Settings), run: () => openSettings("display") },
    // Backups
    { id: "backup", label: "Back up now", keywords: "save copy safe", icon: icon(Database), run: async () => {
      try {
        await saveBackup("manual", await exportSnapshot(await localDb()));
        qc.invalidateQueries({ queryKey: ["backups"] });
        toast.success("Backup saved. It's kept until you delete it.");
      } catch (e) { toast.error(`The backup wasn't saved: ${(e as Error).message}`); }
    } },
    { id: "restore", label: "Restore a backup", keywords: "restore recover go back previous version lost data undo", icon: icon(RotateCcw), run: jump("/sync", "sync:backups") },
    { id: "backup-file", label: "Download a backup file", keywords: "export save file usb email safe copy", icon: icon(Download), run: jump("/sync", "sync:files") },
    { id: "backup-check", label: "Check that backups restore", keywords: "test verify backup check working", icon: icon(Database), run: jump("/sync", "backup-check") },
    { id: "usb", label: "Copy backups to another drive", keywords: "usb external drive folder disk copy backup", icon: icon(HardDriveDownload), run: () => openSettings("backups") },
    { id: "cloud", label: "Cloud sync", keywords: "cloud push pull upload download online account sign in other computer", icon: icon(Cloud), run: jump("/sync", "sync:cloud") },
    // History and undo
    { id: "history", label: "Who changed what", keywords: "edit history audit log changes trail", icon: icon(History), run: () => navigate({ to: "/history" }) },
    { id: "undo", label: "Undo the last change", keywords: "undo revert mistake back oops ctrl z", hint: "Ctrl+Z", icon: icon(Undo2), run: () => toast.info("Press Ctrl+Z (Ctrl+Y redoes), or use the arrows at the top. Edit history lists older changes.") },
    // The app itself
    { id: "theme", label: document.documentElement.classList.contains("dark") ? "Switch to light mode" : "Switch to night mode", keywords: "dark night light theme colours colors", icon: icon(Moon), run: toggleTheme },
    { id: "unfold", label: "Show all folded boxes", keywords: "unfold expand hidden collapsed boxes open bars", icon: icon(ChevronsUpDown), run: () => { setPref(FOLD_PREF, []); toast.success("Every box is shown again."); } },
    { id: "settings", label: "Settings", keywords: "preferences options configure setup", hint: "Ctrl+,", icon: icon(Settings), run: () => openSettings() },
    ...SETTINGS_SECTIONS.map((s): Item => ({ id: `settings:${s.id}`, label: `Settings: ${s.label}`, keywords: SECTION_WORDS[s.id] ?? "", icon: icon(Settings), run: () => openSettings(s.id) })),
  ];

  const typed = q.trim() !== "";
  // Typed: pages and actions ranked together, so the best match is first whichever it is ("add time rec" is the
  // action, not the Time records page). Nothing typed: every page, then every action.
  const best = typed ? matchCommands([...pageItems, ...actions], q) : [];
  const isPage = (it: Item) => it.id.startsWith("page:");

  const row = (it: Item, extra?: ReactNode) => (
    <CommandItem key={it.id} value={it.id} onSelect={() => { onDone(); it.run(); }}>
      {it.icon}<span className="truncate">{it.label}</span>{extra}
    </CommandItem>
  );
  return (
    <Command shouldFilter={false} loop className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2.5">
      <CommandInput value={q} onValueChange={setQ} placeholder="Find a page or a feature…" className="h-12" />
      <CommandList className="max-h-[min(26rem,60vh)]">
        <CommandEmpty>Nothing matches “{q}”.</CommandEmpty>
        {typed
          ? best.length > 0 && <CommandGroup heading="Pages and actions">{best.map((it) => row(it, isPage(it) ? <CommandShortcut>page</CommandShortcut> : undefined))}</CommandGroup>
          : <>
            <CommandGroup heading="Pages">{pageItems.map((it) => row(it, <CommandShortcut>page</CommandShortcut>))}</CommandGroup>
            <CommandGroup heading="Actions">{actions.map((it) => row(it))}</CommandGroup>
          </>}
      </CommandList>
    </Command>
  );
}
