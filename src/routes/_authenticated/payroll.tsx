import { useKeptState } from "@/lib/prefs";
import { isDate as keptDate, validFilter } from "@/lib/last-place";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { db } from "@/lib/db/mode";
import { AppShell, StatCard, btnGhost, btnPrimary, inputCls } from "@/components/AppShell";
import { EmployeePicker, SearchInput } from "@/components/EmployeeSearch";
import { DataTable } from "@/components/DataTable";
import { describeEmployeeFilter, isFiltering, matchesEmployee, NO_FILTER, type EmployeeFilter } from "@/lib/employee-search";
import { currentWeek, fullName, money, useAdjustments, useAllRecords, useDeductions, useEmployees, useFieldDefs, usePayRates, usePayrollSettings, useShifts,
  type Employee, useHolidays } from "@/lib/payroll";
import { employeePay, shiftFor, weekEnd, weekStart, payRules } from "@/lib/pay";
import { ratesBetween } from "@/lib/pay-rates";
import { PayLock } from "@/components/PayLock";
import { fieldType, formatValue } from "@/lib/field-types";
import { readAmount } from "@/lib/amount";
import { labelOf, useLabels } from "@/lib/labels";
import { customKey } from "@/lib/db/privacy";
import { Columns3, Settings2, Trash2 } from "lucide-react";
import { openSettings } from "@/lib/settings-window";
import { EditableLabel } from "@/components/EditableLabel";
import { SortControl, SortTh, TableSort, useTableSort } from "@/components/SortControl";
import { sortTable, type Sort, type SortColumns, type SortKind, type SortValue } from "@/lib/table-sort";
import { DateInput } from "@/components/DateInput";
import { RecordWarnings, useRecordWarnings } from "@/components/RecordWarnings";
import { EmployeeLink } from "@/components/EmployeeLink";
import { PeriodHint } from "@/components/PeriodHint";
import { SkeletonRows } from "@/components/Loading";
import { deductionsFor } from "@/lib/deductions";
import { runLine } from "@/lib/pay-runs";
import { PayRunsList, RecordPayRun } from "@/components/PayRuns";
import { FoldBox } from "@/components/FoldBox";

export const Route = createFileRoute("/_authenticated/payroll")({
  head: () => ({ meta: [{ title: "Payroll — KoPayroll" }] }),
  component: PayrollPage,
});

/**
 * `key` is also the column's alias key (see src/lib/labels.ts); custom categories use customKey(id). `sortBy` is what
 * the column sorts by (`get` is what it shows): hire dates as dates, number and money categories by their amount.
 */
type InfoCol = { key: string; label: string; get: (e: Employee) => string; alias?: string; kind: SortKind; sortBy?: (e: Employee) => SortValue };
const builtInCols: InfoCol[] = [
  { key: "employee_code", label: "ID", kind: "text", get: (e) => e.employee_code },
  { key: "job_title", label: "Job title", kind: "text", get: (e) => e.job_title ?? "" },
  { key: "department", label: "Department", kind: "text", get: (e) => e.department ?? "" },
  { key: "email", label: "Email", kind: "text", get: (e) => e.email ?? "" },
  { key: "phone", label: "Phone", kind: "text", get: (e) => e.phone ?? "" },
  { key: "hire_date", label: "Hire date", kind: "date", get: (e) => e.hire_date ?? "" },
];

const BY_NAME: Sort = { by: "employee", desc: false };

