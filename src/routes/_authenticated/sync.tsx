import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { AppShell, btnGhost, btnPrimary } from "@/components/AppShell";
import { useFieldDefs, usePrivateFields, useSession } from "@/lib/payroll";
import { EMPLOYEE_SECTIONS } from "@/lib/employee-fields";
import { useLabels } from "@/lib/labels";
import { ALWAYS_SYNCED, confirmPrivateFields, customKey, DEFAULT_SHARED, getPrivateFields, PERSONAL_DETAILS, PRIVATE_COLUMNS, privateFieldsConfirmed } from "@/lib/db/privacy";
import { cloudConfigured, setDataMode, useDataMode } from "@/lib/db/mode";
import { localDb, requestPersistentStorage } from "@/lib/db/local";
import { desktop } from "@/lib/desktop";
import { backupFileName, getBackup, listBackups, reasonLabel, saveBackup } from "@/lib/db/backups";
import { readBackupFile, saveBackupFile } from "@/lib/backup-file";
import { countRows, describeCounts, describeDiff, exportSnapshot, isEmpty, validateSnapshot, type Snapshot } from "@/lib/db/snapshot";
import {
  deviceIdentity, exportState, hasUnpushedChanges, localSyncState, markExported, pull, push, restoreSnapshot, setDeviceName, setPrivateFields,
  supabaseCloud, type SyncDeps,
} from "@/lib/db/sync";
import { Cloud, Download, FolderOpen, HardDrive, Lock, RotateCcw, Upload } from "lucide-react";

export const Route = createFileRoute("/_authenticated/sync")({
  head: () => ({ meta: [{ title: "Sync & backup — Meridian Payroll" }] }),
  component: SyncPage,
});

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "never");
const EXPORT_REMINDER_DAYS = 7;

