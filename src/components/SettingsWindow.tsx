import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Moon, RotateCcw, Sun } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { btnGhost } from "@/components/AppShell";
import { PayRulesPanel } from "@/components/PayRulesPanel";
import { ShiftsPanel } from "@/components/ShiftsPanel";
import { LimitsEditor } from "@/components/RecordWarnings";
import { MarksPanel } from "@/components/RowMarks";
import { BreakUnitToggle } from "@/components/BreakField";
import { PrivateFieldsPanel } from "@/components/PrivateFieldsPanel";
import { SecurityPanel } from "@/components/SecurityPanel";
import { BackupCopyPanel } from "@/components/BackupCopyPanel";
import { toggleTheme } from "@/components/ThemeToggle";
import { closeSettings, openSettings, SETTINGS_SECTIONS, useSettingsWindow, type SettingsSection } from "@/lib/settings-window";
import { useEmployees, useFieldDefs, usePayrollSettings, useShifts } from "@/lib/payroll";
import { db } from "@/lib/db/mode";
import { localDb } from "@/lib/db/local";
import { pruneHistory } from "@/lib/db/history";
import { saveBackup } from "@/lib/db/backups";
import { exportSnapshot } from "@/lib/db/snapshot";
import { askConfirm } from "@/lib/choice-prompt";
import { Switch } from "@/components/ui/switch";
import { clearAlias, useLabels } from "@/lib/labels";
import { EMPLOYEE_SECTIONS } from "@/lib/employee-fields";
import { customKey } from "@/lib/db/privacy";

/**
 * The app's Settings window: one place for the settings that used to sit on different pages (overtime rules and
 * shifts from Payroll, privacy, security and backup copies from Sync & backup, the checks' limits, row colours,
 * display choices). A modal dialog with a list of sections; `openSettings(section)` opens it from anywhere (the
 * header's gear, Ctrl+, , Ctrl+K, "Pay rules" on Payroll…). Each section is the same component the page used, so
 * a setting works the same wherever it's changed.
 */
