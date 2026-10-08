import { createFileRoute } from "@tanstack/react-router";
import { AppShell, StatCard } from "@/components/AppShell";
import { RecordsTable } from "@/components/RecordsTable";
import { currentWeek, fullName, money, useEmployees, useRecords } from "@/lib/payroll";

export const Route = createFileRoute("/_authenticated/me")({
  head: () => ({ meta: [{ title: "My hours & pay — Meridian Payroll" }] }),
  component: MePage,
});

function MePage() {
  const { data: emps = [], isLoading } = useEmployees();
  const w = currentWeek();
  const { data: all = [] } = useRecords();
  const me = emps[0];
  const week = all.filter((r) => r.work_date >= w.from && r.work_date <= w.to);
  const rate = Number(me?.hourly_rate ?? 0);
  const wh = week.reduce((s, r) => s + Number(r.hours), 0);
  const th = all.reduce((s, r) => s + Number(r.hours), 0);

  if (!isLoading && !me) {
    return (
      <AppShell eyebrow="Self-view" title="My hours & pay">
        <div className="glass-panel p-8 text-center text-muted-foreground">
          Your account isn't linked to an employee record yet. Ask your payroll admin to add your email to your employee profile.
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell eyebrow={`Self-view · ${me ? fullName(me) : ""}`} title="My hours & pay">
      <section className="grid grid-cols-3 gap-4">
        <StatCard label="This week" value={money(wh * rate)} sub={`${wh.toFixed(2)} h × ${money(rate)}`} highlight />
        <StatCard label="All-time hours" value={th.toFixed(2)} delay={60} />
        <StatCard label="All-time gross" value={money(th * rate)} delay={120} />
      </section>
      <RecordsTable records={all} title="My records" showName={false} />
    </AppShell>
  );
}
