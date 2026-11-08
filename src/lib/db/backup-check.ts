// Checking that backups really restore: once a day, the newest automatic backup is restored into a scratch database
// (in memory, in a worker thread: electron/scratch-db.mjs), the way Restore would do it (the same migrate and
// replaceWithSnapshot, whose own count check fails on any missing row), then SQLite checks the result (integrity and
// foreign keys). The real data is never touched. A failure is said at once and shown on Sync & backup, so a backup
// that wouldn't restore is found long before it's needed.
import { bridgeDb, migrate, type LocalDb } from "./local";
import { getBackup, listBackups, type BackupInfo } from "./backups";
import { replaceWithSnapshot, type Snapshot } from "./snapshot";
import { desktop, type DesktopBridge } from "@/lib/desktop";
import { getPref, setPref } from "@/lib/prefs";

export const BACKUP_CHECK = "meridian-backup-check";
/** The last check: which backup, when, and how it went. */
export type BackupCheck = { id: number; created_at: string; at: string; ok: boolean; rows: number; error?: string };
/** At most one check a day. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * Restores `snapshot` into `db` (a new, empty database) as Restore would, then checks the result. Returns how many
 * rows were restored; throws, saying what's wrong, when the backup doesn't restore cleanly.
 */
export async function restoreCheck(db: LocalDb, snapshot: Snapshot): Promise<number> {
  await migrate(db);
  await replaceWithSnapshot(db, snapshot);
  const integrity = (await db.query<Record<string, string>>("pragma integrity_check")).rows.map((r) => Object.values(r)[0]);
  if (integrity.join() !== "ok") throw new Error(`the restored database is damaged (${integrity.slice(0, 3).join("; ")})`);
  const orphans = (await db.query<{ table: string }>("pragma foreign_key_check")).rows;
  if (orphans.length) throw new Error(`${orphans.length} restored row${orphans.length === 1 ? "" : "s"} point to rows that aren't there (${[...new Set(orphans.map((o) => o.table))].join(", ")})`);
  return Object.values(snapshot.data).reduce((n, rows) => n + rows.length, 0);
}

/** Whether a check is due: there's a backup not checked yet, and the last check was a day ago or more. */
export function checkDue(newest: Pick<BackupInfo, "id"> | undefined, last: BackupCheck | null, now: number): boolean {
  if (!newest) return false;
  if (!last) return true;
  if (last.id === newest.id) return false;
  return now - Date.parse(last.at) >= CHECK_EVERY_MS || !last.ok;
}

export const lastBackupCheck = () => getPref<BackupCheck | null>(BACKUP_CHECK, null);

let running: Promise<BackupCheck | null> | null = null;

/**
 * Checks the newest backup when one is due (or `force`). Returns the result, or null when nothing was checked.
 * One at a time; the scratch database is always closed afterwards, freeing its memory.
 */
export function checkNewestBackup(force = false): Promise<BackupCheck | null> {
  running ??= (async () => {
    if (!desktop) return null;
    const newest = (await listBackups())[0];
    if (!newest || (!force && !checkDue(newest, lastBackupCheck(), Date.now()))) return null;
    const bridge = desktop;
    let result: BackupCheck;
    try {
      await bridge.scratch.open();
      const record = await getBackup(newest.id);
      if (!record) throw new Error("the backup couldn't be read");
      const db = bridgeDb({ db: bridge.scratch } as unknown as DesktopBridge);
      const rows = await restoreCheck(db, record.snapshot);
      result = { id: newest.id, created_at: newest.created_at, at: new Date().toISOString(), ok: true, rows };
    } catch (e) {
      result = { id: newest.id, created_at: newest.created_at, at: new Date().toISOString(), ok: false, rows: 0, error: (e as Error).message };
    } finally {
      await bridge.scratch.close().catch(() => {});
    }
    setPref(BACKUP_CHECK, result);
    return result;
  })().finally(() => { running = null; });
  return running;
}
