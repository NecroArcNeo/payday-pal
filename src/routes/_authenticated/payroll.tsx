import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AppShell, StatCard, btnGhost, inputCls } from "@/components/AppShell";
import { currentWeek, fullName, money, useRecords } from "@/lib/payroll";

export const Route = createFileRoute("/_authenticated/payroll")({
  head: () => ({ meta: [{ title: "Payroll — Meridian Payroll" }] }),
  component: PayrollPage,
});

function PayrollPage() {
  const w = currentWeek();
  const [from, setFrom] = useState(w.from);
  const [to, setTo] = useState(w.to);
  const { data: records = [] } = useRecords(from, to);

  const rows = new Map<string, { code: string; name: string; rate: number; hours: number; days: number }>();
  records.forEach((r) => {
    if (!r.employees) return;
    const cur = rows.get(r.employee_id) ?? { code: r.employees.employee_code, name: fullName(r.employees), rate: Number(r.employees.hourly_rate), hours: 0, days: 0 };
    cur.hours += Number(r.hours);
    cur.days += 1;
    rows.set(r.employee_id, cur);
  });
  const list = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  const totalH = list.reduce((s, r) => s + r.hours, 0);
  const totalP = list.reduce((s, r) => s + r.hours * r.rate, 0);

  const exportCsv = () => {
    const lines = [["Employee ID", "Name", "Days", "Hours", "Rate", "Gross pay"], ...list.map((r) => [r.code, r.name, r.days, r.hours.toFixed(2), r.rate.toFixed(2), (r.hours * r.rate).toFixed(2)])];
    const csv = lines.map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `payroll_${from}_${to}.csv`;
    a.click();
  };

  return (
    <AppShell eyebrow="Payroll run" title={`${from} – ${to}`} actions={<button onClick={exportCsv} className={btnGhost}>Export CSV</button>}>
      <div className="flex items-center gap-3">
        <span className="label-mono">Period</span>
        <input type="date" className={`${inputCls} max-w-[11rem]`} value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="text-muted-foreground">→</span>
        <input type="date" className={`${inputCls} max-w-[11rem]`} value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <section className="grid grid-cols-3 gap-4">
        <StatCard label="Gross pay" value={money(totalP)} highlight />
        <StatCard label="Total hours" value={totalH.toFixed(2)} delay={60} />
        <StatCard label="Employees paid" value={String(list.length)} delay={120} />
      </section>
      <div className="glass-panel overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
              <th className="px-5 py-3 text-left font-medium">Employee</th>
              <th className="px-3 py-3 text-left font-medium">ID</th>
              <th className="px-3 py-3 text-right font-medium">Days</th>
              <th className="px-3 py-3 text-right font-medium">Hours</th>
              <th className="px-3 py-3 text-right font-medium">Rate</th>
              <th className="px-5 py-3 text-right font-medium">Gross pay</th>
            </tr>
          </thead>
          <tbody className="font-mono text-[13px]">
            {list.length === 0 && <tr><td colSpan={6} className="px-5 py-10 text-center font-body text-muted-foreground">No hours in this period.</td></tr>}
            {list.map((r) => (
              <tr key={r.code} className="border-b border-border last:border-0 hover:bg-secondary">
                <td className="px-5 py-3 font-body">{r.name}</td>
                <td className="px-3 py-3">{r.code}</td>
                <td className="px-3 py-3 text-right">{r.days}</td>
                <td className="px-3 py-3 text-right">{r.hours.toFixed(2)}</td>
                <td className="px-3 py-3 text-right">{money(r.rate)}</td>
                <td className="px-5 py-3 text-right font-semibold">{money(r.hours * r.rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}
