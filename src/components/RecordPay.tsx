import { money } from "@/lib/payroll";
import type { PayLine } from "@/lib/pay";

/** Headers for the per-record pay columns, matching <RecordPayCells>. */
export function RecordPayHeaders({ className = "px-3 py-3 text-right font-medium" }: { className?: string }) {
  return (
    <>
      <th className={className}>Reg hrs</th>
      <th className={className}>OT hrs</th>
      <th className={className}>Reg pay</th>
      <th className={className}>OT pay</th>
      <th className={className} title="What this day pays: regular + overtime pay, the salaried share of the week, or the manual amount. Extra-pay entries are added on the Payroll page.">Total pay</th>
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
