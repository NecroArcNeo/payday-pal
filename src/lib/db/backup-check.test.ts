// @vitest-environment node
import { describe, expect, it } from "vitest";
import { memoryDb, rawMemoryDb } from "../../test/sqlite-db";
import { createLocalStore } from "./store";
import { exportSnapshot, type Snapshot } from "./snapshot";
import { checkDue, CHECK_EVERY_MS, restoreCheck, type BackupCheck } from "./backup-check";

async function backup(): Promise<Snapshot> {
  const db = await memoryDb();
  const store = createLocalStore(async () => db);
  await store.insert("employees", { employee_code: "E1", first_name: "Ada", last_name: "Lovelace", hourly_rate: 20 });
  const ada = (await store.listEmployees())[0]!;
  await store.insert("time_records", [
    { employee_id: ada.id, work_date: "2026-11-02", entry_mode: "clock", clock_in: "09:00", clock_out: "17:00", lunch_minutes: 30 },
    { employee_id: ada.id, work_date: "2026-11-03", entry_mode: "hours", hours: 6 },
  ]);
  return exportSnapshot(db);
}

describe("checking that a backup restores", () => {
  it("restores a backup into an empty database the way Restore does, and counts its rows", async () => {
    const s = await backup();
    const rows = await restoreCheck(rawMemoryDb(), s);
    expect(rows).toBe(Object.values(s.data).reduce((n, r) => n + r.length, 0));
    expect(rows).toBeGreaterThanOrEqual(3);
  });

  it("fails, saying why, on a backup that wouldn't restore", async () => {
    const s = await backup();
    // A record whose employee isn't in the backup.
    const orphan = { ...s, data: { ...s.data, employees: [] } };
    await expect(restoreCheck(rawMemoryDb(), orphan)).rejects.toThrow();
    const { id: _gone, ...noId } = s.data.time_records[0]!; // a row with no id at all (JSON has no "undefined")
    const broken = { ...s, data: { ...s.data, time_records: [noId] } } as unknown as Snapshot;
    await expect(restoreCheck(rawMemoryDb(), broken)).rejects.toThrow(/no id/);
    await expect(restoreCheck(rawMemoryDb(), { ...s, format: "something else" } as unknown as Snapshot)).rejects.toThrow(/backup header/);
  });

  it("is due once a day, for a backup not checked yet", () => {
    const now = Date.parse("2026-11-06T12:00:00Z");
    const last = (id: number, hoursAgo: number, ok = true): BackupCheck => ({ id, created_at: "", at: new Date(now - hoursAgo * 3600_000).toISOString(), ok, rows: 1 });
    expect(checkDue(undefined, null, now)).toBe(false); // no backups yet
    expect(checkDue({ id: 5 }, null, now)).toBe(true); // never checked
    expect(checkDue({ id: 5 }, last(5, 48), now)).toBe(false); // already checked that one
    expect(checkDue({ id: 6 }, last(5, 3), now)).toBe(false); // checked today
    expect(checkDue({ id: 6 }, last(5, CHECK_EVERY_MS / 3600_000), now)).toBe(true); // a day later
    expect(checkDue({ id: 6 }, last(5, 1, false), now)).toBe(true); // the last one failed: check the next at once
  });
});
