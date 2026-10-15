import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CloudUpload, CloudDownload, Loader2 } from "lucide-react";
import { pushSync, pullSync, type SyncResult } from "@/lib/sync";
import { localDb } from "@/lib/local-db";

export function SyncButton() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);

  const doSync = async (direction: "push" | "pull") => {
    setBusy(true);
    try {
      const result: SyncResult = direction === "push" ? await pushSync() : await pullSync();
      setLastSync(result.timestamp);
      setOpen(false);
      qc.invalidateQueries();
      toast.success(
        direction === "push"
          ? `Pushed ${result.employees} employees, ${result.timeRecords} records to cloud`
          : `Pulled ${result.employees} employees, ${result.timeRecords} records from cloud`,
      );
    } catch (err) {
      toast.error(`Sync failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => { setOpen(!open); if (!lastSync) localDb.getSyncMeta().then((m) => setLastSync(m.last_sync)); }}
        disabled={busy}
        className="rounded-xl bg-secondary px-3 py-2 text-sm font-medium ring-1 ring-border text-muted-foreground hover:text-foreground transition-colors"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Sync"}
      </button>
      {open && !busy && (
        <div className="absolute right-0 top-full mt-2 w-72 rounded-2xl border border-border bg-glass p-4 shadow-xl backdrop-blur-xl z-20">
          <div className="font-display text-sm font-extrabold tracking-tight">Sync data</div>
          <p className="mt-1 text-xs text-muted-foreground">
            {lastSync ? `Last sync: ${new Date(lastSync).toLocaleString()}` : "Not synced yet"}
          </p>
          <div className="mt-4 space-y-2">
            <button
              onClick={() => doSync("push")}
              className="flex w-full items-center gap-3 rounded-xl bg-secondary p-3 text-left ring-1 ring-border hover:text-foreground transition-colors"
            >
              <CloudUpload className="h-5 w-5 text-accent-foreground" />
              <div>
                <div className="text-sm font-medium">Push to cloud</div>
                <div className="text-xs text-muted-foreground">Overwrite cloud with this device's data</div>
              </div>
            </button>
            <button
              onClick={() => doSync("pull")}
              className="flex w-full items-center gap-3 rounded-xl bg-secondary p-3 text-left ring-1 ring-border hover:text-foreground transition-colors"
            >
              <CloudDownload className="h-5 w-5 text-accent-foreground" />
              <div>
                <div className="text-sm font-medium">Pull from cloud</div>
                <div className="text-xs text-muted-foreground">Overwrite this device with cloud data</div>
              </div>
            </button>
          </div>
          <p className="mt-3 text-[10px] text-muted-foreground">
            Requires internet. Sync replaces all data in the chosen direction.
          </p>
        </div>
      )}
    </div>
  );
}
