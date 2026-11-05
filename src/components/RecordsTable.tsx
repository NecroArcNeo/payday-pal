import { useState } from "react";
import { fullName, money, useEmployees, usePayRates, useRecordPay, useShifts, weekday, type RecordWithEmp } from "@/lib/payroll";
import { rateOn } from "@/lib/pay-rates";
import { RECORD_PAY_COLUMNS, RecordPayCells, RecordPayHeaders, RecordShiftCell } from "@/components/RecordPay";
import { EmployeeLink } from "@/components/EmployeeLink";
import { BreakHeader, BreakUnitToggle } from "@/components/BreakField";
import { DataTable } from "./DataTable";
import { SkeletonRows } from "./Loading";
import { formatBreak, useBreakUnit } from "@/lib/breaks";
import { Trash2 } from "lucide-react";
import { EditableLabel } from "@/components/EditableLabel";
import { SortControl, SortTh, TableSort, useTableSort } from "@/components/SortControl";
import { useRecordSortColumns } from "@/components/RecordPay";
import { newestFirst } from "@/lib/record-columns";
import { sortTable, withoutColumns } from "@/lib/table-sort";

export function RecordsTable({ records, title = "Time records", onDelete, showName = true, loading = false }: { records: RecordWithEmp[]; title?: string; onDelete?: (id: string) => void; showName?: boolean; loading?: boolean }) {
  const [mode, setMode] = useState<"clock" | "hours">("clock");
  const pay = useRecordPay(records);
  // Any column; daily-hours records have no clock times or break, so those aren't offered for them.
  const all = useRecordSortColumns(pay, showName);
  const columns = mode === "clock" ? all : withoutColumns(all, ["clock_in", "clock_out", "break"]);
  const [sort, setSort] = useTableSort("meridian-recent-records-sort", columns, { by: "date", desc: true });
  const rows = sortTable(records.filter((r) => r.entry_mode === mode), sort, columns, newestFirst);
  const { data: rateHistory } = usePayRates();
  const { data: shifts = [] } = useShifts();
  const [breakUnit] = useBreakUnit();
  const { data: employees = [] } = useEmployees();
  const empById = new Map(employees.map((e) => [e.id, e]));

  return (
    <div className="glass-panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="font-display font-extrabold tracking-tight">{title}</div>
          <SortControl value={sort} onChange={setSort} columns={columns} />
        </div>
        {mode === "clock" && <span className="ml-auto mr-3 flex items-center gap-2 text-xs text-muted-foreground">Breaks in <BreakUnitToggle /></span>}
        <div className="flex rounded-xl bg-secondary p-1 text-xs font-medium ring-1 ring-border">
          {(["clock", "hours"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`rounded-lg px-3 py-1.5 ${mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {m === "clock" ? "Clock in / out" : "Daily hours"}
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <DataTable id="recent-records" className="w-full text-sm">
          <thead>
            <TableSort sort={sort} columns={columns} onSort={setSort}>
            <tr className="border-b border-border font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
              {showName && <SortTh k="employee" className="px-5 py-3 text-left font-medium"><EditableLabel k="employee" name="Employee" /></SortTh>}
              <SortTh k="date" className="px-3 py-3 text-left font-medium"><EditableLabel k="date" name="Date" /></SortTh>
              <SortTh k="shift" className="px-3 py-3 text-left font-medium"><EditableLabel k="shift" name="Shift" /></SortTh>
              {mode === "clock" && (
                <>
                  <SortTh k="clock_in" className="px-3 py-3 text-left font-medium"><EditableLabel k="clock_in" name="Clock in" /></SortTh>
                  <SortTh k="clock_out" className="px-3 py-3 text-left font-medium"><EditableLabel k="clock_out" name="Clock out" /></SortTh>
                  <SortTh k="break" className="px-3 py-3 text-right font-medium"><BreakHeader unit={breakUnit} /></SortTh>
                </>
              )}
              <SortTh k="hours" className="px-3 py-3 text-right font-medium"><EditableLabel k="hours" name="Hours" /></SortTh>
              <SortTh k="hourly_rate" className="px-3 py-3 text-right font-medium"><EditableLabel k="hourly_rate" name="Rate" /></SortTh>
              <RecordPayHeaders />
              {onDelete && <th className="w-10" />}
            </tr>
            </TableSort>
          </thead>
          <tbody className="font-mono text-[13px]">
            {loading && <SkeletonRows cols={(showName ? 1 : 0) + (mode === "clock" ? 7 : 4) + RECORD_PAY_COLUMNS + (onDelete ? 1 : 0)} />}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={14} className="px-5 py-10 text-center font-body text-muted-foreground">
                  No {mode === "clock" ? "clock in/out" : "daily hours"} records yet.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              // The rate in force that day, so a later raise doesn't change what an old day shows.
              const rate = rateOn(rateHistory?.get(r.employee_id), r.employees?.hourly_rate ?? 0, r.work_date);
              return (
                <tr key={r.id} className="border-b border-border last:border-0 hover:bg-secondary">
                  {showName && <td className="px-5 py-3 font-body">{r.employees ? <EmployeeLink id={r.employee_id} name={fullName(r.employees)} /> : "—"}</td>}
                  <td className="whitespace-nowrap px-3 py-3"><span className="inline-block w-9 font-body text-muted-foreground">{weekday(r.work_date)}</span>{r.work_date}</td>
                  <RecordShiftCell shiftId={r.shift_id} employeeShiftId={empById.get(r.employee_id)?.shift_id} shifts={shifts} />
                  {mode === "clock" && (
                    <>
                      <td className="px-3 py-3">{r.clock_in?.slice(0, 5)}</td>
                      <td className="px-3 py-3">{r.clock_out?.slice(0, 5)}</td>
                      <td className="px-3 py-3 text-right">{formatBreak(r.lunch_minutes, breakUnit)}</td>
                    </>
                  )}
                  <td className="px-3 py-3 text-right">{Number(r.hours).toFixed(2)}</td>
                  <td className="px-3 py-3 text-right">{money(rate)}</td>
                  <RecordPayCells line={pay?.get(r.id)} />
                  {onDelete && (
                    <td className="pr-4">
                      <button onClick={() => onDelete(r.id)} aria-label="Delete record" className="text-muted-foreground hover:text-destructive">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      </div>
    </div>
  );
}
