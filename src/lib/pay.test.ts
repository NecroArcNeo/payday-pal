import { describe, expect, it } from "vitest";
import { employeePay, isWeekend, payByRecord, recordPay, shiftFor, shiftForRecord, splitWeekly, weekEnd, weekStart, type PayRecord } from "./pay";

const rules = { threshold: 40, otMultiplier: 1.5, weekendOvertime: true };
// The week of Mon 2026-10-19 … Sun 2026-10-25.
const day = (date: string, hours: number, extra: Partial<PayRecord> = {}): PayRecord => ({ id: `${date}-${hours}-${extra.clock_in ?? ""}`, work_date: date, hours, ...extra });
const weekdays = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"];
const pay = (records: PayRecord[], o: Partial<Parameters<typeof employeePay>[1]> = {}) =>
  employeePay(records, { rate: 20, shiftMultiplier: 1, rules, from: "2026-10-19", to: "2026-10-25", ...o });

describe("weeks and weekends", () => {
  it("knows weekends and Mon–Sun week bounds", () => {
    expect(["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"].map(isWeekend)).toEqual([false, true, true, false]);
    expect(weekStart("2026-10-25")).toBe("2026-10-19");
    expect(weekEnd("2026-10-19")).toBe("2026-10-25");
    expect(weekStart("2026-11-01")).toBe("2026-10-26");
  });
});

describe("overtime", () => {
  it("pays every Saturday and Sunday hour as overtime, even in a short week", () => {
    const r = pay([day("2026-10-19", 8), day("2026-10-24", 5), day("2026-10-25", 3)]);
    expect([r.regular, r.overtime, r.weekendHours]).toEqual([8, 8, 8]);
    expect(r.regPay).toBe(160);
    expect(r.otPay).toBe(8 * 20 * 1.5);
  });

  it("makes weekday hours past 40 overtime, and weekend hours don't count toward the 40", () => {
    const r = pay([...weekdays.map((d) => day(d, 9)), day("2026-10-24", 4)]);
    expect([r.regular, r.overtime]).toEqual([40, 9]);
    expect(r.regPay).toBe(800);
    expect(r.otPay).toBe(9 * 30);
  });

  it("puts overtime on the later days of the week", () => {
    const split = splitWeekly([day("2026-10-23", 10), day("2026-10-19", 12), day("2026-10-20", 12), day("2026-10-21", 12)], rules);
    // Mon–Wed 36 h, all regular; Friday (listed first) takes the 4 remaining regular hours and 6 overtime.
    expect(split.get("2026-10-21-12-")).toEqual({ regular: 12, overtime: 0, weekend: false });
    expect(split.get("2026-10-23-10-")).toEqual({ regular: 4, overtime: 6, weekend: false });
  });

  it("counts each Mon–Sun week separately", () => {
    const r = employeePay([...weekdays.map((d) => day(d, 9)), ...["2026-10-26", "2026-10-27"].map((d) => day(d, 9))], { rate: 20, shiftMultiplier: 1, rules, from: "2026-10-19", to: "2026-10-31" });
    expect([r.regular, r.overtime]).toEqual([58, 5]);
  });

  it("counts days before the period toward that week's overtime without paying them", () => {
    const records = weekdays.map((d) => day(d, 10));
    const r = pay(records, { from: "2026-10-22", to: "2026-10-25" });
    expect([r.regular, r.overtime, r.days]).toEqual([10, 10, 2]);
  });

  it("treats weekends like weekdays when the weekend rule is off", () => {
    const r = pay([day("2026-10-24", 8)], { rules: { ...rules, weekendOvertime: false } });
    expect([r.regular, r.overtime]).toEqual([8, 0]);
  });
});