function PayrollPage() {
  const w = currentWeek();
  // The period and filter are kept for next time (open where I left off); the first time, this week.
  const [from, setFrom] = useKeptState("meridian-place:payroll-from", w.from, keptDate);
  const [to, setTo] = useKeptState("meridian-place:payroll-to", w.to, keptDate);
  const [showColumns, setShowColumns] = useState(false);
  const [q, setQ] = useKeptState<EmployeeFilter>("meridian-place:payroll-filter", NO_FILTER, validFilter);
  const qc = useQueryClient();
  // Load whole Mon–Sun weeks around the period, so weekly overtime is right even when the period starts mid-week.
  const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
  const { data: records = [], isSuccess: recordsLoaded } = useAllRecords(isDate(from) ? weekStart(from) : from, isDate(to) ? weekEnd(to) : to);
  const { data: shifts = [] } = useShifts();
  const { data: employees = [] } = useEmployees();
  const { data: rateHistory } = usePayRates();
  const { data: adjustments = [] } = useAdjustments(from, to);
  const { data: defs = [] } = useFieldDefs();
  const { data: settings } = usePayrollSettings();
  const { data: deductionRules } = useDeductions();
  // Deductions and net pay only while that feature is on (Settings → Features).
  const deductionsOn = settings?.deductions_on ?? false;
  const threshold = settings?.ot_threshold ?? 40;
  const mult = settings?.ot_multiplier ?? 1.5;
  const weekendOt = settings?.weekend_overtime ?? true;
  const { data: holidays, isSuccess: holidaysLoaded } = useHolidays();
  const rules = { ...payRules(settings, holidays), threshold, otMultiplier: mult, weekendOvertime: weekendOt };
  const visible = settings?.visible_columns ?? [];

  // Categories under Personal are personal details, which stay off payroll.
  const shownDefs = defs.filter((d) => d.section !== "Personal");
  const infoCols: InfoCol[] = [
    ...builtInCols,
    ...shownDefs.map((d): InfoCol => {
      const raw = (e: Employee) => String(((e.custom_fields ?? {}) as Record<string, unknown>)[d.id] ?? "");
      const type = fieldType(d.field_type);
      const numeric = type === "number" || type === "money";
      return {
        key: d.id, alias: customKey(d.id), label: d.label, get: (e) => formatValue(d.field_type, raw(e)),
        kind: numeric ? "number" : type === "date" ? "date" : "text",
        ...(numeric ? { sortBy: (e: Employee) => (raw(e) ? readAmount(raw(e)) : null) } : {}),
      };
    }),
  ].filter((c) => visible.includes(c.key));
  const aliasKey = (c: { key: string; alias?: string }) => c.alias ?? c.key;
  const { label } = useLabels();
  const showDays = visible.includes("days");
  const showRate = visible.includes("rate");
  const showShift = visible.includes("shift");

  const categories = [...new Set(adjustments.map((a) => a.category))].sort();
  const inPeriod = useMemo(() => records.filter((r) => r.work_date >= from && r.work_date <= to), [records, from, to]);
  const checked = useRecordWarnings(inPeriod, employees, shifts, rateHistory);
  const empIds = new Set([...inPeriod.map((r) => r.employee_id), ...adjustments.map((a) => a.employee_id)]);
  const byEmp = new Map<string, typeof records>();
  for (const r of records) byEmp.set(r.employee_id, [...(byEmp.get(r.employee_id) ?? []), r]);
  const unsorted = employees
    .filter((e) => empIds.has(e.id))
    .map((e) => {
      const history = rateHistory?.get(e.id);
      // Every rate paid in the period, oldest first (more than one when it changed partway through).
      const rates = ratesBetween(history, e.hourly_rate, from, to);
      const rate = rates.at(-1)!;
      const shift = shiftFor(e.shift_id, shifts);
      const p = employeePay(byEmp.get(e.id) ?? [], { rate: Number(e.hourly_rate), rates: history, shiftMultiplier: shift.multiplier, rules, payType: e.pay_type, shifts, from, to });
      const extras: Record<string, number> = {};
      for (const a of adjustments) if (a.employee_id === e.id) extras[a.category] = (extras[a.category] ?? 0) + Number(a.amount);
      const extraTotal = Object.values(extras).reduce((s, n) => s + n, 0);
      const gross = p.total + extraTotal;
      const deducted = deductionsOn ? deductionsFor(deductionRules?.get(e.id) ?? [], gross, from, to) : null;
      const byName: Record<string, number> = {};
      for (const l of deducted?.lines ?? []) byName[l.name] = (byName[l.name] ?? 0) + l.amount;
      return { e, shift, rate, rates, ...p, extras, gross, deducted, byName };
    });
  type Row = (typeof unsorted)[number];
  const hasManual = unsorted.some((r) => r.manualDays > 0);
  // One column per deduction taken this period (like extra-pay categories), then the total and net pay.
  const deductionCols = [...new Set(unsorted.flatMap((r) => Object.keys(r.byName)))];

  // Sorted by any column the table shows (the same ones as its headers). Ties go by name A to Z, so equal amounts
  // stay in a findable order.
  const columns: SortColumns<Row> = {
    employee: { label: "Employee", kind: "text", value: (r) => fullName(r.e) },
    ...Object.fromEntries(infoCols.map((c) => [aliasKey(c), { label: c.label, kind: c.kind, value: (r: Row) => (c.sortBy ?? c.get)(r.e) }])),
    ...(showDays ? { days: { label: "Days", kind: "number" as const, value: (r: Row) => r.days } } : {}),
    ...(showShift ? { shift: { label: "Shift", kind: "text" as const, value: (r: Row) => r.shift.name } } : {}),
    // The latest rate in the period (the one shown last when it changed partway).
    ...(showRate ? { hourly_rate: { label: "Rate", kind: "number" as const, value: (r: Row) => r.rate } } : {}),
    reg_hrs: { label: "Reg hrs", kind: "number", value: (r) => r.regular },
    ot_hrs: { label: "OT hrs", kind: "number", value: (r) => r.overtime },
    reg_pay: { label: "Regular pay", kind: "number", value: (r) => r.regPay },
    ot_pay: { label: "OT pay", kind: "number", value: (r) => r.otPay },
    ...(hasManual ? { manual_pay: { label: "Manual pay", kind: "number" as const, value: (r: Row) => (r.manualDays ? r.manualPay : null) } } : {}),
    ...Object.fromEntries(categories.map((c) => [`extra:${c}`, { label: c, kind: "number" as const, value: (r: Row) => r.extras[c] ?? 0 }])),
    gross_pay: { label: "Gross pay", kind: "number", value: (r) => r.gross },
    ...(deductionsOn ? {
      ...Object.fromEntries(deductionCols.map((n) => [`deduction:${n}`, { label: n, kind: "number" as const, value: (r: Row) => r.byName[n] ?? 0 }])),
      deductions_total: { label: "Deductions", kind: "number" as const, value: (r: Row) => r.deducted?.total ?? 0 },
      net_pay: { label: "Net pay", kind: "number" as const, value: (r: Row) => r.deducted?.net ?? r.gross },
    } : {}),
  };
  const [sort, setSort] = useTableSort("meridian-payroll-sort", columns, BY_NAME);
  const byName = (a: Row, b: Row) => fullName(a.e).localeCompare(fullName(b.e), undefined, { sensitivity: "base" });
  const list = sortTable(unsorted, sort, columns, byName);

  const sum = (f: (r: Row) => number) => list.reduce((s, r) => s + f(r), 0);
  // What a pay run for this period would save: each person's line as the table shows it.
  const payRunsOn = settings?.pay_runs_on ?? false;
  const runLines = payRunsOn ? list.map((r) => runLine({
    employee: r.e, regular: r.regular, overtime: r.overtime, extraPay: Object.values(r.extras).reduce((s, n) => s + n, 0), gross: r.gross, deducted: r.deducted,
  })) : [];
  // The table's column count, for the loading placeholder's rows.
  const colCount = 1 + infoCols.length + [showDays, showShift, showRate].filter(Boolean).length + 4 + (hasManual ? 1 : 0) + categories.length + 1
    + (deductionsOn ? deductionCols.length + 2 : 0);
  // The search narrows the table only; totals and the CSV export always cover everyone paid.
  const shown = isFiltering(q) ? list.filter((r) => matchesEmployee(r.e, q)) : list;

  const exportCsv = () => {
    const head = [labelOf("employee", "Name"), ...infoCols.map((c) => labelOf(aliasKey(c), c.label)), labelOf("pay_type", "Pay type"), labelOf("shift", "Shift"), "Shift multiplier",
      ...(showDays ? [labelOf("days", "Days")] : []), ...(showRate ? [labelOf("hourly_rate", "Rate")] : []),
      labelOf("reg_hrs", "Regular hours"), labelOf("ot_hrs", "Overtime hours"), "Weekend hours", labelOf("reg_pay", "Regular pay"), labelOf("ot_pay", "Overtime pay"),
      labelOf("manual_pay", "Manual day pay"), ...categories.map((c) => labelOf(`extra:${c}`, c)), labelOf("gross_pay", "Gross pay"),
      ...(deductionsOn ? [...deductionCols.map((n) => labelOf(`deduction:${n}`, n)), labelOf("deductions_total", "Deductions"), labelOf("net_pay", "Net pay")] : [])];
    const body = list.map((r) => [fullName(r.e), ...infoCols.map((c) => c.get(r.e)), r.e.pay_type === "salary" ? "Salary" : "Hourly", r.shift.name, r.shift.multiplier, ...(showDays ? [r.days] : []), ...(showRate ? [r.rates.map((x) => x.toFixed(2)).join(" → ")] : []),
      r.regular.toFixed(2), r.overtime.toFixed(2), r.weekendHours.toFixed(2), r.regPay.toFixed(2), r.otPay.toFixed(2), r.manualPay.toFixed(2),
      ...categories.map((c) => (r.extras[c] ?? 0).toFixed(2)), r.gross.toFixed(2),
      ...(deductionsOn ? [...deductionCols.map((n) => (r.byName[n] ?? 0).toFixed(2)), (r.deducted?.total ?? 0).toFixed(2), (r.deducted?.net ?? r.gross).toFixed(2)] : [])]);
    const csv = [head, ...body].map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `payroll_${from}_${to}.csv`;
    a.click();
  };

  const th = "px-3 py-3 font-medium whitespace-nowrap";
  return (
    <AppShell eyebrow="Payroll run" title={`${from} – ${to}`} actions={
      <div className="flex gap-2">
        <button data-find="payroll-columns" onClick={() => setShowColumns((s) => !s)} className={btnGhost} aria-expanded={showColumns}><Columns3 className="mr-1 inline h-4 w-4" />Columns</button>
        <button onClick={() => openSettings("pay")} className={btnGhost} title="Overtime rules and shifts"><Settings2 className="mr-1 inline h-4 w-4" />Pay rules</button>
        <button onClick={exportCsv} className={btnGhost}>Export CSV</button>
      </div>
    }>
      <div className="flex items-center gap-3">
        <span className="label-mono">Period</span>
        <DateInput className={`${inputCls} max-w-[11rem]`} value={from} onChange={(v) => setFrom(v)} />
        <span className="text-muted-foreground">→</span>
        <DateInput className={`${inputCls} max-w-[11rem]`} value={to} onChange={(v) => setTo(v)} />
      </div>
      {/* Once the period's records are in and no one is paid, say why and offer the nearest week with records. */}
      {recordsLoaded && list.length === 0 && isDate(from) && isDate(to) && <PeriodHint from={from} to={to} onPick={(f, t) => { setFrom(f); setTo(t); }} />}
      {to && (payRunsOn ? (
        <div className="flex flex-wrap items-center gap-3">
          {recordsLoaded && holidaysLoaded && isDate(from) && isDate(to) && from <= to && <RecordPayRun from={from} to={to} lines={runLines} warnings={checked.open.length} />}
          <div className="min-w-0 flex-1"><PayLock periodEnd={to} warnings={checked.open.length} /></div>
        </div>
      ) : <PayLock periodEnd={to} warnings={checked.open.length} />)}
      {inPeriod.length > 0 && <RecordWarnings checked={checked} employees={employees} />}

      {showColumns && settings && (
        <ColumnsPanel settings={settings} cols={[...builtInCols.map((c) => ({ key: c.key, label: label(c.key, c.label) })), { key: "shift", label: label("shift", "Shift") }, { key: "days", label: label("days", "Days") },
          { key: "rate", label: label("hourly_rate", "Rate") }, ...shownDefs.map((d) => ({ key: d.id, label: label(customKey(d.id), d.label) }))]}
          onSaved={() => qc.invalidateQueries({ queryKey: ["payroll-settings"] })} onClose={() => setShowColumns(false)} />
      )}

      <FoldBox id="payroll:cards" title="Totals" summary={`${money(sum((r) => r.gross))} gross`}>
        <section className={`grid grid-cols-2 gap-4 ${deductionsOn ? "md:grid-cols-5" : "md:grid-cols-4"}`}>
          <StatCard label="Gross pay" value={money(sum((r) => r.gross))} highlight />
          {deductionsOn && <StatCard label="Net pay" value={money(sum((r) => r.deducted?.net ?? r.gross))} sub={`after ${money(sum((r) => r.deducted?.total ?? 0))} in deductions`} delay={30} />}
          <StatCard label="Regular hours" value={sum((r) => r.regular).toFixed(2)} delay={60} />
          <StatCard label="Overtime hours" value={sum((r) => r.overtime).toFixed(2)} delay={120} />
          <StatCard label="Employees paid" value={String(list.length)} delay={180} />
        </section>
      </FoldBox>

      <FoldBox id="payroll:table" title="Pay for the period">
        <div className="glass-panel overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
            <span className="text-xs text-muted-foreground">
              Overtime ({mult}× rate): {weekendOt ? `every Saturday and Sunday hour, plus weekday hours over ${threshold}` : `hours over ${threshold}`} in a Mon–Sun week.
              {" "}Shift multipliers scale the rate for regular hours only; overtime is always {mult}× the base rate, never stacked with the shift. Salaried employees get {threshold} h × rate for each week they work, with no overtime. Days with manual pay are paid exactly the amount entered.
              {isFiltering(q) && ` Showing ${shown.length} of ${list.length}; totals above include everyone.`}
            </span>
            <div className="flex w-full flex-wrap items-center gap-3">
              <SearchInput value={q} onChange={setQ} employees={list.map((r) => r.e)} className="min-w-[16rem] max-w-xl flex-1" />
              <SortControl value={sort} onChange={setSort} columns={columns} />
            </div>
          </div>
          <div className="overflow-x-auto">
            <DataTable id="payroll" className="w-full text-sm">
              <thead>
                <TableSort sort={sort} columns={columns} onSort={setSort}>
                <tr className="border-b border-border font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                  <SortTh k="employee" className={`${th} pl-5 text-left`}><EditableLabel k="employee" name="Employee" /></SortTh>
                  {infoCols.map((c) => <SortTh k={aliasKey(c)} key={c.key} className={`${th} text-left`}><EditableLabel k={aliasKey(c)} name={c.label} /></SortTh>)}
                  {showDays && <SortTh k="days" className={`${th} text-right`}><EditableLabel k="days" name="Days" /></SortTh>}
                  {showShift && <SortTh k="shift" className={`${th} text-left`}><EditableLabel k="shift" name="Shift" /></SortTh>}
                  {showRate && <SortTh k="hourly_rate" className={`${th} text-right`}><EditableLabel k="hourly_rate" name="Rate" /></SortTh>}
                  <SortTh k="reg_hrs" className={`${th} text-right`}><EditableLabel k="reg_hrs" name="Reg hrs" /></SortTh>
                  <SortTh k="ot_hrs" className={`${th} text-right`}><EditableLabel k="ot_hrs" name="OT hrs" /></SortTh>
                  <SortTh k="reg_pay" className={`${th} text-right`}><EditableLabel k="reg_pay" name="Regular pay" /></SortTh>
                  <SortTh k="ot_pay" className={`${th} text-right`}><EditableLabel k="ot_pay" name="OT pay" /></SortTh>
                  {hasManual && <SortTh k="manual_pay" className={`${th} text-right`}><EditableLabel k="manual_pay" name="Manual pay" /></SortTh>}
                  {categories.map((c) => <SortTh k={`extra:${c}`} key={c} className={`${th} text-right`}><EditableLabel k={`extra:${c}`} name={c} /></SortTh>)}
                  <SortTh k="gross_pay" className={`${th} ${deductionsOn ? "" : "pr-5"} text-right`}><EditableLabel k="gross_pay" name="Gross pay" /></SortTh>
                  {deductionsOn && deductionCols.map((n) => <SortTh k={`deduction:${n}`} key={n} className={`${th} text-right`}><EditableLabel k={`deduction:${n}`} name={n} /></SortTh>)}
                  {deductionsOn && <SortTh k="deductions_total" className={`${th} text-right`}><EditableLabel k="deductions_total" name="Deductions" /></SortTh>}
                  {deductionsOn && <SortTh k="net_pay" className={`${th} pr-5 text-right`}><EditableLabel k="net_pay" name="Net pay" /></SortTh>}
                </tr>
                </TableSort>
              </thead>
              <tbody className="font-mono text-[13px]">
                {!recordsLoaded && <SkeletonRows cols={colCount} />}
                {recordsLoaded && list.length === 0 && <tr><td colSpan={20} className="px-5 py-10 text-center font-body text-muted-foreground">No hours in this period.</td></tr>}
                {list.length > 0 && shown.length === 0 && <tr><td colSpan={20} className="px-5 py-10 text-center font-body text-muted-foreground">No one paid this period matches {describeEmployeeFilter(q)}.</td></tr>}
                {shown.map((r) => (
                  <tr key={r.e.id} className="border-b border-border last:border-0 hover:bg-secondary">
                    <td className="px-5 py-3 font-body"><EmployeeLink id={r.e.id} name={fullName(r.e)} />{r.e.pay_type === "salary" && <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground ring-1 ring-border">Salary</span>}</td>
                    {infoCols.map((c) => <td key={c.key} className="px-3 py-3 font-body">{c.get(r.e) || "—"}</td>)}
                    {showDays && <td className="px-3 py-3 text-right">{r.days}</td>}
                    {showShift && <td className="px-3 py-3 font-body">{r.shift.name}{r.shift.multiplier !== 1 && <span className="text-muted-foreground"> ×{r.shift.multiplier}</span>}</td>}
                    {showRate && <td className="px-3 py-3 text-right" title={r.rates.length > 1 ? "The rate changed during this period; each day is paid at the rate in force that day." : undefined}>{r.rates.map(money).join(" → ")}{r.shift.multiplier !== 1 && <div className="text-[11px] text-muted-foreground">{r.rates.map((x) => money(x * r.shift.multiplier)).join(" → ")} on shift</div>}</td>}
                    <td className="px-3 py-3 text-right">{r.regular.toFixed(2)}</td>
                    <td className="px-3 py-3 text-right">{r.overtime.toFixed(2)}</td>
                    <td className="px-3 py-3 text-right">{money(r.regPay)}</td>
                    <td className="px-3 py-3 text-right">{money(r.otPay)}</td>
                    {hasManual && <td className="px-3 py-3 text-right" title={`${r.manualDays} day(s) with manual pay`}>{r.manualDays ? money(r.manualPay) : "—"}</td>}
                    {categories.map((c) => <td key={c} className="px-3 py-3 text-right">{money(r.extras[c] ?? 0)}</td>)}
                    <td className={`${deductionsOn ? "px-3" : "px-5"} py-3 text-right font-semibold`}>{money(r.gross)}</td>
                    {deductionsOn && deductionCols.map((n) => <td key={n} className="px-3 py-3 text-right text-muted-foreground">{r.byName[n] ? `−${money(r.byName[n]!)}` : "—"}</td>)}
                    {deductionsOn && <td className="px-3 py-3 text-right" title={r.deducted?.lines.map((l) => `${l.name}: ${money(l.amount)} (${l.detail})`).join("\n")}>{r.deducted?.total ? `−${money(r.deducted.total)}` : "—"}</td>}
                    {deductionsOn && <td className={`px-5 py-3 text-right font-semibold ${(r.deducted?.net ?? 0) < 0 ? "text-destructive" : ""}`} title={(r.deducted?.net ?? 0) < 0 ? "The deductions are more than the gross pay" : undefined}>{money(r.deducted?.net ?? r.gross)}</td>}
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
        </div>
      </FoldBox>

      <ExtrasPanel employees={employees} adjustments={adjustments} defaultDate={to} onChange={() => qc.invalidateQueries({ queryKey: ["adjustments"] })} />
      {payRunsOn && <PayRunsList onShow={(f, t) => { setFrom(f); setTo(t); window.scrollTo({ top: 0, behavior: "smooth" }); }} />}
    </AppShell>
  );
}

/** Which extra columns the payroll table shows (payroll_settings.visible_columns). Saved on each click. */
function ColumnsPanel({ settings, cols, onSaved, onClose }: {
  settings: { ot_threshold: number; ot_multiplier: number; weekend_overtime: boolean; visible_columns: string[] };
  cols: { key: string; label: string }[]; onSaved: () => void; onClose: () => void;
}) {
  const vis = settings.visible_columns;
  const toggle = async (key: string) => {
    const next = vis.includes(key) ? vis.filter((v) => v !== key) : [...vis, key];
    const { error } = await db().saveSettings({ visible_columns: next });
    if (error) toast.error(error.message); else onSaved();
  };
  return (
    <div className="glass-panel space-y-3 p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="font-display font-extrabold tracking-tight">Show these columns</div>
        <button onClick={onClose} className={btnGhost}>Done</button>
      </div>
      <div className="flex flex-wrap gap-2">
        {cols.map((c) => {
          const on = vis.includes(c.key);
          return (
            <button key={c.key} type="button" aria-pressed={on} onClick={() => void toggle(c.key)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium ring-1 ring-border ${on ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`}>
              {c.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ExtrasPanel({ employees, adjustments, defaultDate, onChange }: {
  employees: Employee[]; adjustments: { id: string; employee_id: string; pay_date: string; category: string; amount: number; note: string | null }[];
  defaultDate: string; onChange: () => void;
}) {
  const [emp, setEmp] = useState("");
  const [category, setCategory] = useState("Bonus");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(defaultDate);
  const [note, setNote] = useState("");
  useEffect(() => setDate(defaultDate), [defaultDate]);
  const known = [...new Set(["Bonus", "Reimbursement", ...adjustments.map((a) => a.category)])];
  const name = (id: string) => { const e = employees.find((x) => x.id === id); return e ? fullName(e) : "—"; };

  const add = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const amt = Number(amount);
    if (!emp) { toast.error("Pick an employee"); return; }
    if (!category.trim() || category.length > 40) { toast.error("Enter a category name (up to 40 characters)"); return; }
    if (!Number.isFinite(amt) || amount === "") { toast.error("Enter an amount"); return; }
    const { error } = await db().insert("pay_adjustments", { employee_id: emp, category: category.trim(), amount: amt, pay_date: date, note: note.trim().slice(0, 300) || null });
    if (error) { toast.error(error.message); return; }
    toast.success("Extra pay added");
    setAmount(""); setNote("");
    onChange();
  };
  const remove = async (id: string) => {
    const { error } = await db().remove("pay_adjustments", id);
    if (error) toast.error(error.message); else onChange();
  };
  type Extra = (typeof adjustments)[number];
  const columns: SortColumns<Extra> = {
    employee: { label: "Employee", kind: "text", value: (a) => name(a.employee_id) },
    date: { label: "Pay date", kind: "date", value: (a) => a.pay_date },
    category: { label: "Category", kind: "text", value: (a) => a.category },
    note: { label: "Note", kind: "text", value: (a) => a.note },
    amount: { label: "Amount", kind: "number", value: (a) => Number(a.amount) },
  };
  const [sort, setSort] = useTableSort("meridian-payroll-extra-sort", columns, { by: "date", desc: false });
  const rows = sortTable(adjustments, sort, columns);
  const th = "px-3 py-2.5 font-medium";

  return (
    <FoldBox id="payroll:extra-pay" title="Extra pay">
      <div className="glass-panel overflow-hidden">
        <div className="border-b border-border px-5 py-4">
          <div className="font-display font-extrabold tracking-tight">Extra pay</div>
          <p className="text-xs text-muted-foreground">Bonuses, reimbursements or any category you type. Each category becomes its own payroll column.</p>
        </div>
        <form onSubmit={add} className="grid gap-3 p-5 md:grid-cols-6">
          <EmployeePicker employees={employees} value={emp} onChange={setEmp} placeholder="Employee…" />
          <input className={inputCls} list="extra-cats" placeholder="Category" value={category} onChange={(e) => setCategory(e.target.value)} />
          <datalist id="extra-cats">{known.map((k) => <option key={k} value={k} />)}</datalist>
          <input className={inputCls} type="number" step="0.01" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <DateInput className={inputCls} value={date} onChange={(v) => setDate(v)} />
          <input className={inputCls} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className={btnPrimary}>Add</button>
        </form>
        {adjustments.length > 0 && (
          <DataTable id="payroll-extra-pay" className="w-full text-sm">
            <thead>
              <TableSort sort={sort} columns={columns} onSort={setSort}>
              <tr className="border-t border-border font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                <SortTh k="employee" className={`${th} pl-5 text-left`}><EditableLabel k="employee" name="Employee" /></SortTh>
                <SortTh k="date" className={`${th} text-left`}><EditableLabel k="pay_date" name="Pay date" /></SortTh>
                <SortTh k="category" className={`${th} text-left`}><EditableLabel k="category" name="Category" /></SortTh>
                <SortTh k="note" className={`${th} text-left`}><EditableLabel k="note" name="Note" /></SortTh>
                <SortTh k="amount" className={`${th} text-right`}><EditableLabel k="amount" name="Amount" /></SortTh>
                <th className="w-10" />
              </tr>
              </TableSort>
            </thead>
            <tbody className="font-mono text-[13px]">
              {rows.map((a) => (
                <tr key={a.id} className="border-t border-border hover:bg-secondary">
                  <td className="px-5 py-2 font-body">{employees.some((e) => e.id === a.employee_id) ? <EmployeeLink id={a.employee_id} name={name(a.employee_id)} /> : "—"}</td>
                  <td className="px-3 py-2">{a.pay_date}</td>
                  <td className="px-3 py-2 font-body">{a.category}</td>
                  <td className="px-3 py-2 font-body text-muted-foreground">{a.note ?? ""}</td>
                  <td className="px-3 py-2 text-right">{money(Number(a.amount))}</td>
                  <td className="w-10 pr-4"><button onClick={() => remove(a.id)} aria-label="Delete extra pay" className="text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button></td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </div>
    </FoldBox>
  );
}
