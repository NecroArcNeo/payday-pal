import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";
import { localDb, OtherTabError } from "@/lib/db/local";
import { saveBackup } from "@/lib/db/backups";
import { maybeAutoBackup } from "@/lib/db/sync";
import { setDataMode, useDataMode } from "@/lib/db/mode";
import { useSession } from "@/lib/payroll";

// No sign-in needed: the app runs on this device's database. (The folder name
// predates that; renaming it would only churn the route tree.)
export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  component: DataGate,
});

function DataGate() {
  const ready = useQuery({
    queryKey: ["local-db-ready"],
    queryFn: async () => {
      const db = await localDb();
      try {
        await maybeAutoBackup(db, saveBackup);
      } catch (e) {
        toast.warning(`Automatic backup failed: ${(e as Error).message}. Download a backup file from Sync & backup.`);
      }
      return true;
    },
    staleTime: Infinity,
    retry: false,
  });

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
