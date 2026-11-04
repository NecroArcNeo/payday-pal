// @vitest-environment node
import { describe, expect, it } from "vitest";
import { memoryDb } from "../../test/sqlite-db";
import { createLocalStore } from "./store";
import { StaleUndoError, UndoHistory, undoableStore } from "./undo";
import { lockThrough } from "@/lib/pay-freeze";

async function setup() {
  const db = await memoryDb();
  const history = new UndoHistory(async () => db);
  const store = undoableStore(createLocalStore(async () => db), history);
  expect((await store.insert("employees", { employee_code: "E1", first_name: "Ada", last_name: "Lovelace", hourly_rate: 20 })).error).toBeNull();
  const emp = (await store.listEmployees())[0]!;
  expect((await store.insert("time_records", [
    { employee_id: emp.id, work_date: "2026-10-19", entry_mode: "clock", clock_in: "09:00", clock_out: "17:30", lunch_minutes: 30 },
    { employee_id: emp.id, work_date: "2026-10-20", entry_mode: "hours", hours: 6.5 },
  ])).error).toBeNull();
  const order: Record<string, string> = { time_records: "work_date", pay_rates: "effective_from" };
  const all = async (t: string) => (await db.query<Record<string, unknown>>(`select * from ${t} order by ${order[t] ?? "created_at"}, id`)).rows;
  return { db, history, store, emp, all };
}

describe("undo and redo", () => {
  it("undoes and redoes adds, edits and deletes, putting back the very same rows", async () => {
    const { history, store, all } = await setup();
    const before = await all("time_records");
    expect(history.nextUndo).toBe("added 2 records");
    expect(await history.undo()).toBe("added 2 records");
    expect(await all("time_records")).toEqual([]);
    expect(history.nextRedo).toBe("added 2 records");
    expect(await history.redo()).toBe("added 2 records");
    expect(await all("time_records")).toEqual(before);

    const [r] = before;
    await store.update("time_records", r!["id"] as string, { note: "late", clock_out: "18:00" });
    expect((await all("time_records"))[0]!["hours"]).toBe(8.5);
    await history.undo();
    expect(await all("time_records")).toEqual(before);
    await history.redo();
    expect((await all("time_records"))[0]!["note"]).toBe("late");

    await store.removeMany("time_records", before.map((x) => x["id"] as string));
    expect(history.nextUndo).toBe("deleted 2 records");
    await history.undo();
    expect((await all("time_records")).map((x) => x["id"])).toEqual(before.map((x) => x["id"]));
  });

  it("undoes deleting an employee with everything that went with them, and redoes it", async () => {
    const { history, store, emp, all } = await setup();
    await store.update("employees", emp.id, { hourly_rate: 25 });
    const snapshot = { e: await all("employees"), r: await all("time_records"), p: await all("pay_rates") };
    expect(snapshot.p).toHaveLength(2);
    await store.remove("employees", emp.id);
    expect(await all("time_records")).toEqual([]);
    await history.undo();
    expect({ e: await all("employees"), r: await all("time_records"), p: await all("pay_rates") }).toEqual(snapshot);
    await history.redo();
    expect(await all("employees")).toEqual([]);
    expect(await all("pay_rates")).toEqual([]);
  });

  it("undoes deleting a shift, putting its people and records back on it", async () => {
    const { history, store, emp, all } = await setup();
    const [, night] = await store.listShifts();
    const [r] = await all("time_records");
    await store.update("employees", emp.id, { shift_id: night!.id });
    await store.update("time_records", r!["id"] as string, { shift_id: night!.id });
    await store.remove("shifts", night!.id);
    expect((await all("employees"))[0]!["shift_id"]).toBeNull();
    await history.undo();
    expect((await all("employees"))[0]!["shift_id"]).toBe(night!.id);
    expect((await all("time_records"))[0]!["shift_id"]).toBe(night!.id);
    await history.redo();
    expect((await store.listShifts()).map((x) => x.id)).not.toContain(night!.id);
  });

  it("undoes a rate change together with the history it wrote, without writing more", async () => {
    const { history, store, emp, all } = await setup();
    await store.update("employees", emp.id, { hourly_rate: 30 });
    expect((await all("pay_rates")).map((r) => r["hourly_rate"])).toEqual([20, 30]);
    await history.undo();
    expect(await all("pay_rates")).toEqual([]);
    expect((await all("employees"))[0]!["hourly_rate"]).toBe(20);
    await history.redo();
    expect((await all("pay_rates")).map((r) => r["hourly_rate"])).toEqual([20, 30]);
  });

  it("groups writes into one step, and a new change clears what could be redone", async () => {
    const { history, store, emp } = await setup();
    await history.record("saved a profile", async () => {
      await store.insert("pay_rates", { employee_id: emp.id, effective_from: "0001-01-01", hourly_rate: 20 });
      await store.update("employees", emp.id, { hourly_rate: 22, department: "Ops" });
    });
    expect(history.nextUndo).toBe("saved a profile");
    await history.undo();
    expect(history.nextUndo).toBe("added 2 records");
    expect(history.nextRedo).toBe("saved a profile");
    await store.update("employees", emp.id, { department: "Sales" });
    expect(history.nextRedo).toBeNull();
    // A failed write records nothing.
    expect((await store.insert("time_records", { employee_id: emp.id, work_date: "2026-10-21", entry_mode: "clock" })).error).not.toBeNull();
    expect(history.nextUndo).toBe("edited an employee");
  });

  it("refuses to undo over changes made since, and changes nothing", async () => {
    const { db, history, store, all } = await setup();
    const [r] = await all("time_records");
    await store.update("time_records", r!["id"] as string, { note: "one" });
    // Changed outside the history (as a restore or sync would).
    await db.query("update time_records set note = 'two' where id = $1", [r!["id"]]);
    await expect(history.undo()).rejects.toBeInstanceOf(StaleUndoError);
    expect((await all("time_records"))[0]!["note"]).toBe("two");
    expect(history.nextUndo).toBeNull();
  });

  it("obeys the lock: undoing a change on a locked day is refused until it's unlocked", async () => {
    const { db, history, store, emp, all } = await setup();
    await store.insert("pay_adjustments", { employee_id: emp.id, pay_date: "2026-10-19", category: "Bonus", amount: 5 });
    // Locked without going through the history, so the next undo is the bonus.
    await createLocalStore(async () => db).setLockedThrough("2026-10-19");
    await expect(history.undo()).rejects.toThrow(/locked as paid/);
    expect(await all("pay_adjustments")).toHaveLength(1);
    expect(history.nextUndo).toBe("added an extra-pay entry");
    await store.setLockedThrough(null);
    await history.undo(); // the unlock
    await expect(history.undo()).rejects.toThrow(/locked/);
  });
});

