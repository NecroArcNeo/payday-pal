import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { db, undoable } from "@/lib/db/mode";
import { AppShell } from "@/components/AppShell";
import { ProfileForm, profileValues, type ProfileValues } from "@/components/ProfileForm";
import { codeTakenMessage, employeeWithCode, friendlySaveError } from "@/lib/employee-code";
import { fullName, money, useEmployees, usePayRates, useShifts, weekday } from "@/lib/payroll";
import { currentAfterDelete, SINCE_START, type StoredRate } from "@/lib/pay-rates";
import { changeEmployeeRate } from "@/lib/rate-change";
import { shiftFor } from "@/lib/pay";
import { EMPLOYEE_SECTIONS as sections } from "@/lib/employee-fields";
import { ArrowLeft, X } from "lucide-react";
import { DEFAULT_SETTINGS, ReportChart } from "@/components/ReportChart";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const TABS = { details: "Details", rates: "Pay rates", chart: "Pay & hours" } as const;
type Tab = keyof typeof TABS;
/** `?tab=` opens the profile on a tab, so going back (or a link) returns to the one you were on. */
type ProfileSearch = { tab?: Tab };

export const Route = createFileRoute("/_authenticated/employees_/$id")({
  head: () => ({ meta: [{ title: "Employee profile — Meridian Payroll" }] }),
  validateSearch: (s: Record<string, unknown>): ProfileSearch => (typeof s["tab"] === "string" && s["tab"] in TABS && s["tab"] !== "details" ? { tab: s["tab"] as Tab } : {}),
  component: ProfilePage,
  notFoundComponent: () => <div className="p-8">Employee not found.</div>,
  errorComponent: ({ error }) => <div className="p-8">{(error as Error).message}</div>,
});

const required = ["employee_code", "first_name", "last_name"];
/** The profile's chart starts on pay per month over the last 6 months; changes are remembered (one choice for every profile). */
const PROFILE_CHART = { ...DEFAULT_SETTINGS, range: "last_6_months" as const, group: "month" as const };

function ProfilePage() {
  const { id } = Route.useParams();
  const tab = Route.useSearch().tab ?? "details";
  const navigate = useNavigate({ from: Route.fullPath });
  const qc = useQueryClient();
  const { data: employees = [], isLoading } = useEmployees();
  const emp = employees.find((e) => e.id === id);
  const { data: shifts = [] } = useShifts();
  const { data: rateHistory } = usePayRates();
  const history: StoredRate[] = rateHistory?.get(id) ?? [];
  const source = useMemo(() => (emp ? profileValues(emp) : null), [emp]);

  if (isLoading) return <AppShell eyebrow="Profile" title="Loading…"><div /></AppShell>;
  if (!emp) return <AppShell eyebrow="Profile" title="Not found"><Link to="/employees" className="underline">Back to employees</Link></AppShell>;

  // The rate history and the profile are one undo step.
  const save = (v: ProfileValues) => undoable(`saved ${fullName(emp)}'s profile`, () => saveProfile(v));
  const saveProfile = async ({ form, custom }: ProfileValues) => {
    for (const k of required) if (!form[k]?.trim()) { toast.error("Employee ID, first and last name are required"); return; }
    const owner = employeeWithCode(employees, form["employee_code"] ?? "", id);
    if (owner) { toast.error(codeTakenMessage(form["employee_code"] ?? "", owner)); return; }
    let rate = Number(form["hourly_rate"]);
    if (!Number.isFinite(rate) || rate < 0) { toast.error("Hourly rate must be a positive number"); return; }
    // A new rate: ask from which day, and keep the old one for the days before.
    const oldRate = Number(emp.hourly_rate);
    if (rate !== oldRate) {
      try {
        const current = await changeEmployeeRate(id, history, oldRate, rate);
        if (current === null) return;
        rate = current;
      } catch (e) { toast.error(`Nothing was saved: ${(e as Error).message}`); return; }
    }
    const row: Record<string, string | number | null> = {};
    for (const s of sections) for (const f of s.fields) row[f.k] = form[f.k]?.trim() || null;
    row["hourly_rate"] = rate;
    row["notes"] = form["notes"]?.trim() || null;
    row["shift_id"] = form["shift_id"] || shiftFor(null, shifts).id;
    row["pay_type"] = form["pay_type"] === "salary" ? "salary" : "hourly";
    (row as Record<string, unknown>)["active"] = form["active"] !== "false";
    const cf: Record<string, string> = {};
    for (const [k, v] of Object.entries(custom)) if (v.trim()) cf[k] = v.trim().slice(0, 1000);
    (row as Record<string, unknown>)["custom_fields"] = cf;
    const { error } = await db().update("employees", id, row as never);
    if (error) { toast.error(friendlySaveError(error.message)); return; }
    toast.success("Profile saved");
    qc.invalidateQueries({ queryKey: ["employees"] });
  };

  return (
    <AppShell eyebrow="Profile" title={fullName(emp)}>
      <div className="flex items-center justify-between gap-3">
        <Link to="/employees" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> All employees</Link>
        <Link to="/timesheet" search={{ employee: emp.id }} className="text-sm text-muted-foreground underline hover:text-foreground">View timesheet</Link>
      </div>
      {/* The tab is in the address (replace: switching tabs isn't a step for Back). */}
      <Tabs value={tab} onValueChange={(v) => navigate({ search: v === "details" ? {} : { tab: v as Tab }, replace: true })}>
        <TabsList>
          {Object.entries(TABS).map(([k, label]) => <TabsTrigger key={k} value={k}>{label}</TabsTrigger>)}
        </TabsList>
        {/* Kept mounted while hidden, so unsaved edits survive a look at another tab. */}
        <TabsContent value="details" forceMount className="mt-4 data-[state=inactive]:hidden">
          <ProfileForm source={source} employees={employees} submitLabel="Save profile" onSave={save} />
        </TabsContent>
        <TabsContent value="rates" className="mt-4">
          <RateHistory employeeId={id} history={history} currentRate={Number(emp.hourly_rate)} />
        </TabsContent>
        <TabsContent value="chart" className="mt-4 space-y-3">
          <div className="flex justify-end">
            <Link to="/reports" search={{ emp: emp.id }} className="text-sm text-muted-foreground underline hover:text-foreground">Open in Reports</Link>
          </div>
          <ReportChart prefKey="profile" employeeIds={[emp.id]} single defaults={PROFILE_CHART} height={260} subject={fullName(emp)} />
        </TabsContent>
      </Tabs>
    </AppShell>
  );
}

