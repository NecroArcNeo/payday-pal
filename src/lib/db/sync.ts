import { supabase } from "@/integrations/supabase/client";
import type { BackupReason } from "./backups";
import { changeSeq, getMeta, setMeta } from "./local";
import { confirmPrivateFields, customKey, DEFAULT_SHARED, getPrivateFields, keepPrivate, PRIVATE_COLUMNS, redactSnapshot, savePrivateFields } from "./privacy";
import { SCHEMA_VERSION, TABLES } from "./schema";
import { addHistory } from "./history";
import { countRows, describeCounts, diffCounts, exportSnapshot, isEmpty, replaceWithSnapshot, validateSnapshot, type Snapshot, type SnapshotCounts, type Sql, type SqlDb } from "./snapshot";

// Push copies this device's whole database to the signed-in account; pull
// copies the account's database onto this device. Neither ever overwrites
// anything without (1) a verified backup of what is about to be replaced and
// (2) the user's confirmation when the other side changed since the last sync.
// Private fields (privacy.ts) are never sent, and pulls keep this device's values for them.

export class SyncConflictError extends Error {
  constructor() { super("The cloud copy changed while syncing. Nothing was overwritten — review and try again."); }
}

export type CloudStatus = {
  version: number; has_data: boolean; updated_at: string | null; schema_version: number;
  /** Which computer pushed last, and the version that push made (cloud migration 0010; missing before it). */
  pushed_by_device?: string | null; pushed_by_name?: string | null; pushed_at?: string | null; pushed_version?: number | null;
};

/** A computer, as sync knows it: a random id made once per database, and a name the user can change. */
export type Device = { id: string; name: string };

/** The server functions in drizzle/migrations/0003_local_first_sync.sql (and 0010 for the pushing computer). */
export interface CloudSync {
  status(): Promise<CloudStatus>;
  pull(): Promise<{ version: number; snapshot: Snapshot }>;
  /** Replaces the cloud copy and records which computer did it. Must throw SyncConflictError if the cloud version isn't `expectedVersion`. */
  push(snapshot: Snapshot, expectedVersion: number, device: Device): Promise<number>;
}

export type SyncDeps = {
  db: SqlDb;
  cloud: CloudSync;
  userId: string;
  backup: (reason: BackupReason, snapshot: Snapshot) => Promise<unknown>;
  /** This computer's name until the user gives it one. */
  defaultDeviceName?: string;
};

export type PushResult =
  | { kind: "done"; counts: SnapshotCounts }
  | {
    kind: "confirm"; cloudCounts: SnapshotCounts; cloudUpdatedAt: string | null; neverSynced: boolean;
    /** Rows that differ between this computer and the cloud: what pushing would overwrite there. */
    differ: SnapshotCounts;
    /** Another computer that pushed since this one last synced. */
    otherDevice: { name: string; at: string | null } | null;
    /** The cloud copy was edited directly ("Edit cloud directly") since the last push. */
    editedInCloud: boolean;
  };
export type PullResult =
  | { kind: "done"; counts: SnapshotCounts }
  | { kind: "empty" }
  | { kind: "confirm"; localCounts: SnapshotCounts; cloudCounts: SnapshotCounts; neverSynced: boolean; differ: SnapshotCounts };

const DEVICE = { id: "device_id", name: "device_name" } as const;

/** This computer's sync identity. The id is made on first use and only ever leaves this database as "who pushed". */
export async function deviceIdentity(sql: Sql, defaultName = "This computer"): Promise<Device> {
  let id = await getMeta(sql, DEVICE.id);
  if (!id) {
    id = crypto.randomUUID();
    await setMeta(sql, DEVICE.id, id);
  }
  return { id, name: (await getMeta(sql, DEVICE.name)) || defaultName };
}

/** Renames this computer for sync. Empty goes back to the default name. */
export async function setDeviceName(sql: Sql, name: string) {
  await setMeta(sql, DEVICE.name, name.trim().slice(0, 100) || null);
}

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

