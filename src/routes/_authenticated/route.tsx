import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";
import { localDb, OtherTabError } from "@/lib/db/local";
import { saveBackup } from "@/lib/db/backups";
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

function DataGate() {
  const ready = useQuery({
    queryKey: ["local-db-ready"],
    queryFn: async () => {
      await localDb();
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
    const otherTab = ready.error instanceof OtherTabError;
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <div className="glass-panel max-w-md p-7 text-center">
          <div className="font-display text-xl font-extrabold tracking-tight">{otherTab ? "Already open in another tab" : "Couldn't open your payroll data"}</div>
          <p className="mt-2 text-sm text-muted-foreground">{ready.error.message}</p>
          {!otherTab && <p className="mt-2 text-xs text-muted-foreground">Your data has not been changed or deleted.</p>}
          <button onClick={() => location.reload()} className="mt-5 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">Reload</button>
        </div>
      </div>
    );
  }
  return <Outlet />;
}
