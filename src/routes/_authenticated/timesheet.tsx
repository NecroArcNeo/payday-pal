import { createFileRoute, Link } from "@tanstack/react-router";
import { payslipFor } from "@/lib/export/employee-timesheet";
import { usePayslipData } from "@/lib/payslip";
import { useMemo } from "react";
import { AppShell, StatCard, btnGhost, inputCls } from "@/components/AppShell";
import { EmployeePicker } from "@/components/EmployeeSearch";
import { RECORD_PAY_COLUMNS, RecordPayCells, RecordPayHeaders, RecordShiftCell, useRecordSortColumns } from "@/components/RecordPay";
import { BreakHeader, BreakUnitToggle } from "@/components/BreakField";
import { DataTable } from "@/components/DataTable";
import { SkeletonRows } from "@/components/Loading";
import { EmailLink } from "@/components/EmailLink";
import { CategoryValue } from "@/components/ProfileCategories";
import { EditableLabel } from "@/components/EditableLabel";
import { customKey } from "@/lib/db/privacy";
import { formatBreak, useBreakUnit, type BreakUnit } from "@/lib/breaks";
import { profileSections } from "@/lib/employee-fields";
import { currentWeek, fullName, isoDate, money, useAdjustments, useAllRecords, useEmployees, useFieldDefs, usePayRates, usePayrollSettings, useShifts, weekday,
  type Adjustment, type Employee, type FieldDef, type Shift, type TimeRecord, useHolidays } from "@/lib/payroll";
import { employeePay, shiftFor, weekEnd, weekStart, type PayLine, payRules, type PayRules } from "@/lib/pay";
import { ratesBetween, type RateEntry } from "@/lib/pay-rates";
import { TimesheetExport } from "@/components/TimesheetExport";
import { BulkExport } from "@/components/BulkExport";
import { employeeTimesheet, timesheetCategories } from "@/lib/export/employee-timesheet";
import { periodPresets } from "@/lib/periods";
import { Printer } from "lucide-react";
import { SortControl, SortTh, TableSort, useTableSort } from "@/components/SortControl";
import { sortTable, type Sort, type SortColumns } from "@/lib/table-sort";
import { DateInput } from "@/components/DateInput";
import { EmployeeLink } from "@/components/EmployeeLink";
import { FoldBox } from "@/components/FoldBox";

/** A timesheet reads in time order. */
const OLDEST: Sort = { by: "date", desc: false };
/** The extra-pay table's columns. */
const EXTRA_COLUMNS: SortColumns<Adjustment> = {
  date: { label: "Pay date", kind: "date", desc: false, value: (a) => a.pay_date },
  category: { label: "Category", kind: "text", value: (a) => a.category },
  note: { label: "Note", kind: "text", value: (a) => a.note },
  amount: { label: "Amount", kind: "number", value: (a) => Number(a.amount) },
};

/** Shown in the sheet's heading, so not repeated in the details grid. */
const IN_HEADER = ["first_name", "last_name", "employee_code"];
/** Personal details stay on the profile, off timesheets that get printed and handed around. */
const onSheet = (f: { k: string; sensitive?: boolean }) => !IN_HEADER.includes(f.k) && !f.sensitive;
/** Categories the user put under Personal are personal details too. */
const PERSONAL = "Personal";

type Search = { employee?: string | undefined; from?: string | undefined; to?: string | undefined };
const isDate = (d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);

export const Route = createFileRoute("/_authenticated/timesheet")({
  head: () => ({ meta: [{ title: "Timesheet — KoPayroll" }] }),
  // The employee and range live in the URL, so a timesheet can be linked to, bookmarked or reopened.
  validateSearch: (s: Record<string, unknown>): Search => ({
    employee: typeof s["employee"] === "string" ? s["employee"] : undefined,
    from: isDate(s["from"]) ? s["from"] : undefined,
    to: isDate(s["to"]) ? s["to"] : undefined,
  }),
  component: TimesheetPage,
});

function TimesheetPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const week = currentWeek();
  const from = search.from ?? week.from;
  const to = search.to ?? week.to;
  const set = (patch: Search) => navigate({ search: (s) => ({ ...s, ...patch }), replace: true });

  const { data: employees = [] } = useEmployees();
  const { data: rateHistory } = usePayRates();
  const { data: shifts = [] } = useShifts();
  const { data: defs = [] } = useFieldDefs();
  const { data: settings } = usePayrollSettings();
  const { data: holidays } = useHolidays();
  // Whole Mon–Sun weeks around the range, so weekly overtime and salary weeks are right.
  const { data: records = [], isLoading } = useAllRecords(weekStart(from), weekEnd(to));
  const { data: adjustments = [] } = useAdjustments(from, to);
  const emp = employees.find((e) => e.id === search.employee);
  const badRange = from > to;

  return (
    <AppShell eyebrow="Timesheet" title={emp ? fullName(emp) : "Timesheet"} actions={
      <div className="flex gap-2 print:hidden">
        <BulkExport from={from} to={to} />
        {emp && <button onClick={() => window.print()} className={btnGhost}><Printer className="mr-1 inline h-4 w-4" />Print</button>}
      </div>
    }>
      <FoldBox id="timesheet:pick" title="Employee and dates">
        <div className="glass-panel flex flex-wrap items-end gap-3 p-5 print:hidden">
          <label className="min-w-[16rem] flex-1">
            <span className="label-mono">Employee</span>
            <div className="mt-1"><EmployeePicker employees={employees} value={search.employee ?? ""} onChange={(id) => set({ employee: id || undefined })} /></div>
          </label>
          <label>
            <span className="label-mono">From · {weekday(from)}</span>
            <DateInput className={`${inputCls} mt-1`} value={from} onChange={(v) => isDate(v) && set({ from: v })} />
          </label>
          <label>
            <span className="label-mono">To · {weekday(to)}</span>
            <DateInput className={`${inputCls} mt-1`} value={to} onChange={(v) => isDate(v) && set({ to: v })} />
          </label>
          <div className="flex flex-wrap gap-1.5">
            {periodPresets().map((p) => (
              <button key={p.label} type="button" onClick={() => set({ from: p.from, to: p.to })}
                className={`rounded-lg px-2.5 py-1.5 text-xs ring-1 ring-border ${p.from === from && p.to === to ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </FoldBox>

      {!emp ? (
        <div className="glass-panel px-5 py-12 text-center text-muted-foreground">
          {search.employee && employees.length ? "That employee no longer exists. Pick another one above." : "Pick an employee to see their timesheet."}
        </div>
      ) : badRange ? (
        <div className="glass-panel px-5 py-12 text-center text-muted-foreground">The start date is after the end date.</div>
      ) : (
        <Sheet emp={emp} from={from} to={to} loading={isLoading}
          records={records.filter((r) => r.employee_id === emp.id)}
          adjustments={adjustments.filter((a) => a.employee_id === emp.id)}
          shifts={shifts} defs={defs} rateHistory={rateHistory?.get(emp.id)}
          rules={payRules(settings, holidays)} />
      )}
    </AppShell>
  );
}

function Sheet({ emp, from, to, records, adjustments, shifts, defs, rules, loading, rateHistory }: {
  emp: Employee; from: string; to: string; records: TimeRecord[]; loading: boolean; rateHistory: RateEntry[] | undefined;
  adjustments: Adjustment[]; shifts: Shift[]; defs: FieldDef[];
  rules: PayRules;
}) {
  const shift = shiftFor(emp.shift_id, shifts);
  const payslip = usePayslipData();
  const [breakUnit] = useBreakUnit();
  // Every rate paid in the period, oldest first; the latest for the shift and salary notes.
  const rates = ratesBetween(rateHistory, emp.hourly_rate, from, to);
  const rate = rates.at(-1)!;
  const salary = emp.pay_type === "salary";
  const pay = employeePay(records, { rate: Number(emp.hourly_rate), rates: rateHistory, shiftMultiplier: shift.multiplier, rules, payType: emp.pay_type, shifts, from, to });
  const lineById = new Map(pay.lines.map((l) => [l.id, l]));
  // Any of the table's columns (one person, so no employee; no rate column here). A timesheet reads oldest first.
  const recordCols = useRecordSortColumns<TimeRecord>(lineById, false);
  const columns = useMemo(() => {
    const { hourly_rate: _rate, ...rest } = recordCols;
    return { ...rest, date: { ...rest["date"]!, desc: false } };
  }, [recordCols]);
  const [sort, setSort] = useTableSort("meridian-timesheet-sort", columns, OLDEST);
  const inRange = records
    .filter((r) => r.work_date >= from && r.work_date <= to)
    .sort((a, b) => a.work_date.localeCompare(b.work_date) || (a.clock_in ?? "").localeCompare(b.clock_in ?? ""));
  // By date: in time order (each day's entries by clock-in), or all of it reversed. By another column, ties stay in
  // time order (the sort is stable).
  const shown = sort.by === "date" ? (sort.desc ? inRange.reverse() : inRange) : sortTable(inRange, sort, columns);
  const [extraSort, setExtraSort] = useTableSort("meridian-timesheet-extra-sort", EXTRA_COLUMNS, { by: "date", desc: false });
  const extraRows = sortTable([...adjustments].sort((a, b) => a.pay_date.localeCompare(b.pay_date)), extraSort, EXTRA_COLUMNS);
  const extras = adjustments.reduce((s, a) => s + Number(a.amount), 0);
  // Net pay for the period, as a payslip shows it (a recorded pay run's own figures when there is one).
  const slip = payslipFor(emp.id, from, to, pay.total + extras, payslip.deductionsOf(emp.id), payslip.runs);
  // Categories filed under Personal are personal details, which stay off timesheets.
  const templateCategories = timesheetCategories(defs);
  const exportData = employeeTimesheet(emp, { from, to, today: isoDate(new Date()), records, adjustments, shifts, defs, rateHistory, rules, deductions: payslip.deductionsOf(emp.id), runs: payslip.runs });
  const lunchHours = shown.reduce((s, r) => s + r.lunch_minutes, 0) / 60;

  // Group by Mon–Sun week for subtotals. Sorted by hours or pay, a week's records are scattered, so there's one group and no subtotals.
  const weeks: { start: string; rows: TimeRecord[] }[] = [];
  if (sort.by !== "date") weeks.push({ start: "", rows: shown });
  else for (const r of shown) {
    const start = weekStart(r.work_date);
    if (weeks.at(-1)?.start !== start) weeks.push({ start, rows: [] });
    weeks.at(-1)!.rows.push(r);
  }
  const subtotal = (rows: TimeRecord[]) => {
    const ls = rows.map((r) => lineById.get(r.id)).filter((l): l is PayLine => !!l);
    const sum = (f: (l: PayLine) => number) => ls.reduce((s, l) => s + f(l), 0);
    return { hours: rows.reduce((s, r) => s + Number(r.hours), 0), regular: sum((l) => l.regular), overtime: sum((l) => l.overtime), regPay: sum((l) => l.regPay), otPay: sum((l) => l.otPay), pay: sum((l) => l.pay) };
  };

  const custom = (emp.custom_fields ?? {}) as Record<string, unknown>;
  const info = (k: string, label: string, value: React.ReactNode) => (
    <div key={k} className="min-w-0">
      <div className="label-mono"><EditableLabel k={k} name={label} /></div>
      <div className="mt-0.5 truncate text-sm" title={typeof value === "string" ? value : undefined}>{value === "" || value === null || value === undefined ? <span className="text-muted-foreground">—</span> : value}</div>
    </div>
  );
  const fieldValue = (k: string, type?: string) => {
    const v = (emp as Record<string, unknown>)[k];
    if (v === null || v === undefined || v === "") return "";
    return type === "number" && k === "hourly_rate" ? rates.map(money).join(" → ") : String(v);
  };

  const th = "px-3 py-3 font-medium whitespace-nowrap";
  const totalCells = (t: ReturnType<typeof subtotal>) => (
    <>
      <td className="px-3 py-2 text-right">{t.hours.toFixed(2)}</td>
      <td className="px-3 py-2 text-right">{t.regular.toFixed(2)}</td>
      <td className="px-3 py-2 text-right">{t.overtime.toFixed(2)}</td>
      <td className="px-3 py-2 text-right">{money(t.regPay)}</td>
      <td className="px-3 py-2 text-right">{money(t.otPay)}</td>
      <td className="px-3 py-2 text-right">{money(t.pay)}</td>
      <td />
    </>
  );

  return (
    <>
      <FoldBox id="timesheet:summary" title="Summary">
        <div className="glass-panel space-y-5 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="font-display text-xl font-extrabold tracking-tight">
                <EmployeeLink id={emp.id} name={fullName(emp)} /> <span className="font-mono text-sm font-normal text-muted-foreground">{emp.employee_code}</span>
                {!emp.active && <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 align-middle text-[10px] font-normal text-muted-foreground ring-1 ring-border">Resigned</span>}
              </div>
              <div className="text-sm text-muted-foreground">
                {weekday(from)} {from} – {weekday(to)} {to}
              </div>
            </div>
            <div className="flex gap-2">
              <TimesheetExport data={exportData} categories={templateCategories} fileName={`timesheet ${fullName(emp)} ${from} to ${to}`} />
              <Link to="/employees/$id" params={{ id: emp.id }} className={`${btnGhost} print:hidden`}>Edit profile</Link>
            </div>
          </div>
          {profileSections(defs).map((s) => (s.title === PERSONAL ? { ...s, defs: [] } : s)).filter((s) => s.fields.some(onSheet) || s.defs.length).map((s) => (
            <div key={s.title}>
              <div className="mb-2 text-xs font-semibold text-muted-foreground">{s.custom ? s.title : <EditableLabel k={`section:${s.title}`} name={s.title} />}</div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-4">
                {s.fields.filter(onSheet).map((f) => {
                  const v = fieldValue(f.k, f.type);
                  return info(f.k, f.label, f.type === "email" && v ? <EmailLink email={v} /> : v);
                })}
                {s.title === "Payroll" && (
                  <>
                    {info("pay_type", "Pay type", salary ? `Salary (${rules.threshold} h × rate a week)` : "Hourly")}
                    {info("shift", "Shift", `${shift.name}${shift.multiplier !== 1 ? ` · ×${shift.multiplier} (${money(rate * shift.multiplier)}/h)` : ""}`)}
                    {info("active", "Status", emp.active ? "Active" : "Resigned")}
                  </>
                )}
                {s.defs.map((d) => {
                  const v = custom[d.id] === undefined ? "" : String(custom[d.id]);
                  return info(customKey(d.id), d.label, v && <CategoryValue type={d.field_type} value={v} />);
                })}
              </div>
            </div>
          ))}
          {emp.notes && (
            <div>
              <div className="mb-1 text-xs font-semibold text-muted-foreground"><EditableLabel k="notes" name="Notes" /></div>
              <p className="whitespace-pre-wrap text-sm">{emp.notes}</p>
            </div>
          )}
        </div>
      </FoldBox>

      <FoldBox id="timesheet:cards" title="Totals" summary={`${money(pay.total + extras)} gross`}>
        <section className={`grid grid-cols-2 gap-4 ${slip?.net != null ? "md:grid-cols-5" : "md:grid-cols-4"}`}>
          <StatCard label="Gross pay" value={money(pay.total + extras)} {...(extras ? { sub: `incl. ${money(extras)} extra pay` } : {})} highlight />
          {slip?.net != null && <StatCard label="Net pay" value={money(slip.net)} sub={`after ${money(slip.deductionsTotal ?? 0)} in deductions${slip.paidOn ? `, paid ${slip.paidOn}` : ""}`} delay={30} />}
          <StatCard label="Hours worked" value={(pay.regular + pay.overtime).toFixed(2)} sub={`${pay.days} day${pay.days === 1 ? "" : "s"} · ${lunchHours.toFixed(2)} h unpaid break`} delay={60} />
          <StatCard label="Regular hours" value={pay.regular.toFixed(2)} sub={money(pay.regPay)} delay={120} />
          <StatCard label="Overtime hours" value={pay.overtime.toFixed(2)} sub={salary ? "salaried: no overtime" : money(pay.otPay)} delay={180} />
        </section>
      </FoldBox>

      <FoldBox id="timesheet:days" title="Days">
        <div className="glass-panel overflow-hidden">
          <div className="border-b border-border px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="font-display font-extrabold tracking-tight">Hours and pay</div>
                <SortControl value={sort} onChange={setSort} columns={columns} />
              </div>
              <span className="flex items-center gap-2 text-xs text-muted-foreground print:hidden">Breaks in <BreakUnitToggle /></span>
            </div>
            <p className="text-xs text-muted-foreground">
              {salary
                ? `Salaried: ${rules.threshold} h × ${money(rate * shift.multiplier)} for each week worked, shared across its days by hours.`
                : `Overtime (${rules.otMultiplier}×): ${rules.weekendOvertime ? "every Saturday and Sunday hour, plus " : ""}weekday hours over ${rules.threshold} in a Mon–Sun week.`}
              {" "}Weeks that start before or end after this range count their other days toward overtime, but only days in the range are paid here.
            </p>
          </div>
          <div className="overflow-x-auto">
            <DataTable id="timesheet" className="w-full text-sm">
              <thead>
                <TableSort sort={sort} columns={columns} onSort={setSort}>
                <tr className="border-b border-border font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                  <SortTh k="date" className={`${th} pl-5 text-left`}><EditableLabel k="date" name="Date" /></SortTh>
                  <SortTh k="shift" className={`${th} text-left`}><EditableLabel k="shift" name="Shift" /></SortTh>
                  <SortTh k="clock_in" className={`${th} text-left`}><EditableLabel k="clock_in" name="In" /></SortTh>
                  <SortTh k="clock_out" className={`${th} text-left`}><EditableLabel k="clock_out" name="Out" /></SortTh>
                  <SortTh k="break" className={`${th} text-right`}><BreakHeader unit={breakUnit} /></SortTh>
                  <SortTh k="hours" className={`${th} text-right`}><EditableLabel k="hours" name="Hours" /></SortTh>
                  <RecordPayHeaders className={`${th} text-right`} />
                  <SortTh k="note" className={`${th} pr-5 text-left`}><EditableLabel k="note" name="Note" /></SortTh>
                </tr>
                </TableSort>
              </thead>
              <tbody className="font-mono text-[13px]">
                {loading && <SkeletonRows cols={7 + RECORD_PAY_COLUMNS} />}
                {!loading && shown.length === 0 && (
                  <tr><td colSpan={7 + RECORD_PAY_COLUMNS} className="px-5 py-10 text-center font-body text-muted-foreground">No hours recorded in this range.</td></tr>
                )}
                {weeks.map((w) => (
                  <WeekRows key={w.start || "all"} start={w.start} rows={w.rows} lineById={lineById} breakUnit={breakUnit} shifts={shifts} employeeShiftId={emp.shift_id} total={totalCells(subtotal(w.rows))} showSubtotal={weeks.length > 1} />
                ))}
              </tbody>
              {shown.length > 0 && (
                <tfoot className="font-mono text-[13px] font-semibold">
                  <tr className="border-t-2 border-border">
                    <td colSpan={5} className="px-5 py-3 font-body">Total</td>
                    {totalCells(subtotal(shown))}
                  </tr>
                </tfoot>
              )}
            </DataTable>
          </div>
        </div>
      </FoldBox>

      {adjustments.length > 0 && (
        <FoldBox id="timesheet:extra-pay" title="Extra pay">
          <div className="glass-panel overflow-hidden">
            <div className="border-b border-border px-5 py-4 font-display font-extrabold tracking-tight">Extra pay</div>
            <DataTable id="timesheet-extra-pay" className="w-full text-sm">
              <thead>
                <TableSort sort={extraSort} columns={EXTRA_COLUMNS} onSort={setExtraSort}>
                <tr className="border-b border-border font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                  <SortTh k="date" className={`${th} pl-5 text-left`}><EditableLabel k="pay_date" name="Pay date" /></SortTh>
                  <SortTh k="category" className={`${th} text-left`}><EditableLabel k="category" name="Category" /></SortTh>
                  <SortTh k="note" className={`${th} text-left`}><EditableLabel k="note" name="Note" /></SortTh>
                  <SortTh k="amount" className={`${th} pr-5 text-right`}><EditableLabel k="amount" name="Amount" /></SortTh>
                </tr>
                </TableSort>
              </thead>
              <tbody className="font-mono text-[13px]">
                {extraRows.map((a) => (
                  <tr key={a.id} className="border-b border-border last:border-0">
                    <td className="whitespace-nowrap px-5 py-2.5"><span className="inline-block w-9 font-body text-muted-foreground">{weekday(a.pay_date)}</span>{a.pay_date}</td>
                    <td className="px-3 py-2.5 font-body">{a.category}</td>
                    <td className="px-3 py-2.5 font-body text-xs text-muted-foreground">{a.note}</td>
                    <td className="px-5 py-2.5 text-right">{money(Number(a.amount))}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-border font-semibold">
                  <td colSpan={3} className="px-5 py-2.5 font-body">Hours pay {money(pay.total)} + extra pay</td>
                  <td className="px-5 py-2.5 text-right">{money(pay.total + extras)}</td>
                </tr>
              </tbody>
            </DataTable>
          </div>
        </FoldBox>
      )}
    </>
  );
}

function WeekRows({ start, rows, lineById, breakUnit, shifts, employeeShiftId, total, showSubtotal }: {
  start: string; rows: TimeRecord[]; lineById: Map<string, PayLine>; breakUnit: BreakUnit; shifts: Shift[]; employeeShiftId: string | null; total: React.ReactNode; showSubtotal: boolean;
}) {
  return (
    <>
      {rows.map((r) => (
        <tr key={r.id} className="border-b border-border hover:bg-secondary">
          <td className="whitespace-nowrap px-5 py-2.5"><span className="inline-block w-9 font-body text-muted-foreground">{weekday(r.work_date)}</span>{r.work_date}</td>
          <RecordShiftCell shiftId={r.shift_id} employeeShiftId={employeeShiftId} shifts={shifts} cell="px-3 py-2.5" />
          <td className="px-3 py-2.5">{r.entry_mode === "clock" ? r.clock_in?.slice(0, 5) : <span className="font-body text-xs text-muted-foreground">daily hours</span>}</td>
          <td className="px-3 py-2.5">{r.clock_out?.slice(0, 5)}</td>
          <td className="px-3 py-2.5 text-right">{r.entry_mode === "clock" ? formatBreak(r.lunch_minutes, breakUnit) : ""}</td>
          <td className="px-3 py-2.5 text-right">{Number(r.hours).toFixed(2)}</td>
          <RecordPayCells line={lineById.get(r.id)} cell="px-3 py-2.5 text-right" />
          <td className="px-3 py-2.5 pr-5 font-body text-xs text-muted-foreground">{r.note}</td>
        </tr>
      ))}
      {showSubtotal && (
        <tr className="border-b border-border bg-secondary/60 font-semibold">
          <td colSpan={5} className="px-5 py-2 font-body text-xs">Week of {start} – {weekEnd(start)}</td>
          {total}
        </tr>
      )}
    </>
  );
}
