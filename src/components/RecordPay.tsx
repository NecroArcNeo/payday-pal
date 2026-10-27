import { money, type Shift } from "@/lib/payroll";
import { shiftForRecord, type PayLine } from "@/lib/pay";
import { EditableLabel } from "@/components/EditableLabel";

/** Headers for the per-record pay columns, matching <RecordPayCells>. */
export function RecordPayHeaders({ className = "px-3 py-3 text-right font-medium" }: { className?: string }) {
  return (
    <>
      <th className={className}><EditableLabel k="reg_hrs" name="Reg hrs" /></th>
      <th className={className}><EditableLabel k="ot_hrs" name="OT hrs" /></th>
      <th className={className}><EditableLabel k="reg_pay" name="Reg pay" /></th>
      <th className={className}><EditableLabel k="ot_pay" name="OT pay" /></th>
      <th className={className} title="What this day pays: regular + overtime pay, the salaried share of the week, or the manual amount. Extra-pay entries are added on the Payroll page."><EditableLabel k="total_pay" name="Total pay" /></th>
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

/** The shift a record was worked on, flagged when it isn't the employee's usual one. */
export function RecordShiftCell({ shiftId, employeeShiftId, shifts, cell = "px-3 py-3" }: {
  shiftId: string | null | undefined; employeeShiftId: string | null | undefined; shifts: Shift[]; cell?: string;
}) {
  const s = shiftForRecord(shiftId, employeeShiftId, shifts);
  return (
    <td className={`${cell} whitespace-nowrap font-body`}>
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