describe("shifts and manual pay", () => {
  it("scales regular hours by the shift multiplier, but never stacks it with overtime", () => {
    const r = pay([day("2026-10-19", 8), day("2026-10-24", 2)], { shiftMultiplier: 1.25 });
    expect(r.regPay).toBe(8 * 25);
    expect(r.otPay).toBe(2 * 20 * 1.5);
    // A ×1.3 night worker past 40 weekday hours: shift pay for the 40, plain ×1.5 for the rest.
    const night = pay(weekdays.map((d) => day(d, 9)), { shiftMultiplier: 1.3 });
    expect([night.regular, night.overtime]).toEqual([40, 5]);
    expect(night.regPay).toBeCloseTo(40 * 20 * 1.3);
    expect(night.otPay).toBe(5 * 20 * 1.5);
  });

  it("pays a day at the record's own shift when it differs from the employee's", () => {
    const shifts = [{ id: "d", name: "Day", multiplier: 1 }, { id: "n", name: "Night", multiplier: 1.3 }];
    // A night worker covering a day shift on Monday, then nights the rest of the week.
    const recs = [day("2026-10-19", 8, { shift_id: "d" }), day("2026-10-20", 8), day("2026-10-21", 8, { shift_id: "gone" })];
    const r = pay(recs, { shiftMultiplier: 1.3, shifts });
    expect(r.lines.map((l) => l.regPay)).toEqual([160, 8 * 20 * 1.3, 8 * 20 * 1.3]);
    expect(shiftForRecord("d", "n", shifts)).toMatchObject({ name: "Day", changed: true });
    expect(shiftForRecord(null, "n", shifts)).toMatchObject({ name: "Night", changed: false });
    expect(shiftForRecord("n", "n", shifts)).toMatchObject({ name: "Night", changed: false });
  });

  it("pays a manual day exactly what was entered, while its hours still count toward the week", () => {
    const r = pay([...weekdays.slice(0, 4).map((d, i) => day(d, 10, i === 3 ? { pay_override: 500 } : {})), day("2026-10-23", 8)]);
    expect([r.regular, r.overtime, r.manualDays]).toEqual([40, 8, 1]);
    expect(r.manualPay).toBe(500);
    expect(r.regPay).toBe(30 * 20);
    expect(r.otPay).toBe(8 * 30);
    expect(r.total).toBe(600 + 240 + 500);
  });

  it("falls back to the first shift, and to ×1 when there are no shifts", () => {
    const shifts = [{ id: "d", name: "Day", multiplier: 1 }, { id: "n", name: "Night", multiplier: "1.2" }];
    expect(shiftFor("n", shifts)).toEqual({ id: "n", name: "Night", multiplier: 1.2 });
    expect(shiftFor("gone", shifts).name).toBe("Day");
    expect(shiftFor(null, [])).toEqual({ id: null, name: "Day", multiplier: 1 });
  });
});

describe("pay for each record", () => {
  it("gives every record its regular and overtime hours and pay, adding up to the period total", () => {
    const recs = [...weekdays.map((d) => day(d, 9)), day("2026-10-24", 4, { pay_override: 100 })];
    const lines = recordPay(recs, { rate: 20, shiftMultiplier: 1, rules });
    const fri = lines.get(recs[4]!.id)!;
    expect([fri.regular, fri.overtime, fri.regPay, fri.otPay, fri.pay]).toEqual([4, 5, 80, 150, 230]);
    const sat = lines.get(recs[5]!.id)!;
    expect([sat.overtime, sat.manual, sat.regPay, sat.otPay, sat.pay]).toEqual([4, true, 0, 0, 100]);
    const total = [...lines.values()].reduce((s, l) => s + l.pay, 0);
    expect(total).toBe(pay(recs).total);
  });

  it("works across employees with their own rate, shift and pay type", () => {
    const shifts = [{ id: "d", name: "Day", multiplier: 1 }, { id: "n", name: "Night", multiplier: 1.5 }];
    const recs = [{ ...day("2026-10-19", 8), id: "a", employee_id: "A" }, { ...day("2026-10-19", 8), id: "b", employee_id: "B" }];
    const lines = payByRecord(recs, [{ id: "A", hourly_rate: 20, shift_id: "n" }, { id: "B", hourly_rate: "10", pay_type: "salary" }], shifts, rules);
    expect(lines.get("a")!.pay).toBe(8 * 30);
    expect(lines.get("b")!).toMatchObject({ salary: true, regular: 8, overtime: 0, pay: 400 });
  });
});