/** Every rate the employee has been paid, newest first. Deleting a wrong entry pays its days at the rate before it. */
function RateHistory({ employeeId, history, currentRate }: { employeeId: string; history: StoredRate[]; currentRate: number }) {
  const qc = useQueryClient();
  const rows = [...history].sort((a, b) => b.effective_from.localeCompare(a.effective_from));
  const remove = (r: StoredRate) => undoable("deleted a pay rate", () => removeRate(r));
  const removeRate = async (r: StoredRate) => {
    const prev = rows[rows.indexOf(r) + 1];
    if (!confirm(`Delete the ${money(Number(r.hourly_rate))} rate ${r.effective_from === SINCE_START ? "kept from the start" : `from ${r.effective_from}`}?

Its days will be paid ${prev ? money(Number(prev.hourly_rate)) : "at the next rate"} instead, so past pay totals can change.`)) return;
    const { error } = await db().remove("pay_rates", r.id);
    if (error) { toast.error(error.message); return; }
    const current = currentAfterDelete(history, r.id, currentRate);
    if (current !== currentRate) {
      const { error: e2 } = await db().update("employees", employeeId, { hourly_rate: current });
      if (e2) toast.error(e2.message);
    }
    qc.invalidateQueries({ queryKey: ["employees"] });
  };
  return (
    <div className="glass-panel p-5">
      <div className="font-display font-extrabold tracking-tight">Pay rate history</div>
      <p className="mt-1 text-xs text-muted-foreground">Each day is paid the rate in force that day. Change the hourly rate on the Details tab to add one; you'll be asked from which day.</p>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No changes yet: every day is paid {money(currentRate)}.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border text-sm">
          {rows.map((r, i) => (
            <li key={r.id} className="flex items-center justify-between gap-3 py-2">
              <span>
                <span className="font-mono">{money(Number(r.hourly_rate))}</span>
                <span className="ml-2 text-muted-foreground">{r.effective_from === SINCE_START ? "before that" : `from ${weekday(r.effective_from)} ${r.effective_from}`}</span>
                {i === 0 && <span className="ml-2 rounded-md bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground ring-1 ring-border">current</span>}
              </span>
              {rows.length > 1 && (
                <button type="button" onClick={() => remove(r)} aria-label={`Delete the rate from ${r.effective_from}`} title="Delete this entry (if it was a mistake)" className="text-muted-foreground hover:text-destructive">
                  <X className="h-4 w-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
