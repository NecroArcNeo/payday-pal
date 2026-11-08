import { useState } from "react";
import { toast } from "sonner";
import { CircleAlert, CircleCheck } from "lucide-react";
import { BACKUP_CHECK, checkNewestBackup, type BackupCheck } from "@/lib/db/backup-check";
import { usePref } from "@/lib/prefs";

const when = (iso: string) => new Date(iso).toLocaleString();

/** Says what the daily check last found (src/lib/db/backup-check.ts) and checks the newest backup on request. */
export function BackupCheckLine() {
  const [last] = usePref<BackupCheck | null>(BACKUP_CHECK, null);
  const [busy, setBusy] = useState(false);
  const checkNow = async () => {
    setBusy(true);
    try {
      const r = await checkNewestBackup(true);
      if (!r) toast.info("There's no backup to check yet");
      else if (r.ok) toast.success(`The newest backup restores cleanly (${r.rows.toLocaleString()} rows)`);
      else warnBackupCheck(r);
    } catch (e) {
      toast.error(`Couldn't check: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <p className={`mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs ${last && !last.ok ? "text-destructive" : "text-muted-foreground"}`}>
      {!last ? <span>Once a day the newest backup is restored into a test copy, to be sure it would restore.</span>
        : last.ok ? <span className="inline-flex items-center gap-1"><CircleCheck className="h-3.5 w-3.5 text-emerald-600" />Restore check: the backup from {when(last.created_at)} restores cleanly ({last.rows.toLocaleString()} rows), checked {when(last.at)}.</span>
        : <span className="inline-flex items-center gap-1"><CircleAlert className="h-3.5 w-3.5" />Restore check failed for the backup from {when(last.created_at)}: {last.error}. Click Back up now, then Check now; if it fails again, download a backup file.</span>}
      <button data-find="backup-check" onClick={() => void checkNow()} disabled={busy} className="underline underline-offset-2 disabled:opacity-60">{busy ? "Checking…" : "Check now"}</button>
    </p>
  );
}

/** A backup that wouldn't restore: said straight away, and kept on screen until dismissed. */
export function warnBackupCheck(r: BackupCheck) {
  toast.warning(`The newest backup (${when(r.created_at)}) didn't pass its restore check: ${r.error}. Click Back up now on Sync & backup, then Check now there; if it fails again, download a backup file to keep your data safe.`, { duration: Infinity });
}
