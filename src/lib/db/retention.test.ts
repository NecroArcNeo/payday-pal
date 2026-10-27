import { describe, expect, it } from "vitest";
import { backupsToDrop } from "./retention";

const now = new Date(2026, 9, 27, 12, 0).getTime(); // Tue 27 Oct 2026, local time
const HOUR = 3_600_000;
let nextId = 1;
const at = (hoursAgo: number, reason = "automatic") => ({ id: nextId++, created_at: new Date(now - hoursAgo * HOUR).toISOString(), reason });

describe("backup retention", () => {
  it("keeps everything from the last two days", () => {
    const recent = [at(0.5), at(1), at(1.5), at(30), at(47)];
    expect(backupsToDrop(recent, now)).toEqual([]);
  });

  it("keeps the newest backup of each day for 30 days", () => {
    const morning = at(24 * 5 + 6); // 22 Oct, 06:00
    const evening = at(24 * 5 - 6); // 22 Oct, 18:00
    const otherDay = at(24 * 6);
    expect(backupsToDrop([morning, evening, otherDay], now)).toEqual([morning.id]);
  });

  it("keeps the newest of each week for a year, then the newest of each month", () => {
    const wedOld = { id: nextId++, created_at: new Date(2026, 7, 5, 12).toISOString(), reason: "automatic" }; // Wed 5 Aug
    const friOld = { id: nextId++, created_at: new Date(2026, 7, 7, 12).toISOString(), reason: "automatic" }; // Fri 7 Aug, same week
    const nextWeek = { id: nextId++, created_at: new Date(2026, 7, 10, 12).toISOString(), reason: "automatic" }; // Mon 10 Aug
    const jan2025a = { id: nextId++, created_at: new Date(2025, 0, 3, 12).toISOString(), reason: "automatic" };
    const jan2025b = { id: nextId++, created_at: new Date(2025, 0, 29, 12).toISOString(), reason: "before-pull" };
    expect(backupsToDrop([wedOld, friOld, nextWeek, jan2025a, jan2025b], now).sort()).toEqual([wedOld.id, jan2025a.id].sort());
  });

  it("never deletes manual backups", () => {
    const old = [at(24 * 400, "manual"), at(24 * 400 + 1, "manual"), at(24 * 10, "manual"), at(24 * 10 + 1, "manual")];
    expect(backupsToDrop(old, now)).toEqual([]);
  });

  it("keeps a backup whose date can't be read", () => {
    expect(backupsToDrop([{ id: 99, created_at: "garbage", reason: "automatic" }, at(24 * 3)], now)).toEqual([]);
  });
});
