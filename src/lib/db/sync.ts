import { supabase } from "@/integrations/supabase/client";
import type { BackupReason } from "./backups";
import { changeSeq, getMeta, setMeta } from "./local";
import { getPrivateFields, keepPrivate, redactSnapshot, savePrivateFields } from "./privacy";
import { SCHEMA_VERSION, TABLES } from "./schema";
import { countRows, exportSnapshot, isEmpty, replaceWithSnapshot, validateSnapshot, type Snapshot, type SnapshotCounts, type Sql, type SqlDb } from "./snapshot";

// Push copies this device's whole database to the signed-in account; pull
// copies the account's database onto this device. Neither ever overwrites
// anything without (1) a verified backup of what is about to be replaced and
// (2) the user's confirmation when the other side changed since the last sync.
// Private fields (privacy.ts) are never sent, and pulls keep this device's values for them.

export class SyncConflictError extends Error {
  constructor() { super("The cloud copy changed while syncing. Nothing was overwritten — review and try again."); }
}

export type CloudStatus = { version: number; has_data: boolean; updated_at: string | null; schema_version: number };

/** The three server functions in drizzle/migrations/0003_local_first_sync.sql. */
export interface CloudSync {
  status(): Promise<CloudStatus>;
  pull(): Promise<{ version: number; snapshot: Snapshot }>;
  /** Replaces the cloud copy. Must throw SyncConflictError if the cloud version isn't `expectedVersion`. */
  push(snapshot: Snapshot, expectedVersion: number): Promise<number>;
}

export type SyncDeps = {
  db: SqlDb;
  cloud: CloudSync;
  userId: string;
  backup: (reason: BackupReason, snapshot: Snapshot) => Promise<unknown>;
};

export type PushResult =
  | { kind: "done"; counts: SnapshotCounts }
  | { kind: "confirm"; cloudCounts: SnapshotCounts; cloudUpdatedAt: string | null; neverSynced: boolean };
export type PullResult =
  | { kind: "done"; counts: SnapshotCounts }
  | { kind: "empty" }
  | { kind: "confirm"; localCounts: SnapshotCounts; cloudCounts: SnapshotCounts; neverSynced: boolean };

const META = { seq: "synced_seq", version: "synced_cloud_version", owner: "synced_owner", at: "synced_at" } as const;

export type LocalSyncState = { seq: number; syncedSeq: number | null; syncedVersion: number | null; syncedOwner: string | null; syncedAt: string | null };

export async function localSyncState(sql: Sql): Promise<LocalSyncState> {
  const num = (v: string | null) => (v === null ? null : Number(v));
  return {
    seq: await changeSeq(sql),
    syncedSeq: num(await getMeta(sql, META.seq)),
    syncedVersion: num(await getMeta(sql, META.version)),
    syncedOwner: await getMeta(sql, META.owner),
    syncedAt: await getMeta(sql, META.at),
  };
}

/** True when this device has changes the account hasn't received. */
export function hasUnpushedChanges(st: LocalSyncState, userId: string, localEmpty: boolean) {
  if (st.syncedOwner !== userId) return !localEmpty;
  return st.seq !== st.syncedSeq;
}

async function markSynced(sql: Sql, seq: number, version: number, userId: string) {
  await setMeta(sql, META.seq, String(seq));
  await setMeta(sql, META.version, String(version));
  await setMeta(sql, META.owner, userId);
  await setMeta(sql, META.at, new Date().toISOString());
}

function checkSchema(n: number) {
  if (n !== SCHEMA_VERSION) {
    throw new Error(`The cloud database uses schema ${n} but this app uses ${SCHEMA_VERSION}. Update the ${n > SCHEMA_VERSION ? "app" : "cloud database"} first. Nothing was changed.`);
  }
}

const sameCounts = (a: SnapshotCounts, b: SnapshotCounts) => TABLES.every((t) => a[t] === b[t]);

export async function push({ db, cloud, userId, backup }: SyncDeps, opts: { confirmed?: boolean } = {}): Promise<PushResult> {
  const status = await cloud.status();
  checkSchema(status.schema_version);
  const st = await localSyncState(db);
  const neverSynced = st.syncedOwner !== userId;
  const cloudChanged = status.has_data && (neverSynced || status.version !== st.syncedVersion);

  let expected = status.version;
  if (status.has_data) {
    const remote = await cloud.pull();
    if (cloudChanged && !opts.confirmed) {
      return { kind: "confirm", cloudCounts: countRows(remote.snapshot), cloudUpdatedAt: status.updated_at, neverSynced };
    }
    // Keep the exact cloud copy we're about to replace, and only replace that version.
    await backup("before-push-cloud-copy", validateSnapshot(remote.snapshot));
    expected = remote.version;
  }

  const { snapshot, seq } = await db.transaction(async (tx) => ({
    snapshot: redactSnapshot(await exportSnapshot(tx), await getPrivateFields(tx)),
    seq: await changeSeq(tx),
  }));
  const version = await cloud.push(snapshot, expected);

  // Read it back: the push only counts once the cloud holds exactly what we sent.
  const check = await cloud.pull();
  if (check.version !== version || !sameCounts(countRows(check.snapshot), countRows(snapshot))) {
    throw new Error("The cloud copy didn't match after pushing. Your data on this device is unchanged; the previous cloud copy is in Backups.");
  }
  await markSynced(db, seq, version, userId);
  return { kind: "done", counts: countRows(snapshot) };
}

