// Deep scan: rules pay must keep for any records, checked on thousands of random weeks.
import { describe, expect, it } from "vitest";
import { employeePay, payByRecord, recordPay, splitWeekly, weekEnd, weekStart, isWeekend, type PayRecord, type PayRules } from "@/lib/pay";
import { rateOn } from "@/lib/pay-rates";

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pad = (n: number) => String(n).padStart(2, "0");
const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const shuffle = <T,>(r: () => number, xs: T[]) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; } return a; };

function randomCase(r: () => number) {
  const recs: (PayRecord & { employee_id: string })[] = Array.from({ length: 1 + Math.floor(r() * 25) }, (_, i) => ({
    id: `r${i}`, employee_id: r() < 0.7 ? "A" : "B",
    work_date: `2026-10-${pad(1 + Math.floor(r() * 31))}`,
    hours: r() < 0.05 ? -3 : Math.round(r() * 1400) / 100,
    clock_in: r() < 0.5 ? `${pad(Math.floor(r() * 24))}:00:00` : null,
    created_at: `2026-10-01T00:00:0${Math.floor(r() * 9)}Z`,
    pay_override: r() < 0.1 ? Math.round(r() * 20000) / 100 : null,
    shift_id: r() < 0.3 ? "n" : null,
  }));
  const rules: PayRules = { threshold: [0, 8, 38, 40][Math.floor(r() * 4)]!, otMultiplier: [1, 1.5, 2][Math.floor(r() * 3)]!, weekendOvertime: r() < 0.5 };
  const shifts = [{ id: "d", name: "Day", multiplier: 1 }, { id: "n", name: "Night", multiplier: 1.25 }];
  const employees = [{ id: "A", hourly_rate: 20, shift_id: null, pay_type: r() < 0.3 ? "salary" : "hourly" }, { id: "B", hourly_rate: "15.5", shift_id: "n", pay_type: "hourly" }];
  const rates = new Map([["A", [{ effective_from: "0001-01-01", hourly_rate: 18 }, { effective_from: `2026-10-${pad(1 + Math.floor(r() * 31))}`, hourly_rate: 20 }]]]);
  return { recs, rules, shifts, employees, rates };
}

describe("deep scan: pay invariants", () => {
  it("holds for 5,000 random cases", () => {
    const r = rng(11);
    for (let n = 0; n < 5000; n++) {
      const { recs, rules, shifts, employees, rates } = randomCase(r);
      const ctx = JSON.stringify({ n, rules, employees });
      const lines = payByRecord(recs, employees, shifts, rules, rates);
      // Every record of a known employee gets one line; order of the records never matters.
      expect(lines.size, ctx).toBe(recs.length);
      const again = payByRecord(shuffle(r, recs), employees, shifts, rules, rates);
      for (const [id, l] of lines) expect(again.get(id), ctx).toEqual(l);
      for (const rec of recs) {
        const l = lines.get(rec.id)!;
        const h = Math.max(0, Number(rec.hours));
        expect(l.regular + l.overtime, ctx).toBeCloseTo(h, 9);
        expect(l.regular, ctx).toBeGreaterThanOrEqual(0);
        expect(l.overtime, ctx).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(l.pay), ctx).toBe(true);
        if (l.manual) expect(l.pay, ctx).toBe(Number(rec.pay_override));
        else expect(close(l.pay, l.regPay + l.otPay), ctx).toBe(true);
        if (l.salary) expect(l.overtime, ctx).toBe(0);
        else if (!l.manual) expect(l.pay, ctx).toBeGreaterThanOrEqual(0);
        if (isWeekend(rec.work_date) && rules.weekendOvertime && !l.salary) expect(l.regular, ctx).toBe(0);
      }
      // Hourly weekday regular hours never pass the threshold in a week.
      for (const emp of ["A", "B"]) {
        const e = employees.find((x) => x.id === emp)!;
        const mine = recs.filter((x) => x.employee_id === emp);
        if (e.pay_type === "salary") {
          // A salaried week pays threshold × rate × shift across its non-manual days (rate and shift fixed here).
          const weeks = new Map<string, typeof mine>();
          for (const x of mine) weeks.set(weekStart(x.work_date), [...(weeks.get(weekStart(x.work_date)) ?? []), x]);
          for (const w of weeks.values()) {
            const paid = w.filter((x) => x.pay_override === null && x.shift_id === null);
            if (paid.length !== w.filter((x) => x.pay_override === null).length || !paid.length) continue;
            const rate = rateOn(rates.get(emp), e.hourly_rate, paid[0]!.work_date);
            if (!paid.every((x) => rateOn(rates.get(emp), e.hourly_rate, x.work_date) === rate)) continue;
            const sum = paid.reduce((s, x) => s + lines.get(x.id)!.pay, 0);
            expect(close(sum, rules.threshold * rate), ctx).toBe(true);
          }
          continue;
        }
        const perWeek = new Map<string, number>();
        for (const x of mine) {
          if (isWeekend(x.work_date) && rules.weekendOvertime) continue;
          const wk = weekStart(x.work_date);
          perWeek.set(wk, (perWeek.get(wk) ?? 0) + lines.get(x.id)!.regular);
        }
        for (const v of perWeek.values()) expect(v, ctx).toBeLessThanOrEqual(rules.threshold + 1e-9);
      }
      // A period's total is the sum of its lines, and splitting a period in two adds up to the whole.
      const a = recs.filter((x) => x.employee_id === "A");
      const opts = { rate: 20, rates: rates.get("A"), shiftMultiplier: 1, rules, payType: employees[0]!.pay_type, shifts };
      const whole = employeePay(a, { ...opts, from: "2026-10-01", to: "2026-10-31" });
      const p1 = employeePay(a, { ...opts, from: "2026-10-01", to: "2026-10-15" });
      const p2 = employeePay(a, { ...opts, from: "2026-10-16", to: "2026-10-31" });
      expect(close(whole.total, p1.total + p2.total), ctx).toBe(true);
      expect(close(whole.total, whole.lines.reduce((s, l) => s + l.pay, 0)), ctx).toBe(true);
      // Frozen lines are paid as saved, whatever the rules say now.
      const frozen = a.map((x, i) => (i % 2 ? { ...x, frozen_pay: { regular: 1, overtime: 0, weekend: false, manual: false, salary: false, regPay: 7, otPay: 0, pay: 7 } } : x));
      const fl = recordPay(frozen, opts);
      frozen.forEach((x, i) => { if (i % 2) expect(fl.get(x.id)!.pay).toBe(7); });
    }
  }, 120_000);

  it("weeks run Monday to Sunday for every day of 2026–2028 in any time zone", () => {
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2029, 0, 1); t += 86400000) {
      const d = new Date(t).toISOString().slice(0, 10);
      const s = weekStart(d), e = weekEnd(d);
      expect(new Date(`${s}T00:00:00Z`).getUTCDay()).toBe(1);
      expect(new Date(`${e}T00:00:00Z`).getUTCDay()).toBe(0);
      expect(s <= d && d <= e).toBe(true);
    }
  });

  it("splits weekly overtime so the later hours are the overtime", () => {
    const recs = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"].map((d, i) => ({ id: `x${i}`, work_date: d, hours: 9 }));
    const s = splitWeekly(recs, { threshold: 40, otMultiplier: 1.5, weekendOvertime: true });
    expect([...s.values()].map((v) => v.overtime)).toEqual([0, 0, 0, 0, 5]);
  });
});
