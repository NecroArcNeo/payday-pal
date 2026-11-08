import { useMemo } from "react";
import { fullName, money, useEmployees, usePayRates, useShifts, type RecordWithEmp, type Shift, type TimeRecord } from "@/lib/payroll";
import { rateOn } from "@/lib/pay-rates";
import { recordColumns } from "@/lib/record-columns";
import type { SortColumns } from "@/lib/table-sort";
import { shiftForRecord, type PayLine } from "@/lib/pay";
import { EditableLabel } from "@/components/EditableLabel";
import { SortTh } from "@/components/SortControl";

/** Headers for the per-record pay columns, matching <RecordPayCells>. */
export function RecordPayHeaders({ className = "px-3 py-3 text-right font-medium" }: { className?: string }) {
  return (
    <>
      <SortTh k="reg_hrs" className={className}><EditableLabel k="reg_hrs" name="Reg hrs" /></SortTh>
      <SortTh k="ot_hrs" className={className}><EditableLabel k="ot_hrs" name="OT hrs" /></SortTh>
      <SortTh k="reg_pay" className={className}><EditableLabel k="reg_pay" name="Reg pay" /></SortTh>
      <SortTh k="ot_pay" className={className}><EditableLabel k="ot_pay" name="OT pay" /></SortTh>
      <SortTh k="total_pay" className={className} title="What this day pays: regular + overtime pay, the salaried share of the week, or the manual amount. Extra-pay entries are added on the Payroll page."><EditableLabel k="total_pay" name="Total pay" /></SortTh>
    </>
  );
}

export const RECORD_PAY_COLUMNS = 5;

/** One record's regular/overtime hours and pay, worked out over its whole Mon–Sun week. */
export function RecordPayCells({ line, cell = "px-3 py-3 text-right" }: { line: PayLine | undefined; cell?: string }) {
  if (!line) return <>{Array.from({ length: RECORD_PAY_COLUMNS }, (_, i) => <td key={i} className={`${cell} text-muted-foreground`}>…</td>)}</>;
  const tag = "font-body text-[10px] font-normal";
  return (
    <>
      <td className={cell}>{line.regular.toFixed(2)}</td>
      <td className={cell}>
        {line.overtime.toFixed(2)}
        {line.weekend && line.overtime > 0 && <div className={`${tag} text-muted-foreground`}>weekend</div>}
      </td>
      <td className={`${cell} ${line.manual ? "text-muted-foreground" : ""}`}>{line.manual ? "—" : money(line.regPay)}</td>
      <td className={`${cell} ${line.manual ? "text-muted-foreground" : ""}`}>{line.manual ? "—" : money(line.otPay)}</td>
      <td className={`${cell} font-semibold`}>
        {money(line.pay)}
        {line.manual ? <div className={`${tag} text-primary`}>manual</div> : line.salary && <div className={`${tag} text-muted-foreground`}>salary</div>}
      </td>
    </>
  );
}

/**
 * The columns a list of these records sorts by (recordColumns), with what they need: the shift each was worked on,
 * the rate in force that day (as the Rate column shows) and their pay lines. `showName`: the list has an Employee column.
 */
export function useRecordSortColumns<R extends TimeRecord = RecordWithEmp>(pay: Map<string, PayLine> | undefined, showName = true): SortColumns<R> {
  const { data: shifts = [] } = useShifts();
  const { data: employees = [] } = useEmployees();
  const { data: rateHistory } = usePayRates();
  return useMemo(() => {
    const empById = new Map(employees.map((e) => [e.id, e]));
    const nameOf = (r: R) => { const e = empById.get(r.employee_id); return e ? fullName(e) : ""; };
    return recordColumns<R>({
      ...(showName ? { name: nameOf } : {}),
      shift: (r) => shiftForRecord(r.shift_id, empById.get(r.employee_id)?.shift_id, shifts).name,
      rate: (r) => rateOn(rateHistory?.get(r.employee_id), empById.get(r.employee_id)?.hourly_rate ?? 0, r.work_date),
      pay: (r) => pay?.get(r.id),
    });
  }, [shifts, employees, rateHistory, pay, showName]);
}

/** The shift a record was worked on, flagged when it isn't the employee's usual one. */
export function RecordShiftCell({ shiftId, employeeShiftId, shifts, cell = "px-3 py-3", td, editor }: {
  shiftId: string | null | undefined; employeeShiftId: string | null | undefined; shifts: Shift[]; cell?: string;
  /** Extra props for the cell (Time records' "Edit in cells"), and the text box shown instead while it's edited. */
  td?: React.TdHTMLAttributes<HTMLTableCellElement> | undefined; editor?: React.ReactNode;
}) {
  const s = shiftForRecord(shiftId, employeeShiftId, shifts);
  if (editor) return <td {...td} className={`${cell} ${td?.className ?? ""}`}>{editor}</td>;
  return (
    <td {...td} className={`${cell} whitespace-nowrap font-body ${td?.className ?? ""}`}>
      {s.name}{s.multiplier !== 1 && <span className="ml-1 font-mono text-[11px] text-muted-foreground">×{s.multiplier}</span>}
      {s.changed && <div className="text-[10px] text-primary" title="Worked on a different shift than usual">changed</div>}
    </td>
  );
}

/** Picks a record's shift. "" = the employee's own shift (named when there's one employee). */
export function RecordShiftSelect({ value, onChange, shifts, ownLabel, className }: {
  value: string; onChange: (id: string) => void; shifts: Shift[]; ownLabel: string; className?: string;
}) {
  return (
    <select className={className} value={value} onChange={(e) => onChange(e.target.value)} aria-label="Shift">
      <option value="">{ownLabel}</option>
      {shifts.map((x) => <option key={x.id} value={x.id}>{x.name}{Number(x.multiplier) !== 1 ? ` (×${Number(x.multiplier)})` : ""}</option>)}
    </select>
  );
}