describe("records unlocked one by one (schema 11)", () => {
  it("lets an unlocked record on a locked day change, until the lock moves", async () => {
    const { history, store, emp, all } = await setup();
    await store.setLockedThrough("2026-10-20");
    const [oct19, oct20] = await all("time_records");
    const id = oct19!["id"] as string;
    expect((await store.update("time_records", id, { note: "x" })).error?.message).toMatch(/locked as paid/);
    expect((await store.setRecordsUnlocked([id], true)).error).toBeNull();
    expect(await store.countUnlockedRecords()).toBe(1);
    expect((await store.update("time_records", id, { note: "fixed" })).error).toBeNull();
    // Only that one: its neighbour and new records on locked days stay refused.
    expect((await store.update("time_records", oct20!["id"] as string, { note: "x" })).error?.message).toMatch(/locked/);
    expect((await store.insert("time_records", { employee_id: emp.id, work_date: "2026-10-18", entry_mode: "hours", hours: 1 })).error?.message).toMatch(/locked/);
    // Locking it again by hand, or moving the lock, locks it.
    expect((await store.setRecordsUnlocked([id], false)).error).toBeNull();
    expect((await store.update("time_records", id, { note: "x" })).error?.message).toMatch(/locked/);
    await store.setRecordsUnlocked([id], true);
    await store.setLockedThrough("2026-10-25");
    expect(await store.countUnlockedRecords()).toBe(0);
    expect((await store.remove("time_records", id)).error?.message).toMatch(/locked/);
    // Undo brings the unlock back with the old lock date, and deleting it then works; undoing that puts it back.
    await history.undo();
    expect(await store.countUnlockedRecords()).toBe(1);
    expect((await store.remove("time_records", id)).error).toBeNull();
    await history.undo();
    expect((await all("time_records")).map((r) => r["id"])).toContain(id);
  });
});

describe("undo with days locked as paid", () => {
  it("undoes and redoes a first rate change made after a lock", async () => {
    const { history, store, emp, all } = await setup();
    await lockThrough(store, "2026-09-30");
    expect((await store.update("employees", emp.id, { hourly_rate: 25 })).error).toBeNull();
    expect(await all("pay_rates")).toHaveLength(2);
    await history.undo();
    expect(await all("pay_rates")).toEqual([]);
    expect((await store.listEmployees())[0]!.hourly_rate).toBe(20);
    await history.redo();
    expect(await all("pay_rates")).toHaveLength(2);
    expect((await store.listEmployees())[0]!.hourly_rate).toBe(25);
  });

  it("deletes an employee with rate history but no locked records, and undoes it", async () => {
    const { history, store } = await setup();
    await store.insert("employees", { employee_code: "E2", first_name: "Bo", last_name: "Ng", hourly_rate: 18 });
    const bo = (await store.listEmployees()).find((e) => e.employee_code === "E2")!;
    await store.update("employees", bo.id, { hourly_rate: 19 });
    await lockThrough(store, "2026-12-31");
    expect((await store.remove("employees", bo.id)).error).toBeNull();
    await history.undo();
    expect((await store.listEmployees()).find((e) => e.id === bo.id)?.hourly_rate).toBe(19);
  });

  it("still refuses to delete an employee whose records are locked", async () => {
    const { store, emp } = await setup();
    await lockThrough(store, "2026-10-31");
    expect((await store.remove("employees", emp.id)).error?.message).toMatch(/locked as paid/);
  });
});
