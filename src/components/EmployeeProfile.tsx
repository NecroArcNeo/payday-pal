import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { X } from "lucide-react";
import { db, undoable } from "@/lib/db/mode";
import { ProfileForm, profileValues, type ProfileValues } from "@/components/ProfileForm";
import { codeTakenMessage, employeeWithCode, friendlySaveError } from "@/lib/employee-code";
import { fullName, money, usePayRates, usePayrollSettings, useShifts, weekday, type Employee } from "@/lib/payroll";
import { currentAfterDelete, SINCE_START, type StoredRate } from "@/lib/pay-rates";
import { changeEmployeeRate } from "@/lib/rate-change";
import { shiftFor } from "@/lib/pay";
import { EMPLOYEE_SECTIONS as sections } from "@/lib/employee-fields";
import { DEFAULT_SETTINGS, ReportChart } from "@/components/ReportChart";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { askConfirm } from "@/lib/choice-prompt";
import { HistoryList } from "@/components/HistoryView";
import { DeductionsEditor } from "@/components/DeductionsEditor";
import { FoldBox } from "@/components/FoldBox";

// An employee's profile in tabs (Details, Pay rates, Pay & hours, History): the profile page shows it full width, and the
// Employees page in its side panel (EmployeePanel), so both edit the same way. The caller owns which tab is open (the
// page keeps it in the address, the panel in state).

export const PROFILE_TABS = { details: "Details", rates: "Pay rates", deductions: "Deductions", chart: "Pay & hours", history: "History" } as const;
export type ProfileTab = keyof typeof PROFILE_TABS;

const required = ["employee_code", "first_name", "last_name"];
/** The profile's chart starts on pay per month over the last 6 months; changes are remembered (one choice for every profile). */
const PROFILE_CHART = { ...DEFAULT_SETTINGS, range: "last_6_months" as const, group: "month" as const };

export function EmployeeProfile({ emp, employees, tab, onTab, onDirty }: {
  emp: Employee; employees: Employee[]; tab: ProfileTab; onTab: (t: ProfileTab) => void;
  /** Told whether the Details form has unsaved changes (the panel asks before moving to someone else). */
  onDirty?: (dirty: boolean) => void;
}) {
  const id = emp.id;
  const qc = useQueryClient();
  const { data: shifts = [] } = useShifts();
  const { data: rateHistory } = usePayRates();
  const { data: settings } = usePayrollSettings();
  const history: StoredRate[] = rateHistory?.get(id) ?? [];
  const source = useMemo(() => profileValues(emp), [emp]);

  // The rate history and the profile are one undo step, and all or nothing: a failure partway (the lock refusing a
  // rate entry, say) throws, and undoable puts back whatever was already written.
  const save = (v: ProfileValues) => undoable(`saved ${fullName(emp)}'s profile`, () => saveProfile(v))
    .catch((e: Error) => { toast.error(`Nothing was saved: ${e.message}`); });
  const saveProfile = async ({ form, custom }: ProfileValues) => {
    for (const k of required) if (!form[k]?.trim()) { toast.error("Employee ID, first and last name are required"); return; }
    const owner = employeeWithCode(employees, form["employee_code"] ?? "", id);
    if (owner) { toast.error(codeTakenMessage(form["employee_code"] ?? "", owner)); return; }
    let rate = Number(form["hourly_rate"]);
    if (!Number.isFinite(rate) || rate < 0) { toast.error("Hourly rate must be a positive number"); return; }
    // A new rate: ask from which day, and keep the old one for the days before.
    const oldRate = Number(emp.hourly_rate);
    if (rate !== oldRate) {
      const current = await changeEmployeeRate(id, history, oldRate, rate);
      if (current === null) return;
      rate = current;
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
    if (error) throw new Error(friendlySaveError(error.message));
    toast.success("Profile saved");
    qc.invalidateQueries({ queryKey: ["employees"] });
  };

  return (
    <Tabs value={tab === "deductions" && !settings?.deductions_on ? "details" : tab} onValueChange={(v) => onTab(v as ProfileTab)}>
      <TabsList>
        {/* Deductions only while that feature is on (Settings → Features). */}
        {Object.entries(PROFILE_TABS).filter(([k]) => k !== "deductions" || settings?.deductions_on).map(([k, label]) => <TabsTrigger key={k} value={k}>{label}</TabsTrigger>)}
      </TabsList>
      {/* Kept mounted while hidden, so unsaved edits survive a look at another tab. */}
      <TabsContent value="details" forceMount className="mt-4 data-[state=inactive]:hidden">
        <ProfileForm source={source} employees={employees} submitLabel="Save profile" onSave={save} onDirty={onDirty} />
      </TabsContent>
      <TabsContent value="rates" className="mt-4">
        <RateHistory employeeId={id} history={history} currentRate={Number(emp.hourly_rate)} />
      </TabsContent>
      {settings?.deductions_on && (
        <TabsContent value="deductions" className="mt-4">
          <DeductionsEditor employeeId={emp.id} />
        </TabsContent>
      )}
      <TabsContent value="chart" className="mt-4 space-y-3">
        <div className="flex justify-end">
          <Link to="/reports" search={{ emp: emp.id }} className="text-sm text-muted-foreground underline hover:text-foreground">Open in Reports</Link>
        </div>
        <ReportChart prefKey="profile" employeeIds={[emp.id]} single defaults={PROFILE_CHART} height={260} subject={fullName(emp)} />
      </TabsContent>
      <TabsContent value="history" className="mt-4">
        <div className="glass-panel overflow-hidden">
          <HistoryList filter={{ employeeId: emp.id }} empty={`No changes to ${fullName(emp)} or their records yet.`} />
        </div>
      </TabsContent>
    </Tabs>
  );
}

/** Every rate the employee has been paid, newest first. Deleting a wrong entry pays its days at the rate before it. */
function RateHistory({ employeeId, history, currentRate }: { employeeId: string; history: StoredRate[]; currentRate: number }) {
  const qc = useQueryClient();
  const rows = [...history].sort((a, b) => b.effective_from.localeCompare(a.effective_from));
  const remove = (r: StoredRate) => undoable("deleted a pay rate", () => removeRate(r));
  const removeRate = async (r: StoredRate) => {
    const prev = rows[rows.indexOf(r) + 1];
    if (!(await askConfirm({
      title: `Delete the ${money(Number(r.hourly_rate))} rate ${r.effective_from === SINCE_START ? "kept from the start" : `from ${r.effective_from}`}?`,
      detail: `Its days will be paid ${prev ? money(Number(prev.hourly_rate)) : "at the next rate"} instead, so past pay totals can change.`,
      confirm: "Delete rate", danger: true,
    }))) return;
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
    <FoldBox id="profile:rates" title="Pay rate history">
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
    </FoldBox>
  );
}