export function SettingsWindow() {
  const section = useSettingsWindow();
  // Ctrl+, opens it, as in most desktop apps.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ",") { e.preventDefault(); openSettings(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const sections = SETTINGS_SECTIONS.filter((s) => s.id in PANES);
  const current = section && section in PANES ? section : sections[0]!.id;

  return (
    <Dialog open={section !== null} onOpenChange={(o) => { if (!o) closeSettings(); }}>
      <DialogContent className="flex h-[min(52rem,90vh)] max-w-6xl gap-0 overflow-hidden p-0">
        <nav className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-border bg-secondary/40 p-3" aria-label="Settings sections">
          <DialogTitle className="px-3 pb-3 pt-1 font-display text-lg font-extrabold tracking-tight">Settings</DialogTitle>
          {sections.map((s) => (
            <button key={s.id} type="button" onClick={() => openSettings(s.id)} aria-current={s.id === current ? "page" : undefined}
              className={`rounded-lg px-3 py-2 text-left text-sm ${s.id === current ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto p-6">
          <DialogDescription className="sr-only">Settings for the whole app</DialogDescription>
          <div className="space-y-5">{PANES[current]!()}</div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const Heading = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div>
    <h2 className="font-display text-xl font-extrabold tracking-tight">{title}</h2>
    {children && <p className="mt-1 text-sm text-muted-foreground">{children}</p>}
  </div>
);

/** What each section shows. A section without an entry isn't listed. */
const PANES: Partial<Record<SettingsSection, () => ReactNode>> = {
  features: () => <FeaturesPane />,
  pay: () => <PayPane />,
  checks: () => (
    <>
      <Heading title="Checks & colours">What the Payroll page flags before paying, and how Time records rows are coloured. Remembered on this computer.</Heading>
      <div className="glass-panel overflow-hidden">
        <div className="px-5 pt-4 font-display font-extrabold tracking-tight">Things to check: limits</div>
        <LimitsEditor onClose={() => toast.success("Limits saved")} />
      </div>
      <div className="glass-panel overflow-hidden">
        <div className="px-5 pt-4 font-display font-extrabold tracking-tight">Row colours and tags on Time records</div>
        <MarksPanel onClose={closeSettings} />
      </div>
    </>
  ),
  display: () => <DisplayPane />,
  privacy: () => (
    <>
      <Heading title="Privacy & security">Which employee details never leave this computer, the app password and the recovery key.</Heading>
      <PrivateFieldsPanel />
      <SecurityPanel />
    </>
  ),
  history: () => <HistoryPane />,
  backups: () => (
    <>
      <Heading title="Backups">
        Backups are saved automatically every 30 minutes while there are changes, when the app closes, and before every restore, pull, push, import or update.
        The list of backups, downloading a backup file and restoring are on <Link to="/sync" onClick={closeSettings} className="underline">Sync & backup</Link>.
      </Heading>
      <BackupCopyPanel />
    </>
  ),
};

/** The parts of payroll some people don't need: off by default, and switching one off only hides it (nothing is deleted). */
function FeaturesPane() {
  const qc = useQueryClient();
  const { data: settings } = usePayrollSettings();
  const [busy, setBusy] = useState(false);
  if (!settings) return null;
  const set = async (patch: { deductions_on?: boolean; pay_runs_on?: boolean }) => {
    setBusy(true);
    const { error } = await db().saveSettings(patch);
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    void qc.invalidateQueries({ queryKey: ["payroll-settings"] });
  };
  const features = [
    {
      key: "deductions_on" as const, on: settings.deductions_on, title: "Deductions and net pay",
      detail: "Take amounts from each person's gross pay (tax, a health plan, a loan repayment): a fixed amount once per pay period, per week or once, or a percent of gross. Adds a Deductions tab to each profile, Deductions and Net pay columns on Payroll, and net pay to payslips (timesheet exports).",
    },
    {
      key: "pay_runs_on" as const, on: settings.pay_runs_on, title: "Pay runs",
      detail: "Record each period you pay: who got what (hours, gross, deductions, net) is saved as it was, the period's days are locked as paid, and payslips can show year-to-date totals. Adds Record pay run and a list of past runs to Payroll.",
    },
  ];
  return (
    <>
      <Heading title="Features">Turn on only what you use. Turning a feature off hides it; nothing you entered is deleted, and turning it back on brings it all back.</Heading>
      {features.map((f) => (
        <label key={f.key} className="glass-panel flex cursor-pointer items-start gap-4 p-5">
          <Switch checked={f.on} disabled={busy} onCheckedChange={(on) => void set({ [f.key]: on })} className="mt-0.5" />
          <span>
            <span className="block font-display font-extrabold tracking-tight">{f.title}</span>
            <span className="mt-1 block text-sm text-muted-foreground">{f.detail}</span>
          </span>
        </label>
      ))}
    </>
  );
}

const KEEP_CHOICES: { days: number | null; label: string }[] = [
  { days: null, label: "Forever" }, { days: 365 * 7, label: "7 years" }, { days: 365 * 3, label: "3 years" }, { days: 365, label: "1 year" },
];

/** How long the edit history is kept (payroll_settings.history_keep_days), and trimming it now. */
function HistoryPane() {
  const qc = useQueryClient();
  const { data: settings } = usePayrollSettings();
  const [busy, setBusy] = useState(false);
  if (!settings) return null;
  const keep = settings.history_keep_days;
  const choose = async (days: number | null) => {
    setBusy(true);
    try {
      const { error } = await db().saveSettings({ history_keep_days: days });
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["payroll-settings"] });
      if (days === null) return;
      const db0 = await localDb();
      const { rows } = await db0.query<{ n: number }>("select count(*) as n from _history where at < $1", [new Date(Date.now() - days * 86_400_000).toISOString()]);
      const n = Number(rows[0]?.n ?? 0);
      if (!n) return;
      if (!(await askConfirm({
        title: `Remove ${n} older history ${n === 1 ? "entry" : "entries"} now?`,
        detail: "They'd be removed the next time the app starts anyway. A backup is saved first, so they can still be found there.",
        confirm: "Remove them now", cancel: "Leave them until then",
      }))) return;
      await saveBackup("automatic", await exportSnapshot(db0));
      await pruneHistory(db0, days);
      await qc.invalidateQueries({ queryKey: ["history"] });
      toast.success(`Removed ${n} older history ${n === 1 ? "entry" : "entries"}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Heading title="Edit history">
        Every change made on this computer is listed on the <Link to="/history" onClick={closeSettings} className="underline">Edit history</Link> page, and each employee's and record's own changes on their profile and side panel.
        It stays on this computer (backups keep it too) and is never sent to the cloud.
      </Heading>
      <div className="glass-panel space-y-3 p-5">
        <div className="font-display font-extrabold tracking-tight">Keep history for</div>
        <div className="flex flex-wrap gap-2">
          {KEEP_CHOICES.map((c) => (
            <button key={c.label} type="button" disabled={busy} aria-pressed={keep === c.days} onClick={() => void choose(c.days)}
              className={`rounded-lg px-3 py-1.5 text-sm ring-1 ring-border ${keep === c.days ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`}>
              {c.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Older entries are removed when the app starts. Payroll records often have to be kept for several years, so check what applies to you before shortening it.</p>
      </div>
    </>
  );
}

function PayPane() {
  const qc = useQueryClient();
  const { data: shifts = [] } = useShifts();
  const { data: employees = [] } = useEmployees();
  return (
    <>
      <Heading title="Pay rules">
        How hours are paid. These are payroll data: they sync and are in backups. New employees start with the details on the{" "}
        <Link to="/employees/template" onClick={closeSettings} className="underline">new-employee template</Link>.
      </Heading>
      <PayRulesPanel />
      <ShiftsPanel shifts={shifts} employees={employees} onChange={() => qc.invalidateQueries({ queryKey: ["shifts"] })} />
    </>
  );
}

function DisplayPane() {
  const [dark, setDark] = useState(() => typeof document !== "undefined" && document.documentElement.classList.contains("dark"));
  const theme = (want: boolean) => { if (want !== dark) { toggleTheme(); setDark(want); } };
  const choice = (on: boolean) => `rounded-md px-3 py-1 text-sm ${on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`;
  return (
    <>
      <Heading title="Display">How the app looks on this computer.</Heading>
      <div className="glass-panel space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="w-40 text-sm font-medium">Theme</span>
          <div className="inline-flex rounded-lg bg-secondary p-0.5 ring-1 ring-border" role="group" aria-label="Theme">
            <button type="button" className={choice(!dark)} aria-pressed={!dark} onClick={() => theme(false)}><Sun className="mr-1 inline h-3.5 w-3.5" />Light</button>
            <button type="button" className={choice(dark)} aria-pressed={dark} onClick={() => theme(true)}><Moon className="mr-1 inline h-3.5 w-3.5" />Night</button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="w-40 text-sm font-medium">Show breaks in</span>
          <BreakUnitToggle />
        </div>
      </div>
      <RenamedLabels />
    </>
  );
}

/** Every label the user renamed (EditableLabel), with its real name where it's known, and a way to put it back. */
function RenamedLabels() {
  const { aliases } = useLabels();
  const { data: defs = [] } = useFieldDefs();
  const known = new Map<string, string>([
    ...EMPLOYEE_SECTIONS.flatMap((s) => [[`section:${s.title}`, `${s.title} (section)`] as [string, string], ...s.fields.map((f) => [f.k, f.label] as [string, string])]),
    ...defs.map((d) => [customKey(d.id), d.label] as [string, string]),
  ]);
  const realName = (key: string) => known.get(key) ?? (key.startsWith("extra:") ? `${key.slice(6)} (extra pay)` : key.startsWith("nav:") ? `${key.slice(4)} page` : key.replace(/_/g, " "));
  const entries = Object.entries(aliases).sort((a, b) => a[1].localeCompare(b[1]));
  return (
    <div className="glass-panel overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <div className="font-display font-extrabold tracking-tight">Renamed labels</div>
          <p className="text-xs text-muted-foreground">Click a column or field name anywhere in the app to rename it. The real name is kept: putting it back changes nothing else.</p>
        </div>
        {entries.length > 1 && <button type="button" className={btnGhost} onClick={() => { for (const [k] of entries) clearAlias(k); }}>Put all back</button>}
      </div>
      {entries.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">Nothing renamed.</p>
      ) : (
        <ul className="divide-y divide-border">
          {entries.map(([k, alias]) => (
            <li key={k} className="flex items-center gap-3 px-5 py-2.5 text-sm">
              <span className="font-medium">{alias}</span>
              <span className="text-muted-foreground">for {realName(k)}</span>
              <button type="button" className={`${btnGhost} ml-auto`} onClick={() => clearAlias(k)}><RotateCcw className="mr-1 inline h-3.5 w-3.5" />Put back</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
