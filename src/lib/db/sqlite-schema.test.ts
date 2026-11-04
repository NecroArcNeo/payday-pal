// @vitest-environment node
import { describe, expect, it } from "vitest";
// @ts-expect-error: the Electron main process's plain-JS module
import { openDatabase, runQuery } from "../../../electron/database.mjs";
import { COLUMNS, decodeRow, encodeRow, encodeValue, roundDecimal } from "./codec";
import { TABLES } from "./schema";
import { SQLITE_SCHEMA } from "./sqlite-schema";

type Db = { prepare(sql: string): { get(...a: unknown[]): any; all(...a: unknown[]): any[]; run(...a: unknown[]): unknown }; exec(sql: string): void };
const fresh = () => {
  const { db, endTransaction } = openDatabase(":memory:") as { db: Db; endTransaction: () => void };
  db.exec(SQLITE_SCHEMA);
  return { db, endTransaction, q: (sql: string, ...p: unknown[]) => runQuery(db, sql, p).rows as any[] };
};
const EMP = "e1";
const withEmployee = () => {
  const t = fresh();
  t.q("insert into employees (id, employee_code, first_name, last_name, hourly_rate) values (?, 'A1', 'Ann', 'Lee', 20)", EMP);
  return t;
};
const addClock = (t: ReturnType<typeof fresh>, id: string, day: string, cin: string, cout: string, lunch = 0) =>
  t.q("insert into time_records (id, employee_id, work_date, entry_mode, clock_in, clock_out, lunch_minutes) values (?, ?, ?, 'clock', ?, ?, ?)", id, EMP, day, cin, cout, lunch);
const hoursOf = (t: ReturnType<typeof fresh>, id: string) => t.q("select hours from time_records where id = ?", id)[0].hours;

