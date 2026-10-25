import { countRows, type Snapshot, type SnapshotCounts } from "./snapshot";

// Automatic on-device backups, kept in their own IndexedDB database so a
// broken payroll database can't take its backups down with it. They live on
// the same device, though — downloaded backup files and the cloud are what
// survive the browser's storage being cleared.

const DB_NAME = "meridian-payroll-backups";
const STORE = "backups";
/** Oldest backups beyond this are pruned. Pre-sync backups are a few KB each for a typical payroll. */
export const MAX_BACKUPS = 60;

export type BackupReason = "before-pull" | "before-push-cloud-copy" | "before-restore" | "before-import" | "before-import-cloud-copy"
  | "before-bulk-edit" | "before-bulk-edit-cloud-copy" | "before-bulk-delete" | "before-bulk-delete-cloud-copy"
  | "before-record-edit" | "before-record-edit-cloud-copy" | "before-record-delete" | "before-record-delete-cloud-copy" | "automatic" | "manual";
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
  automatic: "Automatic daily backup",
  manual: "Manual backup",
};

export type BackupInfo = { id: number; created_at: string; reason: BackupReason; counts: SnapshotCounts };
type BackupRecord = BackupInfo & { snapshot: Snapshot };

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Could not open backup storage"));
  });
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    // Resolve only once the transaction has committed, so a saved backup is really on disk.
    tx.oncomplete = () => { db.close(); resolve(req ? req.result : (undefined as T)); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error ?? new Error("Backup storage failed")); };
  }));
}

/** Saves a backup and confirms it reads back intact. Throws if it can't — callers must not proceed. */
export async function saveBackup(reason: BackupReason, snapshot: Snapshot): Promise<BackupInfo> {
  const rec = { created_at: new Date().toISOString(), reason, counts: countRows(snapshot), snapshot };
  const id = (await run("readwrite", (s) => s.add(rec))) as number;
  const back = await getBackup(id);
  if (!back || JSON.stringify(back.snapshot) !== JSON.stringify(snapshot)) throw new Error("Backup could not be verified after saving");
  await prune();
  return { id, created_at: rec.created_at, reason, counts: rec.counts };
}

export async function getBackup(id: number): Promise<BackupRecord | undefined> {
  return run("readonly", (s) => s.get(id) as IDBRequest<BackupRecord | undefined>);
}

export async function listBackups(): Promise<BackupInfo[]> {
  const all = await run("readonly", (s) => s.getAll() as IDBRequest<BackupRecord[]>);
  return all.map(({ id, created_at, reason, counts }) => ({ id, created_at, reason, counts })).reverse();
}

/** Drops the oldest backups past MAX_BACKUPS. */
async function prune() {
  const keys = (await run("readonly", (s) => s.getAllKeys())) as number[];
  const extra = keys.length - MAX_BACKUPS;
  if (extra <= 0) return;
  const drop = keys.sort((a, b) => a - b).slice(0, extra);
  await run("readwrite", (s) => { for (const k of drop) s.delete(k); });
}

export function downloadSnapshot(snapshot: Snapshot, name: string) {
  const blob = new Blob([JSON.stringify(snapshot, null, 1)], { type: "application/json" });
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
