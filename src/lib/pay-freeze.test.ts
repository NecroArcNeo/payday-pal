// @vitest-environment node
import { PGlite, types } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { migrate } from "./db/local";
import { createLocalStore } from "./db/store";
import { UndoHistory, undoableStore } from "./db/undo";
import { payByRecord } from "./pay";
import type { RateEntry } from "./pay-rates";
import { lockThrough, setRecordsLocked } from "./pay-freeze";

const parsers = { [types.NUMERIC]: (v: string) => Number(v), [types.DATE]: (v: string) => v, [types.TIMESTAMPTZ]: (v: string) => v };

async function setup() {
  const db = new PGlite({ parsers });
  await migrate(db);
  const history = new UndoHistory(async () => db);
  const store = undoableStore(createLocalStore(async () => db), history);
  await store.insert("employees", { employee_code: "E1", first_name: "Ada", last_name: "Lovelace", hourly_rate: 20 });
  const emp = (await store.listEmployees())[0]!;
  // Mon Oct 19 and Tue Oct 20: 10 hours each, so with a 16-hour week threshold Tuesday has overtime.
  await store.insert("time_records", [
    { employee_id: emp.id, work_date: "2026-10-19", entry_mode: "hours", hours: 10 },
    { employee_id: emp.id, work_date: "2026-10-20", entry_mode: "hours", hours: 10 },
  ]);
  await store.saveSettings({ ot_threshold: 16, ot_multiplier: 1.5, weekend_overtime: true, visible_columns: [] });
  /** Each day's pay as the Payroll page works it out now. */
  const pay = async () => {
    const [records, employees, shifts, settings, history] = await Promise.all([store.listRecordsMatching({}), store.listEmployees(), store.listShifts(), store.getSettings(), store.listPayRates()]);
    const rates = new Map<string, RateEntry[]>();
    for (const r of history) rates.set(r.employee_id, [...(rates.get(r.employee_id) ?? []), r]);
    const lines = payByRecord(records, employees, shifts, { threshold: Number(settings!.ot_threshold), otMultiplier: Number(settings!.ot_multiplier), weekendOvertime: settings!.weekend_overtime }, rates);
    return Object.fromEntries(records.map((r) => [r.work_date.slice(5), lines.get(r.id)!.pay]));
  };
  const changeRules = () => store.saveSettings({ ot_threshold: 16, ot_multiplier: 2, weekend_overtime: true, visible_columns: [] });
  return { db, history, store, emp, pay, changeRules };
}

describe("locked days keep their pay", () => {
  it("doesn't change a locked day when the rules change, until it's unlocked; undoing the unlock brings the old pay back", async () => {
    const { history, store, pay, changeRules } = await setup();
    // Monday 10 h regular = 200; Tuesday 6 h regular + 4 h overtime at 1.5 = 120 + 120.
    expect(await pay()).toEqual({ "10-19": 200, "10-20": 240 });
    expect((await lockThrough(store, "2026-10-20")).error).toBeNull();
    await changeRules();
    expect(await pay()).toEqual({ "10-19": 200, "10-20": 240 });

    // Unlocking everything applies the new rules (overtime at ×2)…
    await lockThrough(store, null);
    expect(await pay()).toEqual({ "10-19": 200, "10-20": 280 });
    // …and undoing it brings back the lock and the pay as it was locked.
    expect(await history.undo()).toBe("unlocked every day");
    expect(await pay()).toEqual({ "10-19": 200, "10-20": 240 });
    expect((await store.getSettings())!.locked_through).toBe("2026-10-20");
    expect(await history.redo()).toBe("unlocked every day");
    expect(await pay()).toEqual({ "10-19": 200, "10-20": 280 });

    // Locking again saves the pay under the new rules.
    await lockThrough(store, "2026-10-20");
    await store.saveSettings({ ot_threshold: 16, ot_multiplier: 3, weekend_overtime: true, visible_columns: [] });
    expect(await pay()).toEqual({ "10-19": 200, "10-20": 280 });
  });

  it("keeps a locked day's pay through rate and shift-multiplier changes", async () => {
    const { store, emp, pay } = await setup();
    await lockThrough(store, "2026-10-19");
    // A raise dated before the lock is refused anyway; a plain rate change (starting today) and a shift multiplier change aren't.
    await store.update("employees", emp.id, { hourly_rate: 30 });
    const [day] = await store.listShifts();
    await store.update("shifts", day!.id, { multiplier: 2 });
    const now = await pay();
    expect(now["10-19"]).toBe(200);
    // Tuesday isn't locked: it follows the new multiplier (rate 20 still applies before today's raise).
    expect(now["10-20"]).toBe(6 * 20 * 2 + 4 * 20 * 1.5);
  });

  it("moving the lock earlier pays the days it no longer covers by the current rules", async () => {
    const { store, pay, changeRules } = await setup();
    await lockThrough(store, "2026-10-20");
    await changeRules();
    await lockThrough(store, "2026-10-19");
    expect(await pay()).toEqual({ "10-19": 200, "10-20": 280 });
  });

  it("unlocks single records to the current rules, locks them again with today's figures, and undoes either", async () => {
    const { history, store, pay, changeRules } = await setup();
    await lockThrough(store, "2026-10-20");
    await changeRules();
    const tuesday = (await store.listRecordsMatching({ from: "2026-10-20" }))[0]!;
    await setRecordsLocked(store, [tuesday], false);
    expect(await pay()).toEqual({ "10-19": 200, "10-20": 280 });
    await history.undo();
    expect(await pay()).toEqual({ "10-19": 200, "10-20": 240 });
    await history.redo();
    // Locked again: saved at today's rules, and the multiplier changing again doesn't move it.
    await setRecordsLocked(store, (await store.listRecordsMatching({ from: "2026-10-20" })), true);
    await store.saveSettings({ ot_threshold: 16, ot_multiplier: 3, weekend_overtime: true, visible_columns: [] });
    expect(await pay()).toEqual({ "10-19": 200, "10-20": 280 });
    // Undoing a lock takes its saved pay away again.
    await store.saveSettings({ ot_threshold: 16, ot_multiplier: 2, weekend_overtime: true, visible_columns: [] });
    await history.undo(); // the multiplier change
    await history.undo(); // the multiplier change to 3
    await history.undo(); // locking Tuesday again
    expect((await store.listRecordsMatching({ from: "2026-10-20" }))[0]!.frozen_pay).toBeNull();
  });
});