export async function push({ db, cloud, userId, backup, defaultDeviceName }: SyncDeps, opts: { confirmed?: boolean } = {}): Promise<PushResult> {
  const status = await cloud.status();
  checkSchema(status.schema_version);
  const st = await localSyncState(db);
  const device = await deviceIdentity(db, defaultDeviceName);
  const neverSynced = st.syncedOwner !== userId;
  const cloudChanged = status.has_data && (neverSynced || status.version !== st.syncedVersion);

  let expected = status.version;
  if (status.has_data) {
    const remote = await cloud.pull();
    if (cloudChanged && !opts.confirmed) {
      const since = neverSynced ? -1 : (st.syncedVersion ?? -1);
      const pushedSince = status.pushed_version != null && status.pushed_version > since;
      const local = redactSnapshot(await exportSnapshot(db), await getPrivateFields(db));
      return {
        kind: "confirm", cloudCounts: countRows(remote.snapshot), cloudUpdatedAt: status.updated_at, neverSynced,
        differ: diffCounts(local, remote.snapshot),
        otherDevice: pushedSince && status.pushed_by_device && status.pushed_by_device !== device.id
          ? { name: status.pushed_by_name || "Another computer", at: status.pushed_at ?? null }
          : null,
        editedInCloud: status.pushed_version != null && status.version > Math.max(status.pushed_version, since),
      };
    }
    // Keep the exact cloud copy we're about to replace, and only replace that version.
    await backup("before-push-cloud-copy", validateSnapshot(remote.snapshot));
    expected = remote.version;
  }

  const { snapshot, seq } = await db.transaction(async (tx) => ({
    snapshot: redactSnapshot(await exportSnapshot(tx), await getPrivateFields(tx)),
    seq: await changeSeq(tx),
  }));
  const version = await cloud.push(snapshot, expected, device);

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
    const differ = diffCounts(redactSnapshot(current, await getPrivateFields(db)), incoming);
    return { kind: "confirm", localCounts: countRows(current), cloudCounts: countRows(incoming), neverSynced, differ };
  }
  if (!isEmpty(current)) await backup("before-pull", current);

  await replaceWithSnapshot(db, keepPrivate(incoming, current, await getPrivateFields(db)), {
    // Refuse if anything was written after the backup was taken.
    before: async (tx) => { if ((await changeSeq(tx)) !== seq) throw new Error("Data on this device changed during the pull. Nothing was replaced — try again."); },
    after: async (tx) => {
      await addHistory(tx, "restore", `pulled the cloud copy (${describeCounts(countRows(incoming))})`);
      await markSynced(tx, await changeSeq(tx), remote.version, userId);
    },
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
  await confirmPrivateFields(db);
  if (keys.some((k) => !before.includes(k)) && (await getMeta(db, META.seq)) !== null) await setMeta(db, META.seq, "-1");
}

/**
 * Replaces this device's data with a backup, after backing up what's there now. Cloud backups never held
 * private fields, so `keepPrivateFields` keeps this device's values for them.
 *
 * A field stays private if either this device or the backup kept it private, so restoring onto a fresh
 * install (whose choices are the defaults) can't make anything less private than it was.
 */
export async function restoreSnapshot(db: SqlDb, snapshot: Snapshot, backup: SyncDeps["backup"], opts: { keepPrivateFields?: boolean; from?: string } = {}) {
  const incoming = validateSnapshot(snapshot);
  const { snapshot: current, seq } = await db.transaction(async (tx) => ({ snapshot: await exportSnapshot(tx), seq: await changeSeq(tx) }));
  if (!isEmpty(current)) await backup("before-restore", current);
  const privateHere = await getPrivateFields(db);
  // Backups from before private_fields was recorded: assume the defaults, with every category private.
  const privateThere = incoming.private_fields
    ?? [...PRIVATE_COLUMNS.filter((k) => !DEFAULT_SHARED.includes(k)), ...incoming.data.employee_field_defs.map((d) => customKey(String(d["id"])))];
  await replaceWithSnapshot(db, opts.keepPrivateFields ? keepPrivate(incoming, current, privateHere) : incoming, {
    before: async (tx) => { if ((await changeSeq(tx)) !== seq) throw new Error("Data changed during the restore. Nothing was replaced — try again."); },
    after: async (tx) => {
      await savePrivateFields(tx, [...new Set([...privateHere, ...privateThere])]);
      await addHistory(tx, "restore", `restored ${opts.from ?? "a backup"} (${describeCounts(countRows(incoming))})`);
    },
  });
}

/** At most this much work is ever missing from the newest automatic backup while the app is open. */
export const AUTO_BACKUP_EVERY_MS = 30 * 60 * 1000;

/**
 * Takes a backup when data changed since the last automatic one and `everyMs` has passed.
 * Pass 0 to back up any change right away (when the app closes).
 */
export async function maybeAutoBackup(db: SqlDb, backup: SyncDeps["backup"], now = Date.now(), everyMs = AUTO_BACKUP_EVERY_MS) {
  const seq = await changeSeq(db);
  const lastSeq = await getMeta(db, "auto_backup_seq");
  const lastAt = await getMeta(db, "auto_backup_at");
  if (lastSeq === String(seq)) return false;
  if (lastAt && now - Date.parse(lastAt) < everyMs) return false;
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
  async push(snapshot, expectedVersion, device) {
    const args = { p_snapshot: snapshot as never, p_expected_version: expectedVersion };
    let { data, error } = await supabase.rpc("push_snapshot", { ...args, p_device_id: device.id, p_device_name: device.name } as never);
    // A cloud database without migration 0010 only has the two-argument push.
    if (error?.code === "PGRST202") ({ data, error } = await supabase.rpc("push_snapshot", args));
    if (error) throw rpcError(error);
    return Number(data);
  },
};