describe("salary", () => {
  const salary = (records: PayRecord[], o: Partial<Parameters<typeof employeePay>[1]> = {}) => pay(records, { payType: "salary", ...o });

  it("pays 40 hours a week at the rate whether they work less or more, with no overtime", () => {
    expect(salary([day("2026-10-19", 4)]).total).toBe(800);
    const long = salary([...weekdays.map((d) => day(d, 11)), day("2026-10-24", 6)]);
    expect([long.regular, long.overtime, long.otPay, long.total]).toEqual([61, 0, 0, 800]);
  });

  it("pays each week worked, splits it across days by hours, and scales by shift", () => {
    const recs = [day("2026-10-19", 6), day("2026-10-20", 2), day("2026-10-26", 8)];
    const r = salary(recs, { to: "2026-11-01", shiftMultiplier: 1.5 });
    expect(r.total).toBe(2 * 40 * 30);
    expect(r.lines.map((l) => l.pay)).toEqual([900, 300, 1200]);
    // A day on another shift is paid its share at that shift.
    const covered = salary([day("2026-10-19", 4, { shift_id: "d" }), day("2026-10-20", 4)], { shiftMultiplier: 1.5, shifts: [{ id: "d", name: "Day", multiplier: 1 }] });
    expect(covered.lines.map((l) => l.pay)).toEqual([400, 600]);
  });

  it("counts only the part of a week inside the period, and lets a manual day replace its share", () => {
    // The week (800) by hours: Mon 5/20, Tue 5/20, Wed 10/20. Wed is paid its manual 50 instead of its 400.
    const recs = [day("2026-10-19", 5), day("2026-10-20", 5), day("2026-10-21", 10, { pay_override: 50 })];
    const r = salary(recs, { from: "2026-10-20" });
    expect(r.lines.map((l) => l.pay)).toEqual([200, 50]);
    expect([r.regPay, r.manualPay, r.total]).toEqual([200, 50, 250]);
    const week = salary(recs);
    expect(week.total).toBe(200 + 200 + 50);
  });
});

describe("public holidays", () => {
  const holiday = { ...rules, holidays: { "2026-10-21": 2 } };
  it("pays hours worked on a holiday at its rate, regular and overtime alike", () => {
    // Wed is a ×2 holiday: its 8 regular hours pay ×2; the rest of the week is as usual.
    const r = pay(weekdays.map((d) => day(d, 8)), { rules: holiday });
    expect(r.regPay).toBe(4 * 8 * 20 + 8 * 20 * 2);
    // Overtime on the holiday pays ×2 too (the higher of ×1.5 and ×2), never ×3.
    const late = pay([...weekdays.slice(0, 2).map((d) => day(d, 20)), day("2026-10-21", 8)], { rules: holiday });
    expect([late.regular, late.overtime]).toEqual([40, 8]);
    expect(late.otPay).toBe(8 * 20 * 2);
  });

  it("never stacks: a shift's own rate still wins when it's higher than the holiday's", () => {
    const low = { ...rules, holidays: { "2026-10-21": 1.2 } };
    const r = pay([day("2026-10-21", 8)], { rules: low, shiftMultiplier: 1.3 });
    expect(r.regPay).toBeCloseTo(8 * 20 * 1.3);
    // A ×1 holiday changes nothing.
    expect(pay([day("2026-10-21", 8)], { rules: { ...rules, holidays: { "2026-10-21": 1 } } }).regPay).toBe(160);
  });

  it("leaves manual days, salary weeks and locked days as they were", () => {
    expect(pay([day("2026-10-21", 8, { pay_override: 100 })], { rules: holiday }).total).toBe(100);
    expect(pay([day("2026-10-21", 8)], { rules: holiday, payType: "salary" }).total).toBe(40 * 20);
    const frozen = { regular: 8, overtime: 0, weekend: false, manual: false, salary: false, regPay: 160, otPay: 0, pay: 160 };
    expect(pay([day("2026-10-21", 8, { frozen_pay: frozen })], { rules: holiday }).total).toBe(160);
  });
});