describe("the SQLite schema", () => {
  it("has exactly the columns codec.ts describes, in order", () => {
    const { q } = fresh();
    for (const t of TABLES) {
      expect(q(`select name from pragma_table_info('${t}') order by cid`).map((r) => r.name), t).toEqual(COLUMNS[t].map((c) => c.name));
    }
  });

  it("works out clock hours like the cloud: overnight, break, rounded half up to the cent", () => {
    const t = withEmployee();
    addClock(t, "r1", "2026-10-26", "09:00:00", "17:00:00", 30);
    addClock(t, "r2", "2026-10-27", "22:00:00", "06:00:00", 0);
    addClock(t, "r3", "2026-10-28", "09:00:00", "09:09:00", 0); // 0.15 h: exact, not 0.14 from binary rounding
    addClock(t, "r4", "2026-10-29", "09:00:00", "09:00:00", 0);
    expect(["r1", "r2", "r3", "r4"].map((id) => hoursOf(t, id))).toEqual([7.5, 8, 0.15, 0]);
    t.q("update time_records set clock_out = '18:00:00' where id = 'r1'");
    expect(hoursOf(t, "r1")).toBe(8.5);
    expect(() => t.q("insert into time_records (employee_id, work_date, entry_mode, clock_in) values (?, '2026-10-30', 'clock', '09:00:00')", EMP)).toThrow("Clock in and clock out are required");
    expect(() => addClock(t, "r5", "2026-10-30", "09:00:00", "10:00:00", 90)).toThrow("Lunch break longer than shift");
  });

  it("drops an hours record's times", () => {
    const t = withEmployee();
    t.q("insert into time_records (id, employee_id, work_date, entry_mode, clock_in, lunch_minutes, hours) values ('h', ?, '2026-10-26', 'hours', '09:00:00', 30, 6)", EMP);
    expect(t.q("select clock_in, lunch_minutes, hours from time_records")).toEqual([{ clock_in: null, lunch_minutes: 0, hours: 6 }]);
  });

  it("refuses dates, times and flags that aren't valid", () => {
    const t = withEmployee();
    expect(() => addClock(t, "x", "2026-02-30", "09:00:00", "17:00:00")).toThrow(/CHECK/);
    expect(() => addClock(t, "x", "2026-10-26", "25:00:00", "17:00:00")).toThrow(/CHECK/);
    expect(() => t.q("update time_records set unlocked = 2")).not.toThrow(); // no rows yet
    addClock(t, "ok", "2026-10-26", "09:00:00", "17:00:00");
    expect(() => t.q("update time_records set unlocked = 2")).toThrow(/CHECK/);
  });

  it("locks paid days, with the same exceptions as before", () => {
    const t = withEmployee();
    addClock(t, "old", "2026-10-30", "09:00:00", "17:00:00");
    t.q("insert into payroll_settings (id, locked_through) values (1, '2026-11-01')");
    const msg = "Days up to Sun 2026-11-01 are locked as paid. Unlock them on the Payroll or Time records page to change them.";
    expect(() => addClock(t, "new", "2026-10-31", "09:00:00", "17:00:00")).toThrow(msg);
    expect(() => t.q("update time_records set note = 'x' where id = 'old'")).toThrow(msg);
    expect(() => t.q("update time_records set work_date = '2026-11-05' where id = 'old'")).toThrow(msg);
    expect(() => t.q("delete from time_records where id = 'old'")).toThrow(msg);
    // Switching the flag and saving frozen pay are always allowed; an unlocked record can change.
    t.q(`update time_records set frozen_pay = '{"pay":1}' where id = 'old'`);
    t.q("update time_records set unlocked = 1 where id = 'old'");
    t.q("update time_records set note = 'fixed' where id = 'old'");
    addClock(t, "later", "2026-11-02", "09:00:00", "17:00:00");
    expect(() => t.q("update time_records set work_date = '2026-10-31' where id = 'later'")).toThrow(msg);
    // The bypass (restores, the rate trigger) lets anything through, and ends with the transaction.
    t.q("select meridian_set('bypass_lock', 'on')");
    addClock(t, "bypassed", "2026-10-31", "09:00:00", "17:00:00");
    t.endTransaction();
    expect(() => t.q("delete from time_records where id = 'bypassed'")).toThrow(msg);
    t.q("insert into pay_adjustments (employee_id, pay_date, category, amount) values (?, '2026-11-02', 'Bonus', 5)", EMP);
    expect(() => t.q("insert into pay_adjustments (employee_id, pay_date, category, amount) values (?, '2026-11-01', 'Bonus', 5)", EMP)).toThrow(msg);
  });

  it("keeps rate history when a rate changes, except while undo replays", () => {
    const t = withEmployee();
    t.q("update employees set hourly_rate = 25 where id = ?", EMP);
    const today = t.q("select date('now', 'localtime') d")[0].d;
    expect(t.q("select effective_from, hourly_rate from pay_rates order by effective_from")).toEqual([
      { effective_from: "0001-01-01", hourly_rate: 20 }, { effective_from: today, hourly_rate: 25 },
    ]);
    t.q("update employees set hourly_rate = 26 where id = ?", EMP); // same day: the entry is updated, not added
    expect(t.q("select count(*) n, max(hourly_rate) r from pay_rates")[0]).toEqual({ n: 2, r: 26 });
    t.q("select meridian_set('replaying', 'on')");
    t.q("update employees set hourly_rate = 30 where id = ?", EMP);
    expect(t.q("select max(hourly_rate) r from pay_rates")[0].r).toBe(26);
  });

  it("lets the first rate change keep the old rate since the start even with days locked", () => {
    const t = withEmployee();
    t.q("insert into payroll_settings (id, locked_through) values (1, '2026-11-01')");
    t.q("update employees set hourly_rate = 25 where id = ?", EMP);
    expect(t.q("select count(*) n from pay_rates")[0].n).toBe(2);
    const msg = /locked as paid, so their pay rate can't change/;
    expect(() => t.q("insert into pay_rates (employee_id, effective_from, hourly_rate) values (?, '2026-10-01', 22)", EMP)).toThrow(msg);
    expect(() => t.q("delete from pay_rates where effective_from = '0001-01-01'")).toThrow(msg);
  });

  it("bumps the change counter on every write", () => {
    const t = withEmployee();
    const seq = () => Number(t.q("select value from _meta where key = 'change_seq'")[0].value);
    const before = seq();
    t.q("update employees set first_name = 'Anne'");
    t.q("delete from shifts where name = 'Night'");
    expect(seq()).toBe(before + 2);
  });

  it("logs every column before and after while undo is listening", () => {
    const t = withEmployee();
    t.q("update employees set first_name = 'Anne'");
    expect(t.q("select count(*) n from _undo_log")[0].n).toBe(0);
    t.q("select meridian_set('undo_log', 'on')");
    t.q("update employees set first_name = 'Ann', custom_fields = '{\"x\":1}' where id = ?", EMP);
    const [log] = t.q("select tbl, op, old, new from _undo_log");
    expect([log.tbl, log.op]).toEqual(["employees", "UPDATE"]);
    const after = decodeRow("employees", JSON.parse(log.new));
    expect(Object.keys(after)).toEqual(COLUMNS.employees.map((c) => c.name));
    expect(after).toMatchObject({ first_name: "Ann", active: true, custom_fields: { x: 1 }, hourly_rate: 20 });
    expect(decodeRow("employees", JSON.parse(log.old))).toMatchObject({ first_name: "Anne" });
  });

  it("deletes an employee's records with them, and moves a deleted shift's days back to the employee's", () => {
    const t = withEmployee();
    const day = t.q("select id from shifts where name = 'Day'")[0].id;
    addClock(t, "r", "2026-10-26", "09:00:00", "17:00:00");
    t.q("update time_records set shift_id = ?", day);
    t.q("delete from shifts where id = ?", day);
    expect(t.q("select shift_id from time_records")[0].shift_id).toBeNull();
    t.q("delete from employees");
    expect(t.q("select count(*) n from time_records")[0].n).toBe(0);
  });

  it("starts with the Day and Night shifts and a uuid for rows without an id", () => {
    const { q } = fresh();
    expect(q("select name from shifts order by sort_order").map((r) => r.name)).toEqual(["Day", "Night"]);
    expect(q("select id from shifts")[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("encoding values for SQLite", () => {
  it("rounds money on the decimal digits, half away from zero, as Postgres' numeric did", () => {
    expect([2.675, -2.675, 1.005, 0.1 + 0.2, 1e-7, 25].map((n) => roundDecimal(n, 2))).toEqual([2.68, -2.68, 1.01, 0.3, 0, 25]);
  });

  it("stores dates, times, flags and JSON in one form, and reads them back as the app expects", () => {
    const row = encodeRow("time_records", { id: "x", clock_in: "8:00", clock_out: "17:30:15", unlocked: true, hours: "7.456", frozen_pay: { pay: 1 }, nope: 1 });
    expect(row).toEqual({ id: "x", clock_in: "08:00:00", clock_out: "17:30:15", unlocked: 1, hours: 7.46, frozen_pay: '{"pay":1}' });
    expect(decodeRow("time_records", { unlocked: 0, frozen_pay: '{"pay":1}', alias: 3 })).toEqual({ unlocked: false, frozen_pay: { pay: 1 }, alias: 3 });
    const created = COLUMNS.time_records.find((c) => c.name === "created_at")!;
    expect(encodeValue(created, "2026-11-03 12:00:00.123+00")).toBe("2026-11-03T12:00:00.123Z");
    expect(encodeValue(created, "2026-11-03T07:00:00-05:00")).toBe("2026-11-03T12:00:00.000Z");
  });

  it("refuses values a column can't hold", () => {
    const hours = COLUMNS.time_records.find((c) => c.name === "hours")!;
    const lunch = COLUMNS.time_records.find((c) => c.name === "lunch_minutes")!;
    expect(() => encodeValue(hours, "abc")).toThrow("isn't a number");
    expect(() => encodeValue(hours, "")).toThrow("isn't a number");
    expect(() => encodeValue(lunch, 1.5)).toThrow("whole number");
  });
});
