import { createFileRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";
import { localDb, NotDesktopError } from "@/lib/db/local";
import { listBackups, saveBackup } from "@/lib/db/backups";
import { RecoveryScreen } from "@/components/RecoveryScreen";
import { LockScreen } from "@/components/LockScreen";
import { maybeAutoBackup } from "@/lib/db/sync";
import { pruneHistory } from "@/lib/db/history";
import { checkNewestBackup } from "@/lib/db/backup-check";
import { warnBackupCheck } from "@/components/BackupCheck";
import { localStore } from "@/lib/db/store";
import { desktop, SECURITY_STATUS_KEY, type SecurityStatus } from "@/lib/desktop";
import { getPref, setPref } from "@/lib/prefs";
import { LAST_PLACE, placeToReopen, placeWorthKeeping } from "@/lib/last-place";

// No sign-in needed: the app runs on this device's database. (The folder name
// predates that; renaming it would only churn the route tree.)
export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  component: DataGate,
});

/** Checks for unsaved-to-backup changes this often; maybeAutoBackup decides whether one is due. */
const AUTO_BACKUP_CHECK_MS = 5 * 60 * 1000;

let backingUp: Promise<unknown> | null = null;
let warned = false;
/** One automatic backup at a time; a failure is shown once, not every few minutes. */
function autoBackup(everyMs?: number) {
  backingUp ??= localDb()
    .then((db) => maybeAutoBackup(db, saveBackup, Date.now(), everyMs))
    .then(() => { warned = false; })
    .catch((e: Error) => {
      if (warned) return;
      warned = true;
      toast.warning(`Automatic backup failed: ${e.message}. Download a backup file from Sync & backup.`);
    })
    .finally(() => { backingUp = null; });
  return backingUp;
}

/** How long after opening the first restore check may run: not while the app is starting. */
const FIRST_CHECK_MS = 2 * 60 * 1000;

/** The daily restore check of the newest backup (once a day at most); a failure is said at once. */
function checkBackups() {
  checkNewestBackup()
    .then((r) => { if (r && !r.ok) warnBackupCheck(r); })
    .catch((e: Error) => console.error("Backup check couldn't run:", e));
}

/** Removes edit history older than Settings → Edit history keeps (nothing, by default). */
async function keepHistoryTrimmed() {
  try {
    await pruneHistory(await localDb(), (await localStore.getSettings())?.history_keep_days ?? null);
  } catch (e) {
    console.error("Trimming the edit history failed:", e);
  }
}

/** The data opened fine after a crash or power cut; say so, in case the last few changes didn't make it. */
async function warnIfUnclean() {
  const since = desktop ? (await desktop.session()).uncleanSince : null;
  if (!since) return;
  const newest = (await listBackups().catch(() => []))[0];
  toast.warning(
    `The app didn't close normally last time (for example a crash or power cut). Your data opened and checks out. If your latest changes are missing, restore a backup on Sync & backup${newest ? `; the newest is from ${new Date(newest.created_at).toLocaleString()}` : ""}.`,
    { duration: 20_000 },
  );
}

/** Backups from before encryption that couldn't be sealed yet: said once (the app tries again next start). */
function reportEncryption(s: SecurityStatus | null | undefined) {
  if (s?.encryptError) {
    toast.warning(`Some older backups couldn't be encrypted yet (${s.encryptError}). They're kept as they were; the app tries again next time it starts.`, { duration: 20_000 });
  }
}

/** A database from before the move to SQLite was set aside at this start: say where, and how to get the data back. */
async function reportOldDatabase() {
  const moved = desktop ? (await desktop.session()).movedOldDatabase : null;
  if (!moved) return;
  const newest = (await listBackups().catch(() => []))[0];
  toast.info(
    `This version keeps your data in a new kind of file. The previous database was kept in ${moved}. ${newest ? `Restore your newest backup (${new Date(newest.created_at).toLocaleString()}) on Sync & backup to bring your data across.` : "Restore a backup file on Sync & backup to bring your data across."}`,
    { duration: 60_000 },
  );
}

function DataGate() {
  const queryClient = useQueryClient();
  // The desktop app's data is encrypted: before anything opens it, the key has to be unlocked (electron/main.mjs).
  const security = useQuery({
    queryKey: SECURITY_STATUS_KEY,
    queryFn: () => desktop?.security.status() ?? null,
    staleTime: Infinity,
    retry: false,
  });
  const unlocked = security.data?.state === "unlocked";
  const ready = useQuery({
    queryKey: ["local-db-ready"],
    enabled: unlocked,
    queryFn: async () => {
      await localDb();
      reportEncryption(queryClient.getQueryData<SecurityStatus | null>(SECURITY_STATUS_KEY));
      void warnIfUnclean();
      void reportOldDatabase();
      void keepHistoryTrimmed();
      await autoBackup();
      // The desktop app asks before its window closes, so the last changes get backed up too.
      desktop?.onClosing(() => autoBackup(0));
      return true;
    },
    staleTime: Infinity,
    retry: false,
  });

  useEffect(() => {
    if (!ready.isSuccess) return;
    const timer = setInterval(() => { void autoBackup().then(checkBackups); }, AUTO_BACKUP_CHECK_MS);
    const first = setTimeout(checkBackups, FIRST_CHECK_MS);
    return () => { clearInterval(timer); clearTimeout(first); };
  }, [ready.isSuccess]);

  if (!desktop) return <NotDesktop />;
  if (security.data && security.data.state !== "unlocked") {
    return <LockScreen status={security.data} onUnlocked={(s) => queryClient.setQueryData(SECURITY_STATUS_KEY, s)} />;
  }
  if (security.isError) return <RecoveryScreen error={security.error} />;
  if (ready.isPending) {
    return <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">Opening your payroll data…</div>;
  }
  if (ready.isError) return <RecoveryScreen error={ready.error} />;
  return <><KeepPlace /><Outlet /></>;
}

/** Whether this window already went back to where it was left (once per start; a reload keeps its own address). */
let reopened = false;

/** Remembers the page shown (with its address's settings), and opens on it again when the app starts on the Dashboard. */
function KeepPlace() {
  const href = useRouterState({ select: (s) => s.location.href });
  const navigate = useNavigate();
  useEffect(() => {
    if (!reopened) {
      reopened = true;
      const back = placeToReopen(href, getPref<unknown>(LAST_PLACE, null));
      if (back) { void navigate({ href: back, replace: true }); return; }
    }
    if (placeWorthKeeping(href)) setPref(LAST_PLACE, href);
  }, [href, navigate]);
  return null;
}

/** Opened in a plain browser tab: the data lives in the desktop app, so say where to find it. */
function NotDesktop() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="glass-panel max-w-md p-7 text-center">
        <div className="font-display text-xl font-extrabold tracking-tight">KoPayroll runs in its desktop window</div>
        <p className="mt-2 text-sm text-muted-foreground">{new NotDesktopError().message}</p>
      </div>
    </div>
  );
}
