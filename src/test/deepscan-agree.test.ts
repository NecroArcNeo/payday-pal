// @vitest-environment node
// Deep scan: every page that shows pay must agree on it. The Payroll page, Reports (every split and grouping), each
// person's Timesheet and its export are worked out from the same database for random periods, mid-week starts included.
import { describe, expect, it } from "vitest";
import { memoryDb } from "./sqlite-db";
import { createLocalStore, type DataStore } from "@/lib/db/store";
import { employeePay, payByRecord, shiftFor, weekEnd, weekStart } from "@/lib/pay";
import { buildReport, type GroupBy, type SplitBy } from "@/lib/report";
import { employeeTimesheet } from "@/lib/export/employee-timesheet";
import { plainCsv } from "@/lib/export/timesheet-export";
import { lockThrough } from "@/lib/pay-freeze";
import type { RateEntry } from "@/lib/pay-rates";

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const day = (d: number) => new Date(Date.UTC(2026, 8, 1) + d * 864e5).toISOString().slice(0, 10);

async function seed(store: DataStore) {
  const shifts = await store.listShifts();
  await store.update("shifts", shifts[1]!.id, { multiplier: 1.3 });
  await store.insert("employee_field_defs", { label: "Locker", field_type: "number" });
  const emps = Array.from({ length: 14 }, (_, i) => ({
    employee_code: `E${i}`, first_name: `F${i}`, last_name: `L${i}`, hourly_rate: 15 + (i % 5) * 2.37,
    department: i % 4 === 3 ? null : ["Ops", "Kitchen", "Front"][i % 3]!, pay_type: i % 6 === 0 ? "salary" : "hourly", shift_id: i % 4 === 0 ? shifts[1]!.id : null,
  }));
  await store.insert("employees", emps);
  const list = await store.listEmployees();
  for (const e of list.slice(0, 5)) await store.update("employees", e.id, { hourly_rate: Number(e.hourly_rate) + 1.11 });
  const r = rng(1);
  const recs = [];
  for (const [i, e] of list.entries()) for (let d = 0; d < 70; d++) {
    if (r() < 0.25) continue;
    recs.push(r() < 0.5
      ? { employee_id: e.id, work_date: day(d), entry_mode: "clock" as const, clock_in: i % 4 === 0 ? "22:00" : "08:15", clock_out: i % 4 === 0 ? "07:00" : "17:40", lunch_minutes: 30, shift_id: r() < 0.1 ? shifts[0]!.id : null, pay_override: r() < 0.03 ? 111.11 : null }
      : { employee_id: e.id, work_date: day(d), entry_mode: "hours" as const, hours: Math.round(r() * 1100) / 100 });
  }
  expect((await store.insert("time_records", recs)).error).toBeNull();
  await store.insert("pay_adjustments", list.slice(0, 8).map((e, i) => ({ employee_id: e.id, pay_date: day(5 + i * 7), category: "bonus", amount: i % 2 ? 40.5 : -12.25 })));
  // Some days locked (their pay saved), then a rate change and new rules, so locked and live pay differ.
  await lockThrough(store, day(20));
  await store.update("employees", list[1]!.id, { hourly_rate: 40 });
  await store.saveSettings({ ot_threshold: 38, ot_multiplier: 1.75, weekend_overtime: true, visible_columns: [] });
}

