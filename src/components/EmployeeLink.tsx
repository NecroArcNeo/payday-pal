import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { HoverCard, HoverCardContent, HoverCardPortal, HoverCardTrigger } from "@/components/ui/hover-card";
import { db } from "@/lib/db/mode";
import { useLabels } from "@/lib/labels";
import { fullName, isoDate, money, useEmployees, usePayRates, usePayrollSettings, useShifts, useHolidays } from "@/lib/payroll";
import { payByRecord, shiftFor, weekEnd, weekStart, payRules } from "@/lib/pay";
import { rateOn } from "@/lib/pay-rates";

/**
 * An employee's name that opens their profile. Use it wherever a name is shown (not where it's being picked), so
 * every name works the same way. Clicks stop here, so a row's own click (select, edit) doesn't also happen.
 * Resting the pointer on it shows a card with their rate, shift and this week so far.
 */
export function EmployeeLink({ id, name, className = "" }: { id: string; name: string; className?: string | undefined }) {
  return (
    <HoverCard openDelay={450} closeDelay={100}>
      <HoverCardTrigger asChild>
        <Link to="/employees/$id" params={{ id }} onClick={(e) => e.stopPropagation()}
          className={`underline-offset-2 hover:text-primary hover:underline ${className}`}>
          {name}
        </Link>
      </HoverCardTrigger>
      {/* In a portal, so tables and panels that clip their overflow don't cut the card off. The card only exists
          while open, so a page of names doesn't load anything until one is hovered. */}
      <HoverCardPortal>
        <HoverCardContent align="start" className="w-72 text-sm" onClick={(e) => e.stopPropagation()}>
          <EmployeeCard id={id} />
        </HoverCardContent>
      </HoverCardPortal>
    </HoverCard>
  );
}

function EmployeeCard({ id }: { id: string }) {
  const { label } = useLabels();
  const { data: employees } = useEmployees();
  const { data: shifts = [] } = useShifts();
  const { data: rates } = usePayRates();
  const { data: settings } = usePayrollSettings();
  const { data: holidays } = useHolidays();
  const today = isoDate(new Date());
  const from = weekStart(today), to = weekEnd(today);
  // This week's records for this person: a whole Mon–Sun week, so overtime is right.
  const { data: week } = useQuery({
    queryKey: ["records", "card", id, from],
    queryFn: () => db().listRecordsMatching({ from, to, employeeIds: [id] }),
  });
  const emp = employees?.find((e) => e.id === id);
  if (!emp) return <span className="text-muted-foreground">Loading…</span>;

  const shift = shiftFor(emp.shift_id, shifts);
  const rate = rateOn(rates?.get(id), emp.hourly_rate, today);
  const pay = week && settings && holidays
    ? [...payByRecord(week, [emp], shifts, payRules(settings, holidays), rates).values()]
    : null;
  const hours = pay?.reduce((a, l) => a + l.regular + l.overtime, 0) ?? 0;
  const ot = pay?.reduce((a, l) => a + l.overtime, 0) ?? 0;
  const days = new Set(week?.map((r) => r.work_date)).size;
  const role = [emp.job_title, emp.department].filter(Boolean).join(" · ");

  const line = (k: string, v: string) => (
    <div className="flex justify-between gap-3"><span className="text-muted-foreground">{k}</span><span className="text-right font-mono text-[13px]">{v}</span></div>
  );
  return (
    <div className="space-y-2">
      <div>
        <div className="font-semibold">{fullName(emp)}{emp.active === false && <span className="ml-2 rounded-md bg-secondary px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground ring-1 ring-border">resigned</span>}</div>
        <div className="text-xs text-muted-foreground">{[emp.employee_code, role].filter(Boolean).join(" · ")}</div>
      </div>
      <div className="space-y-1 border-t border-border pt-2">
        {line(label("hourly_rate", "Rate"), `${money(rate)}/h${emp.pay_type === "salary" ? " (salary)" : ""}`)}
        {line(label("shift", "Shift"), `${shift.name}${Number(shift.multiplier) !== 1 ? ` ×${Number(shift.multiplier)}` : ""}`)}
      </div>
      <div className="space-y-1 border-t border-border pt-2">
        <div className="label-mono">This week ({from} – {to})</div>
        {!pay ? <div className="text-muted-foreground">Loading…</div>
          : days === 0 ? <div className="text-muted-foreground">No records yet.</div>
          : <>
              {line(label("hours", "Hours"), `${Number(hours.toFixed(2))} h${ot ? ` (${Number(ot.toFixed(2))} overtime)` : ""}`)}
              {line(label("days", "Days"), String(days))}
              {line(label("gross_pay", "Gross pay"), money(pay.reduce((a, l) => a + l.pay, 0)))}
            </>}
      </div>
    </div>
  );
}