export async function pull({ db, cloud, userId, backup }: SyncDeps, opts: { confirmed?: boolean } = {}): Promise<PullResult> {
  const remote = await cloud.pull();
  const incoming = validateSnapshot(remote.snapshot);
  if (remote.version === 0 && isEmpty(incoming)) return { kind: "empty" };

  const { snapshot: current, seq } = await db.transaction(async (tx) => ({ snapshot: await exportSnapshot(tx), seq: await changeSeq(tx) }));
  const st = await localSyncState(db);
  const neverSynced = st.syncedOwner !== userId;
  if (hasUnpushedChanges(st, userId, isEmpty(current)) && !opts.confirmed) {
    return { kind: "confirm", localCounts: countRows(current), cloudCounts: countRows(incoming), neverSynced };
  }
  if (!isEmpty(current)) await backup("before-pull", current);

  await replaceWithSnapshot(db, keepPrivate(incoming, current, await getPrivateFields(db)), {
    // Refuse if anything was written after the backup was taken.
    before: async (tx) => { if ((await changeSeq(tx)) !== seq) throw new Error("Data on this device changed during the pull. Nothing was replaced — try again."); },
    after: async (tx) => markSynced(tx, await changeSeq(tx), remote.version, userId),
  });
  return { kind: "done", counts: countRows(incoming) };
}

/**
 * Saves which fields stay on this device. Making more fields private counts as an unpushed change, since the
 * cloud copy still holds their values until the next push replaces it.
 */
export async function setPrivateFields(db: Sql, keys: string[]) {
  const before = await getPrivateFields(db);
  await savePrivateFields(db, keys);
  if (keys.some((k) => !before.includes(k)) && (await getMeta(db, META.seq)) !== null) await setMeta(db, META.seq, "-1");
}

/**
 * Replaces this device's data with a backup, after backing up what's there now. Cloud backups never held
 * private fields, so `keepPrivateFields` keeps this device's values for them.
 */
export async function restoreSnapshot(db: SqlDb, snapshot: Snapshot, backup: SyncDeps["backup"], opts: { keepPrivateFields?: boolean } = {}) {
  const incoming = validateSnapshot(snapshot);
  const { snapshot: current, seq } = await db.transaction(async (tx) => ({ snapshot: await exportSnapshot(tx), seq: await changeSeq(tx) }));
  if (!isEmpty(current)) await backup("before-restore", current);
  await replaceWithSnapshot(db, opts.keepPrivateFields ? keepPrivate(incoming, current, await getPrivateFields(db)) : incoming, {
    before: async (tx) => { if ((await changeSeq(tx)) !== seq) throw new Error("Data changed during the restore. Nothing was replaced — try again."); },
  });
}

const AUTO_BACKUP_EVERY_MS = 12 * 60 * 60 * 1000;

/** Takes a backup when data changed since the last automatic one and it's been 12+ hours. */
export async function maybeAutoBackup(db: SqlDb, backup: SyncDeps["backup"], now = Date.now()) {
  const seq = await changeSeq(db);
  const lastSeq = await getMeta(db, "auto_backup_seq");
  const lastAt = await getMeta(db, "auto_backup_at");
  if (lastSeq === String(seq)) return false;
  if (lastAt && now - Date.parse(lastAt) < AUTO_BACKUP_EVERY_MS) return false;
  const snapshot = await exportSnapshot(db);
  if (isEmpty(snapshot)) return false;
  await backup("automatic", snapshot);
  await setMeta(db, "auto_backup_seq", String(seq));
  await setMeta(db, "auto_backup_at", new Date(now).toISOString());
  return true;
}

/** Records that the current data was saved to a file, for the "not exported since" reminder. */
export async function markExported(db: SqlDb) {
  await setMeta(db, "export_seq", String(await changeSeq(db)));
  await setMeta(db, "export_at", new Date().toISOString());
}

export async function exportState(db: Sql) {
  const seq = await changeSeq(db);
  const at = await getMeta(db, "export_at");
  return { exportedAt: at, changedSinceExport: (await getMeta(db, "export_seq")) !== String(seq) };
}

// ---------------------------------------------------------------- Supabase adapter

const rpcError = (error: { message: string }) =>
  error.message.includes("SYNC_CONFLICT") ? new SyncConflictError() : new Error(error.message);

export const supabaseCloud: CloudSync = {
  async status() {
    const { data, error } = await supabase.rpc("sync_status");
    if (error) throw rpcError(error);
    return data as unknown as CloudStatus;
  },
  async pull() {
    const { data, error } = await supabase.rpc("pull_snapshot");
    if (error) throw rpcError(error);
    return data as unknown as { version: number; snapshot: Snapshot };
  },
  async push(snapshot, expectedVersion) {
    const { data, error } = await supabase.rpc("push_snapshot", { p_snapshot: snapshot as never, p_expected_version: expectedVersion });
    if (error) throw rpcError(error);
    return Number(data);
  },
};
