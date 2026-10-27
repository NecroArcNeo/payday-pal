import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";
import { localDb, OtherTabError } from "@/lib/db/local";
import { listBackups, saveBackup } from "@/lib/db/backups";
import { RecoveryScreen } from "@/components/RecoveryScreen";
import { maybeAutoBackup } from "@/lib/db/sync";
import { setDataMode, useDataMode } from "@/lib/db/mode";
import { useSession } from "@/lib/payroll";
import { desktop } from "@/lib/desktop";

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

function DataGate() {
  const ready = useQuery({
    queryKey: ["local-db-ready"],
    queryFn: async () => {
      await localDb();
      void warnIfUnclean();
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
    const timer = setInterval(() => void autoBackup(), AUTO_BACKUP_CHECK_MS);
    return () => clearInterval(timer);
  }, [ready.isSuccess]);

  // Cloud mode needs a signed-in account; without one, fall back to this device's data.
  const mode = useDataMode();
  const { data: session, isSuccess } = useSession();
  useEffect(() => {
    if (mode === "cloud" && isSuccess && !session?.user) {
      setDataMode("local");
      toast.info("Signed out — now showing the data on this device.");
    }
  }, [mode, isSuccess, session]);

  if (ready.isPending) {
    return <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">Opening your payroll data…</div>;
  }
  if (ready.isError) {
    if (!(ready.error instanceof OtherTabError)) return <RecoveryScreen error={ready.error} />;
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <div className="glass-panel max-w-md p-7 text-center">
          <div className="font-display text-xl font-extrabold tracking-tight">Already open in another tab</div>
          <p className="mt-2 text-sm text-muted-foreground">{ready.error.message}</p>
          <button onClick={() => location.reload()} className="mt-5 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">Reload</button>
        </div>
      </div>
    );
  }
  return <Outlet />;
}
