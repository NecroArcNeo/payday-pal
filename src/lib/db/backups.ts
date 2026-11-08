import { desktop, type DesktopBridge } from "../desktop";
import { backupsToDrop } from "./retention";
import { countRows, type Snapshot, type SnapshotCounts } from "./snapshot";

// Automatic on-device backups, kept apart from the payroll database so a
// broken database can't take its backups down with it: JSON files in
// %APPDATA%\KoPayroll\Backups (electron/main.mjs), sealed with the data key and
// flushed to disk before they count as saved. They hold private fields, so they
// stay out of folders OneDrive may sync.

export type BackupReason = "before-pull" | "before-push-cloud-copy" | "before-restore" | "before-import" | "before-import-cloud-copy"
  | "before-bulk-edit" | "before-bulk-edit-cloud-copy" | "before-bulk-delete" | "before-bulk-delete-cloud-copy"
  | "before-record-edit" | "before-record-edit-cloud-copy" | "before-record-delete" | "before-record-delete-cloud-copy"
  | "before-copy-week" | "before-copy-week-cloud-copy" | "before-pay-run-delete" | "before-pay-run-delete-cloud-copy"
  | "before-holiday-pay" | "before-holiday-pay-cloud-copy" | "before-fill-weeks" | "before-fill-weeks-cloud-copy" | "before-update" | "automatic" | "manual";
export const reasonLabel: Record<BackupReason, string> = {
  "before-pull": "This device, before pulling from cloud",
  "before-push-cloud-copy": "Cloud copy, before pushing over it",
  "before-restore": "This device, before restoring a backup",
  "before-import": "This device, before a file import",
  "before-import-cloud-copy": "Cloud copy, before a file import",
  "before-bulk-edit": "This device, before editing several employees",
  "before-bulk-edit-cloud-copy": "Cloud copy, before editing several employees",
  "before-bulk-delete": "This device, before deleting several employees",
  "before-bulk-delete-cloud-copy": "Cloud copy, before deleting several employees",
  "before-record-edit": "This device, before editing several time records",
  "before-record-edit-cloud-copy": "Cloud copy, before editing several time records",
  "before-record-delete": "This device, before deleting several time records",
  "before-record-delete-cloud-copy": "Cloud copy, before deleting several time records",
  "before-copy-week": "This device, before copying a week's shifts",
  "before-copy-week-cloud-copy": "Cloud copy, before copying a week's shifts",
  "before-pay-run-delete": "This device, before deleting a pay run",
  "before-pay-run-delete-cloud-copy": "Cloud copy, before deleting a pay run",
  "before-holiday-pay": "This device, before adding holiday pay",
  "before-holiday-pay-cloud-copy": "Cloud copy, before adding holiday pay",
  "before-fill-weeks": "This device, before filling weeks from patterns",
  "before-fill-weeks-cloud-copy": "Cloud copy, before filling weeks from patterns",
  "before-update": "This device, before an app update changed how data is stored",
  automatic: "Automatic backup",
  manual: "Saved by you (kept until you delete it)",
};

export type BackupInfo = { id: number; created_at: string; reason: BackupReason; counts: SnapshotCounts };
type BackupRecord = BackupInfo & { snapshot: Snapshot };

/** The desktop app's backup folder; there's nowhere else to keep them. */
function backups(): DesktopBridge["backups"] {
  if (!desktop) throw new Error("Backups are kept by the desktop app");
  return desktop.backups;
}

/** Saves a backup and confirms it reads back intact. Throws if it can't — callers must not proceed. */
export async function saveBackup(reason: BackupReason, snapshot: Snapshot): Promise<BackupInfo> {
  const rec = { created_at: new Date().toISOString(), reason, counts: countRows(snapshot), snapshot };
  const id = await backups().add(rec);
  const back = await getBackup(id);
  if (!back || JSON.stringify(back.snapshot) !== JSON.stringify(snapshot)) throw new Error("Backup could not be verified after saving");
  await prune();
  return { id, created_at: rec.created_at, reason, counts: rec.counts };
}

export async function getBackup(id: number): Promise<BackupRecord | undefined> {
  return backups().get<BackupRecord>(id);
}

export async function listBackups(): Promise<BackupInfo[]> {
  return (await backups().list<BackupInfo>()).reverse();
}

/** Thins out older backups (see retention.ts). */
async function prune() {
  const drop = backupsToDrop(await listBackups());
  if (!drop.length) return;
  await backups().remove(drop);
}

/** Saves text as a download. Backup files go through saveBackupFile (src/lib/backup-file.ts), which asks for a password first. */
export function downloadFile(text: string, name: string) {
  downloadBlob(new Blob([text], { type: "application/json" }), name);
}

/** Saves a file through the browser's (or the desktop app's) download. */
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const backupFileName = (when = new Date()) =>
  `payroll-backup-${when.toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