describe("deep scan: every page agrees on pay", () => {
  it("Payroll, Reports (every split and grouping), Timesheets and their exports", async () => {
    const db = await memoryDb();
    const store = createLocalStore(async () => db);
    await seed(store);
    const [employees, shifts, history, settings, adjustmentsAll, defs] = await Promise.all([
      store.listEmployees(), store.listShifts(), store.listPayRates(), store.getSettings(), store.listAdjustments(), store.listFieldDefs()]);
    const rates = new Map<string, RateEntry[]>();
    for (const x of history) rates.set(x.employee_id, [...(rates.get(x.employee_id) ?? []), x]);
    const rules = { threshold: Number(settings!.ot_threshold), otMultiplier: Number(settings!.ot_multiplier), weekendOvertime: settings!.weekend_overtime };
    const r = rng(2);
    for (let n = 0; n < 40; n++) {
      const a = Math.floor(r() * 70), b = a + Math.floor(r() * 40);
      const from = day(a), to = day(b);
      const ctx = `${from}..${to}`;
      // As the Payroll page loads: whole weeks around the period.
      const records = await store.listRecordsMatching({ from: weekStart(from), to: weekEnd(to) });
      const adjustments = adjustmentsAll.filter((x) => x.pay_date >= from && x.pay_date <= to);
      let payroll = 0, payrollHours = 0;
      const perEmp = new Map<string, number>();
      for (const e of employees) {
        const own = records.filter((x) => x.employee_id === e.id);
        const p = employeePay(own, { rate: Number(e.hourly_rate), rates: rates.get(e.id), shiftMultiplier: shiftFor(e.shift_id, shifts).multiplier, rules, payType: e.pay_type, shifts, from, to });
        const extra = adjustments.filter((x) => x.employee_id === e.id).reduce((s, x) => s + Number(x.amount), 0);
        payroll += p.total + extra; payrollHours += p.regular + p.overtime;
        perEmp.set(e.id, p.total + extra);
      }
      const pay = payByRecord(records, employees, shifts, rules, rates);
      const report = (metric: "pay" | "hours" | "reg_ot", splitBy: SplitBy, groupBy: GroupBy) =>
        buildReport({ records, employees, shifts, rates, rules, adjustments, from, to, groupBy, metric, splitBy, pay });
      for (const groupBy of ["day", "week", "month", "year"] as const) {
        for (const splitBy of ["none", "department", "shift", "employee"] as const) {
          const rep = report("pay", splitBy, groupBy);
          expect(rep.total, `${ctx} pay ${groupBy}/${splitBy}`).toBeCloseTo(payroll, 6);
          const cells = rep.values.flat().reduce((s, v) => s + v, 0);
          expect(cells, `${ctx} cells ${groupBy}/${splitBy}`).toBeCloseTo(payroll, 6);
          expect(rep.seriesTotals.reduce((s, v) => s + v, 0), `${ctx} series ${groupBy}/${splitBy}`).toBeCloseTo(payroll, 6);
        }
        expect(report("hours", "none", groupBy).total, `${ctx} hours`).toBeCloseTo(payrollHours, 6);
        expect(report("reg_ot", "none", groupBy).total, `${ctx} reg+ot`).toBeCloseTo(payrollHours, 6);
      }
      // Each person's Timesheet (rounded to the cent per person) and its CSV.
      let sheets = 0;
      for (const e of employees) {
        const src = employeeTimesheet(e, { from, to, today: "2026-11-03", records, adjustments, shifts, defs, rateHistory: rates.get(e.id), rules });
        const data = src("record", null, 1);
        const total = Number(data.values.total_pay);
        // The timesheet rounds to the cent: at most half a cent off.
        expect(Math.abs(total - perEmp.get(e.id)!), `${ctx} timesheet ${e.employee_code}`).toBeLessThanOrEqual(0.005 + 1e-9);
        sheets += total;
        const rowPay = data.rows.reduce((s, row) => s + (Number(row.pay) || 0), 0);
        // The rows add up to the total to the cent.
        expect(Math.round((rowPay + Number(data.values.extra_pay)) * 100), `${ctx} timesheet rows ${e.employee_code}`).toBe(Math.round(total * 100));
        for (const k of ["regular_pay", "overtime_pay"] as const) expect(Math.round(data.rows.reduce((s, row) => s + (Number(row[k]) || 0), 0) * 100), k).toBe(Math.round(Number(data.values[k]) * 100));
        const days = src("day", null, 1);
        expect(days.rows.length, `${ctx} one row per day`).toBe(b - a + 1);
        expect(plainCsv(data)).toContain(e.employee_code);
      }
      expect(Math.abs(sheets - payroll), `${ctx} sheets`).toBeLessThan(0.005 * employees.length + 1e-9);
    }
  }, 120_000);
});