function SyncPage() {
  const qc = useQueryClient();
  const mode = useDataMode();
  const { data: session } = useSession();
  const user = session?.user ?? null;
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const local = useQuery({
    queryKey: ["sync-local"],
    queryFn: async () => {
      const db = await localDb();
      // One transaction, so counts and sync state come from the same moment.
      const read = await db.transaction(async (tx) => {
        const snapshot = await exportSnapshot(tx);
        return { state: await localSyncState(tx), counts: countRows(snapshot), empty: isEmpty(snapshot), exported: await exportState(tx) };
      });
      return { ...read, persisted: navigator.storage?.persisted ? await navigator.storage.persisted() : null };
    },
  });
  const cloud = useQuery({
    queryKey: ["sync-cloud", user?.id],
    enabled: !!user,
    queryFn: () => supabaseCloud.status(),
    retry: false,
  });
  const backups = useQuery({ queryKey: ["backups"], queryFn: listBackups });
  const folders = useQuery({ queryKey: ["desktop-folders"], enabled: !!desktop, queryFn: () => desktop!.info() });
  const openFolder = (which: "data" | "backups") => desktop!.openFolder(which).catch((e: Error) => toast.error(e.message));
  const cloudBackups = useQuery({
    queryKey: ["cloud-backups", user?.id],
    enabled: !!user,
    retry: false,
    queryFn: async () => {
      const { data, error } = await supabase.from("cloud_backups").select("id, created_at, reason, version").order("id", { ascending: false }).limit(30);
      if (error) throw new Error(error.message);
      return data;
    },
  });

  const unpushed = user && local.data ? hasUnpushedChanges(local.data.state, user.id, local.data.empty) : false;
  const exportDue = local.data && !local.data.empty && local.data.exported.changedSinceExport &&
    (!local.data.exported.exportedAt || Date.now() - Date.parse(local.data.exported.exportedAt) > EXPORT_REMINDER_DAYS * 86_400_000);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
      // Everything may have changed: data, backups, sync state. Cancel first: a fetch that
      // started before the action may hold old data, and invalidating alone would reuse it.
      const all = { predicate: (q: { queryKey: readonly unknown[] }) => q.queryKey[0] !== "local-db-ready" };
      await qc.cancelQueries(all);
      await qc.invalidateQueries(all);
    }
  };

  const defaultDeviceName = async () => (desktop ? (await desktop.info()).computerName : "Web browser");
  const device = useQuery({ queryKey: ["device"], queryFn: async () => deviceIdentity(await localDb(), await defaultDeviceName()) });
  const rename = (name: string) => run("rename", async () => {
    if (name.trim() === device.data?.name) return;
    await setDeviceName(await localDb(), name);
  });

  const deps = async (): Promise<SyncDeps> => ({
    db: await localDb(), cloud: supabaseCloud, userId: user!.id, backup: saveBackup, defaultDeviceName: await defaultDeviceName(),
  });

  const { data: defs = [] } = useFieldDefs();
  const { label } = useLabels();
  /** A detail's name as the user sees it (aliases included). */
  const fieldName = (key: string) => {
    if (key.startsWith("custom:")) { const def = defs.find((x) => customKey(x.id) === key); return label(key, def?.label ?? "a deleted category"); }
    return label(key, EMPLOYEE_SECTIONS.flatMap((x) => x.fields).find((f) => f.k === key)?.label ?? (key === "notes" ? "Notes" : key));
  };

  /** Before the first push from this computer, show exactly what will and won't be uploaded. */
  const privacyChecked = async () => {
    const db = await localDb();
    if (await privateFieldsConfirmed(db)) return true;
    const keep = await getPrivateFields(db);
    const send = [...PRIVATE_COLUMNS, ...defs.map((x) => customKey(x.id))].filter((k) => !keep.includes(k));
    const list = (keys: string[]) => (keys.length ? keys.map(fieldName).join(", ") : "nothing");
    const ok = confirm(
      "This is the first push from this computer. Check what will be uploaded to the cloud:\n\n"
      + `Uploaded: employee ID, names, hourly rate, ${list(send)}.\n\n`
      + `Stays on this computer only: ${list(keep)}.\n\n`
      + 'To change this, cancel and use "Private fields" further down this page. Push with these settings?',
    );
    if (ok) await confirmPrivateFields(db);
    return ok;
  };

  const doPush = () => run("push", async () => {
    if (!(await privacyChecked())) return;
    const d = await deps();
    let r = await push(d);
    if (r.kind === "confirm") {
      const changes = [
        r.otherDevice && `${r.otherDevice.name} pushed its data to the cloud (${when(r.otherDevice.at)})`,
        r.editedInCloud && "the cloud copy was edited directly",
      ].filter(Boolean).join(", and ");
      const why = changes
        ? `Since this computer last synced, ${changes}.`
        : r.neverSynced
          ? "Your cloud account already has data that didn't come from this computer."
          : `The cloud copy was changed since this computer last synced (${when(r.cloudUpdatedAt)}).`;
      const diff = describeDiff(r.differ);
      const loss = diff
        ? `Compared with this computer, ${diff} differ. Pushing replaces the cloud copy with this computer's data, so those changes would be gone from the cloud (a copy is saved to Backups first).\n\nTo keep them instead, cancel and pull: this computer's data is backed up before a pull.`
        : "The data is the same on both sides, so pushing loses nothing.";
      if (!confirm(`${why}\n\n${loss}\n\nPush and overwrite the cloud copy?`)) return;
      r = await push(d, { confirmed: true });
    }
    if (r.kind === "done") toast.success(`Pushed to cloud: ${describeCounts(r.counts)}`);
  });

  const doPull = () => run("pull", async () => {
    const d = await deps();
    let r = await pull(d);
    if (r.kind === "empty") { toast.info("The cloud has no data yet. Push from a device first."); return; }
    if (r.kind === "confirm") {
      const why = r.neverSynced ? "This computer has data that has never been pushed to this account" : "This computer has changes that aren't in the cloud yet";
      const diff = describeDiff(r.differ);
      const loss = diff
        ? `Compared with the cloud, ${diff} differ. Pulling replaces this computer's data with the cloud copy (${describeCounts(r.cloudCounts)}), so those changes would be gone from here. This computer's data is saved to Backups first, so you can restore it.`
        : "The data is the same on both sides, so pulling loses nothing.";
      if (!confirm(`${why}.\n\n${loss}\n\nPull anyway?`)) return;
      r = await pull(d, { confirmed: true });
    }
    if (r.kind === "done") toast.success(`Pulled from cloud: ${describeCounts(r.counts)}`);
  });

  const restore = (snapshot: Snapshot, from: string, fromCloud = false) => run("restore", async () => {
    const s = validateSnapshot(snapshot);
    const kept = fromCloud ? " Private fields keep this device's values, since the cloud never had them." : "";
    if (!confirm(`Replace the data on this device with ${from} (${describeCounts(countRows(s))})?\n\nThe current data is saved to Backups first.${kept}`)) return;
    await restoreSnapshot(await localDb(), s, saveBackup, { keepPrivateFields: fromCloud });
    toast.success("Backup restored on this device");
  });

  const exportFile = () => run("export", async () => {
    const db = await localDb();
    if (await saveBackupFile(await exportSnapshot(db), backupFileName())) await markExported(db);
  });

  const backupNow = () => run("backup", async () => {
    await saveBackup("manual", await exportSnapshot(await localDb()));
    toast.success("Backup saved. It's kept until you delete it.");
  });

  const onFile = async (file: File | undefined) => {
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    try {
      const s = await readBackupFile(file);
      if (s) await restore(s, `the backup file "${file.name}"`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const switchMode = (m: "local" | "cloud") => {
    setDataMode(m);
    toast.success(m === "cloud" ? "Now editing your cloud copy directly. This device's data is untouched." : "Now editing the data on this device.");
  };

  return (
    <AppShell eyebrow="Your data" title="Sync & backup">
      {exportDue && (
        <div className="glass-panel flex items-center justify-between gap-4 p-4 text-sm">
          <span>Your data changed since your last backup file ({when(local.data?.exported.exportedAt)}). {desktop ? "Keep a copy somewhere other than this computer, such as a USB stick, in case it fails or is lost." : "A file is the only copy that survives this browser's storage being cleared."}</span>
          <button onClick={exportFile} className={btnPrimary} disabled={!!busy}>Download backup</button>
        </div>
      )}

      <section className="grid gap-4 md:grid-cols-2">
        <div className="glass-panel space-y-3 p-5">
          <div className="flex items-center gap-2 font-display font-extrabold tracking-tight"><HardDrive className="h-4 w-4" /> This device</div>
          <p className="text-sm text-muted-foreground">
            {local.isError ? `Couldn't read this device's data: ${local.error.message}` : local.data ? describeCounts(local.data.counts) : "Loading…"}
          </p>
          {desktop ? (
            <p className="text-xs text-muted-foreground">
              Stored on this computer in <code className="break-all">{folders.data?.dataDir ?? "…"}</code>.{" "}
              <button className="underline underline-offset-2" onClick={() => openFolder("data")}>Open folder</button>
            </p>
          ) : (
          <p className="text-xs text-muted-foreground">
            Stored in this browser. {local.data?.persisted === true ? "The browser has agreed to keep it." : local.data?.persisted === false ? "The browser may clear it if the disk gets full." : ""}
          </p>
          )}
          {cloudConfigured && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="shrink-0">Name when syncing</span>
              <input
                key={device.data?.name}
                defaultValue={device.data?.name ?? ""}
                maxLength={100}
                className="h-7 w-full max-w-56 rounded-lg bg-secondary px-2 text-sm text-foreground ring-1 ring-border"
                onBlur={(e) => void rename(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
              />
            </label>
          )}
          {local.data?.persisted === false && (
            <button className={btnGhost} onClick={() => run("persist", async () => {
              const ok = await requestPersistentStorage();
              if (ok) toast.success("The browser will keep this data"); else toast.warning("The browser declined. Keep downloading backup files.");
            })}>Ask the browser to keep it</button>
          )}
          <div>
            <button onClick={() => switchMode("local")} disabled={mode === "local"} className={mode === "local" ? btnPrimary : btnGhost}>
              {mode === "local" ? "Editing this device" : "Edit this device's data"}
            </button>
          </div>
        </div>

        <div className="glass-panel space-y-3 p-5">
          <div className="flex items-center gap-2 font-display font-extrabold tracking-tight"><Cloud className="h-4 w-4" /> Cloud account</div>
          {!cloudConfigured ? (
            <p className="text-sm text-muted-foreground">Cloud sync isn't set up: add your Supabase URL and key to <code>.env</code> (see README). Everything else works without it.</p>
          ) : !user ? (
            <>
              <p className="text-sm text-muted-foreground">Optional. Sign in to copy your data to the cloud and open it on other devices.</p>
              <Link to="/auth" className={`${btnPrimary} inline-block`}>Sign in</Link>
            </>
          ) : (
            <>
              <p className="text-sm">{user.email}</p>
              <p className="text-xs text-muted-foreground">
                {cloud.isError ? `Couldn't reach the cloud: ${cloud.error.message}` : cloud.data ? (cloud.data.has_data ? `Cloud copy last changed ${when(cloud.data.updated_at)}` : "No data in the cloud yet") : "Checking…"}
                {cloud.data?.pushed_by_name && ` (last pushed from ${cloud.data.pushed_by_device === device.data?.id ? "this computer" : cloud.data.pushed_by_name}, ${when(cloud.data.pushed_at)})`}
                {" · "}This device last synced {local.data?.state.syncedOwner === user.id ? when(local.data.state.syncedAt) : "never"}
              </p>
              {unpushed && <p className="text-xs font-medium text-primary">This device has changes that aren't in the cloud.</p>}
              <div className="flex flex-wrap gap-2">
                <button onClick={doPush} disabled={!!busy} className={btnPrimary}><Upload className="mr-1 inline h-4 w-4" />{busy === "push" ? "Pushing…" : "Push to cloud"}</button>
                <button onClick={doPull} disabled={!!busy} className={btnGhost}><Download className="mr-1 inline h-4 w-4" />{busy === "pull" ? "Pulling…" : "Pull to this device"}</button>
                <button onClick={() => switchMode("cloud")} disabled={mode === "cloud"} className={mode === "cloud" ? btnPrimary : btnGhost}>
                  {mode === "cloud" ? "Editing cloud" : "Edit cloud directly"}
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Push replaces the cloud copy with this device's data. Pull replaces this device's data with the cloud copy. Whatever gets replaced is saved to Backups first.
              </p>
            </>
          )}
        </div>
      </section>

      <PrivateFields busy={!!busy} onChange={(keys) => run("private", async () => {
        await setPrivateFields(await localDb(), keys);
      })} />

      <section className="glass-panel space-y-3 p-5">
        <div className="font-display font-extrabold tracking-tight">Backup files</div>
        <p className="text-sm text-muted-foreground">
          Last downloaded: {when(local.data?.exported.exportedAt)}. Keep a file somewhere safe (another drive, email, a USB stick). Restoring a file replaces this device's data, after backing up what's there now.
        </p>
        <div className="flex flex-wrap gap-2">
          <button onClick={exportFile} disabled={!!busy} className={btnPrimary}><Download className="mr-1 inline h-4 w-4" />Download backup file</button>
          <button onClick={() => fileRef.current?.click()} disabled={!!busy} className={btnGhost}><Upload className="mr-1 inline h-4 w-4" />Restore from file…</button>
          <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
        </div>
      </section>

      <section className="glass-panel overflow-hidden">
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="font-display font-extrabold tracking-tight">Backups on this device</div>
            <button onClick={backupNow} disabled={!!busy} className={btnGhost}>{busy === "backup" ? "Saving…" : "Back up now"}</button>
          </div>
          <p className="text-xs text-muted-foreground">Saved automatically every 30 minutes while there are changes{desktop ? ", when you close the app" : ""}, and before every pull, push, restore or app update. All from the last 2 days are kept, then one per day for a month, one per week for a year and one per month after that. Backups you save yourself are always kept.</p>
          {desktop && (
            <p className="mt-1 text-xs text-muted-foreground">
              Saved as files in <code className="break-all">{folders.data?.backupDir ?? "…"}</code>.{" "}
              <button className="inline-flex items-center gap-1 underline underline-offset-2" onClick={() => openFolder("backups")}><FolderOpen className="h-3 w-3" /> Open folder</button>
            </p>
          )}
        </div>
        <BackupList
          rows={(backups.data ?? []).map((b) => ({ key: b.id, at: b.created_at, label: reasonLabel[b.reason] ?? b.reason, detail: describeCounts(b.counts) }))}
          empty={backups.isError ? `Couldn't read backups: ${backups.error.message}` : "No backups yet."}
          busy={!!busy}
          onDownload={async (id) => { const b = await getBackup(id); if (b) await saveBackupFile(b.snapshot, backupFileName(new Date(b.created_at))); }}
          onRestore={async (id) => { const b = await getBackup(id); if (b) await restore(b.snapshot, `the backup from ${when(b.created_at)}`); }}
        />
      </section>

      {user && (
        <section className="glass-panel overflow-hidden">
          <div className="border-b border-border px-5 py-4">
            <div className="font-display font-extrabold tracking-tight">Backups in the cloud</div>
            <p className="text-xs text-muted-foreground">The cloud keeps its previous copy every time something is pushed over it.</p>
          </div>
          <BackupList
            rows={(cloudBackups.data ?? []).map((b) => ({ key: b.id, at: b.created_at, label: b.reason === "before-push" ? "Cloud copy, before a push replaced it" : "Cloud data before switching to local-first", detail: `version ${b.version}` }))}
            empty={cloudBackups.isError ? `Couldn't read cloud backups: ${cloudBackups.error.message}` : "No cloud backups yet."}
            busy={!!busy}
            onDownload={async (id) => { const s = await fetchCloudBackup(id); await saveBackupFile(s, `cloud-${backupFileName()}`); }}
            onRestore={async (id) => restore(await fetchCloudBackup(id), "a cloud backup", true)}
          />
        </section>
      )}
    </AppShell>
  );
}

/** Ticks for the employee details that stay on this device and are never sent to the cloud. */
function PrivateFields({ busy, onChange }: { busy: boolean; onChange: (keys: string[]) => void }) {
  const { data: keys } = usePrivateFields();
  const { data: defs = [] } = useFieldDefs();
  const { label } = useLabels();
  if (!keys) return null;
  const groups = [
    ...EMPLOYEE_SECTIONS.map((s) => ({ title: label(`section:${s.title}`, s.title), items: s.fields.filter((f) => !ALWAYS_SYNCED.includes(f.k)).map((f) => ({ key: f.k, label: label(f.k, f.label) })) })),
    { title: "Other", items: [{ key: "notes", label: label("notes", "Notes") }, ...defs.map((d) => ({ key: customKey(d.id), label: label(customKey(d.id), d.label) }))] },
  ];
  const everything = [...PRIVATE_COLUMNS, ...defs.map((d) => customKey(d.id))];
  const toggle = (k: string, on: boolean) => onChange(on ? [...keys, k] : keys.filter((x) => x !== k));
  const preset = "rounded-lg bg-secondary px-2.5 py-1.5 text-xs text-muted-foreground ring-1 ring-border hover:text-foreground disabled:opacity-50";
  return (
    <section className="glass-panel space-y-4 p-5">
      <div>
        <div className="flex items-center gap-2 font-display font-extrabold tracking-tight"><Lock className="h-4 w-4" /> Private fields</div>
        <p className="mt-1 text-sm text-muted-foreground">
          Ticked details stay on this device and are never sent to the cloud: pushing leaves them blank in the cloud copy, and pulling keeps this device's values.
          Employee ID, names and hourly rate always sync, since payroll needs them. Categories you add later start out private.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Making a field private after pushing? Push again to remove it from the cloud copy; older copies under "Backups in the cloud" still contain it.
          Backups on this computer and backup files you download keep everything; downloaded files ask for a password.
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className={preset} disabled={busy} onClick={() => onChange(everything.filter((k) => !DEFAULT_SHARED.includes(k)))}>Recommended: only work details sync</button>
        <button type="button" className={preset} disabled={busy} onClick={() => onChange(everything)}>Every detail</button>
        <button type="button" className={preset} disabled={busy} onClick={() => onChange(PERSONAL_DETAILS)}>Only personal details</button>
        <button type="button" className={preset} disabled={busy} onClick={() => onChange([])}>Sync everything</button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {groups.map((g) => (
          <div key={g.title}>
            <div className="mb-1.5 text-xs font-semibold text-muted-foreground">{g.title}</div>
            <div className="space-y-1">
              {g.items.map((it) => (
                <label key={it.key} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" disabled={busy} checked={keys.includes(it.key)} onChange={(e) => toggle(it.key, e.target.checked)} />
                  {it.label}
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

async function fetchCloudBackup(id: number): Promise<Snapshot> {
  const { data, error } = await supabase.from("cloud_backups").select("snapshot").eq("id", id).single();
  if (error) throw new Error(error.message);
  return validateSnapshot(data.snapshot);
}

function BackupList({ rows, empty, busy, onDownload, onRestore }: {
  rows: { key: number; at: string; label: string; detail: string }[];
  empty: string; busy: boolean;
  onDownload: (key: number) => Promise<void>; onRestore: (key: number) => Promise<void>;
}) {
  const safely = (fn: () => Promise<void>) => fn().catch((e) => toast.error((e as Error).message));
  if (!rows.length) return <div className="px-5 py-6 text-sm text-muted-foreground">{empty}</div>;
  return (
    <div className="max-h-96 divide-y divide-border overflow-y-auto">
      {rows.map((r) => (
        <div key={r.key} className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
          <div className="min-w-0">
            <div className="font-medium">{r.label}</div>
            <div className="text-xs text-muted-foreground">{when(r.at)} · {r.detail}</div>
          </div>
          <div className="flex shrink-0 gap-2">
            <button onClick={() => safely(() => onDownload(r.key))} className={btnGhost} title="Download as a file"><Download className="h-4 w-4" /></button>
            <button onClick={() => safely(() => onRestore(r.key))} disabled={busy} className={btnGhost} title="Restore onto this device"><RotateCcw className="h-4 w-4" /></button>
          </div>
        </div>
      ))}
    </div>
  );
}
