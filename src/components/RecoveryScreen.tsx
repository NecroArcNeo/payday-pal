import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { btnGhost, btnPrimary } from "@/components/AppShell";
import { getBackup, listBackups, reasonLabel, saveBackup } from "@/lib/db/backups";
import { readBackupFile } from "@/lib/backup-file";
import { localDb } from "@/lib/db/local";
import { countRows, describeCounts, validateSnapshot, type Snapshot } from "@/lib/db/snapshot";
import { restoreSnapshot } from "@/lib/db/sync";
import { desktop } from "@/lib/desktop";
import { askConfirm } from "@/lib/choice-prompt";

const when = (iso: string) => new Date(iso).toLocaleString();
/** How many of the newest backups to offer; older ones are on Sync & backup once the data opens again. */
const SHOWN = 10;

/**
 * Shown when the payroll database can't be opened. Nothing happens until the user picks a backup and
 * confirms: the damaged database folder is moved aside (never deleted) and the backup is restored into a
 * new one.
 */
export function RecoveryScreen({ error }: { error: Error }) {
  const backups = useQuery({ queryKey: ["recovery-backups"], queryFn: listBackups, retry: false });
  const [picked, setPicked] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<{ from: string; aside: string | null } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const rows = (backups.data ?? []).slice(0, SHOWN);
  const selected = picked ?? rows[0]?.id ?? null;

  const restore = async (snapshot: Snapshot, from: string) => {
    const s = validateSnapshot(snapshot);
    if (!(await askConfirm({
      title: `Restore ${from}?`,
      detail: `It holds ${describeCounts(countRows(s))}.\n\nChanges made after it was saved won't be in the restored data. The damaged database is moved aside and kept, not deleted.`,
      confirm: "Restore this backup",
    }))) return;
    setBusy(true);
    setProblem(null);
    try {
      const aside = await desktop!.db.setAside();
      await restoreSnapshot(await localDb(), s, saveBackup, { from: `${from}, after the database couldn't be opened` });
      setDone({ from, aside });
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const restorePicked = async () => {
    const b = selected === null ? undefined : await getBackup(selected);
    if (!b) { setProblem("That backup couldn't be read. Pick another one."); return; }
    await restore(b.snapshot, `the backup from ${when(b.created_at)}`);
  };

  const restoreFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const s = await readBackupFile(file);
      if (s) await restore(s, `the file ${file.name}`);
    } catch (e) {
      setProblem((e as Error).message);
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  if (done) {
    return (
      <Frame title="Your data is back">
        <p className="text-sm">Restored {done.from}.</p>
        {done.aside && <p className="text-xs text-muted-foreground">The damaged database was kept in <code className="break-all">{done.aside}</code>. You can delete it once you've checked everything is there.</p>}
        <button onClick={() => location.reload()} className={btnPrimary}>Open the app</button>
      </Frame>
    );
  }

  return (
    <Frame title="Your payroll data couldn't be opened">
      <p className="text-sm text-muted-foreground">{error.message}</p>
      <p className="text-xs text-muted-foreground">Nothing has been changed or deleted. Pick a backup to restore; the damaged database will be moved aside and kept.</p>

      {backups.isError ? (
        <p className="text-sm text-destructive">The backups couldn't be read either: {backups.error.message}</p>
      ) : backups.isPending ? (
        <p className="text-sm text-muted-foreground">Looking for backups…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No backups were found on this computer.</p>
      ) : (
        <div className="max-h-72 divide-y divide-border overflow-y-auto rounded-xl ring-1 ring-border">
          {rows.map((b) => (
            <label key={b.id} className="flex cursor-pointer items-center gap-3 px-4 py-2.5 text-sm">
              <input type="radio" name="backup" checked={selected === b.id} onChange={() => setPicked(b.id)} />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{when(b.created_at)}{b.id === rows[0]!.id ? " (newest)" : ""}</span>
                <span className="block text-xs text-muted-foreground">{reasonLabel[b.reason] ?? b.reason} · {describeCounts(b.counts)}</span>
              </span>
            </label>
          ))}
        </div>
      )}

      {problem && <p className="text-sm text-destructive">{problem}</p>}

      <div className="flex flex-wrap gap-2">
        <button onClick={restorePicked} disabled={busy || selected === null} className={btnPrimary}>{busy ? "Restoring…" : "Restore selected backup"}</button>
        <button onClick={() => fileRef.current?.click()} disabled={busy} className={btnGhost}>Restore from a file…</button>
        <button onClick={() => void desktop!.openFolder("backups")} className={btnGhost}>Open backups folder</button>
        <button onClick={() => location.reload()} disabled={busy} className={btnGhost}>Try again</button>
      </div>
      <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => void restoreFile(e.target.files?.[0])} />
    </Frame>
  );
}

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-10">
      <div className="glass-panel w-full max-w-xl space-y-4 p-7">
        <div className="font-display text-xl font-extrabold tracking-tight">{title}</div>
        {children}
      </div>
    </div>
  );
}
