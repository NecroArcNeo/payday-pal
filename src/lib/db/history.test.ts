// @vitest-environment node
import { describe, expect, it } from "vitest";
import { memoryDb } from "../../test/sqlite-db";
import { createLocalStore } from "./store";
import { UndoHistory, undoableStore } from "./undo";
import { listHistory, pruneHistory } from "./history";
import { exportSnapshot } from "./snapshot";
import { redactSnapshot } from "./privacy";
import { restoreSnapshot } from "./sync";

async function setup() {
  const db = await memoryDb();
  const undo = new UndoHistory(async () => db);
  const store = undoableStore(createLocalStore(async () => db), undo);
  await store.insert("employees", { employee_code: "E1", first_name: "Ada", last_name: "Lovelace", hourly_rate: 20 });
  await store.insert("employees", { employee_code: "E2", first_name: "Bo", last_name: "Chen", hourly_rate: 18 });
  const people = await store.listEmployees();
  const ada = people.find((e) => e.employee_code === "E1")!;
  const bo = people.find((e) => e.employee_code === "E2")!;
  return { db, undo, store, ada, bo };
}
const labels = async (db: Awaited<ReturnType<typeof memoryDb>>, filter = {}) => (await listHistory(db, filter)).entries.map((e) => `${e.kind}: ${e.label}`);

describe("the edit history", () => {
  it("keeps every change with its rows before and after, newest first", async () => {
    const { db, store, ada } = await setup();
    await store.update("employees", ada.id, { hourly_rate: 22, department: "Kitchen" });
    const { entries, total } = await listHistory(db);
    expect(total).toBe(3);
    expect(entries[0]!.label).toBe("edited an employee");
    const change = entries[0]!.changes.find((c) => c.tbl === "employees")!;
    expect([change.old!["hourly_rate"], change.new!["hourly_rate"], change.new!["department"]]).toEqual([20, 22, "Kitchen"]);
    // The rate history the trigger wrote is part of the same entry.
    expect(entries[0]!.changes.some((c) => c.tbl === "pay_rates")).toBe(true);
  });

  it("finds an employee's own entries, including their records, and a single record's", async () => {
    const { db, store, ada, bo } = await setup();
    await store.insert("time_records", { employee_id: ada.id, work_date: "2026-10-19", entry_mode: "hours", hours: 6 });
    await store.insert("time_records", { employee_id: bo.id, work_date: "2026-10-19", entry_mode: "hours", hours: 7 });
    const rec = (await store.listRecords()).find((r) => r.employee_id === ada.id)!;
    await store.update("time_records", rec.id, { note: "late" });
    expect(await labels(db, { employeeId: ada.id })).toEqual(["edit: edited a record", "edit: added a record", "edit: added an employee"]);
    expect(await labels(db, { rowId: rec.id })).toEqual(["edit: edited a record", "edit: added a record"]);
    expect(await labels(db, { text: "late" })).toEqual(["edit: edited a record"]);
  });

  it("adds undo and redo as entries of their own, written the way they were applied", async () => {
    const { db, undo, store, ada } = await setup();
    await store.update("employees", ada.id, { department: "Bar" });
    await undo.undo();
    await undo.redo();
    const { entries } = await listHistory(db, { kinds: ["undo", "redo"] });
    expect(entries.map((e) => e.kind)).toEqual(["redo", "undo"]);
    const undone = entries[1]!.changes.find((c) => c.tbl === "employees")!;
    expect([undone.old!["department"], undone.new!["department"]]).toEqual(["Bar", null]);
  });

  it("never sends history to the cloud, but local backups carry it and a restore keeps both devices' entries once", async () => {
    const { db, store, ada } = await setup();
    await store.update("employees", ada.id, { notes: "private note" });
    const backup = await exportSnapshot(db);
    expect(backup.history).toHaveLength(3);
    expect(redactSnapshot(backup, []).history).toBeUndefined();
    expect(JSON.stringify(redactSnapshot(backup, ["notes"]))).not.toContain("private note");

    const other = await memoryDb();
    const otherStore = createLocalStore(async () => other);
    await otherStore.insert("shifts", { name: "Late", multiplier: 1.2, sort_order: 2 });
    await restoreSnapshot(other, backup, async () => ({}), { from: "the backup file" });
    await restoreSnapshot(other, backup, async () => ({}), { from: "the backup file" }); // again: nothing doubled
    const all = await listHistory(other);
    expect(all.entries.filter((e) => e.kind === "edit")).toHaveLength(3);
    expect(all.entries[0]!.label).toMatch(/^restored the backup file \(2 employees/);
  });

  it("trims entries older than the days kept, and keeps everything by default", async () => {
    const { db } = await setup();
    await db.query("update _history set at = '2020-01-01T00:00:00.000Z' where label = 'added an employee' and rowid = (select min(rowid) from _history)");
    expect(await pruneHistory(db, null)).toBe(0);
    expect(await pruneHistory(db, 365)).toBe(1);
    expect((await listHistory(db)).total).toBe(1);
  });
});
