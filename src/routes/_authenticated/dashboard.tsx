import { createFileRoute, Link } from "@tanstack/react-router";
import { AppShell, StatCard, btnPrimary } from "@/components/AppShell";
import { RecordsTable } from "@/components/RecordsTable";
import { currentWeek, fullName, money, useAllRecords, useEmployees, usePayrollSettings, useRecords, useShifts } from "@/lib/payroll";
import { employeePay, shiftFor } from "@/lib/pay";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — Meridian Payroll" }] }),
  component: Dashboard,
});

function Dashboard() {
  const week = currentWeek();
  const { data: employees = [] } = useEmployees();
  const { data: records = [] } = useRecords(week.from, week.to);
  const { data: all = [] } = useAllRecords(week.from, week.to);
  const { data: shifts = [] } = useShifts();
  const { data: settings } = usePayrollSettings();
  const rules = { threshold: settings?.ot_threshold ?? 40, otMultiplier: settings?.ot_multiplier ?? 1.5, weekendOvertime: settings?.weekend_overtime ?? true };

  const hours = all.reduce((s, r) => s + Number(r.hours), 0);
  const lunch = all.reduce((s, r) => s + r.lunch_minutes, 0) / 60;

  // Same pay rules as the Payroll page: weekend and weekly overtime, shift multipliers, manual day pay.
  const byEmp = new Map<string, { name: string; hours: number; pay: number }>();
  for (const e of employees) {
    const recs = all.filter((r) => r.employee_id === e.id);
    if (!recs.length) continue;
    const p = employeePay(recs, { rate: Number(e.hourly_rate), shiftMultiplier: shiftFor(e.shift_id, shifts).multiplier, rules, payType: e.pay_type, shifts, from: week.from, to: week.to });
    byEmp.set(e.id, { name: fullName(e), hours: p.regular + p.overtime, pay: p.total });
  }
  const gross = [...byEmp.values()].reduce((s, x) => s + x.pay, 0);
  const top = [...byEmp.values()].sort((a, b) => b.pay - a.pay).slice(0, 5);

  return (
    <AppShell
      eyebrow="Pay period"
      title={`Week of ${week.from} – ${week.to}`}
      actions={<Link to="/payroll" className={btnPrimary}>Run payroll</Link>}
    >
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Gross pay" value={money(gross)} sub={`${byEmp.size} employees · ${hours.toFixed(2)} h`} />
        <StatCard label="Total hours" value={hours.toFixed(2)} sub={`${lunch.toFixed(2)} h unpaid break`} delay={60} />
        <StatCard label="Employees" value={String(employees.length)} sub={`${employees.filter((e) => e.user_id).length} with accounts`} delay={120} />
        <StatCard label="Records" value={`${all.length} rows`} sub="this week" highlight delay={180} />
      </section>
      <section className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <RecordsTable records={records} />
        </div>
        <div className="space-y-6">
          <div className="glass-panel p-5">
            <div className="font-display text-sm font-extrabold tracking-tight">Import hours</div>
            <Link to="/import" className="mt-3 block rounded-xl border-2 border-dashed border-primary/30 bg-accent p-6 text-center">
              <div className="font-mono text-[11px] text-accent-foreground">Drop CSV / XLSX</div>
              <div className="mt-1 text-[11px] text-muted-foreground">or browse files</div>
            </Link>
          </div>
          <div className="glass-panel p-5">
            <div className="label-mono">Top earners · this week</div>
            <div className="mt-3 space-y-2">
              {top.length === 0 && <div className="text-sm text-muted-foreground">No hours logged yet.</div>}
              {top.map((t) => (
                <div key={t.name} className="flex items-center justify-between text-sm">
                  <span>{t.name}</span>
                  <span className="font-mono text-[12px]">{t.hours.toFixed(2)} h · <b>{money(t.pay)}</b></span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </AppShell>
  );
}
