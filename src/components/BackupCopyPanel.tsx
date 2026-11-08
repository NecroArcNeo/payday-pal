import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, FolderOpen, HardDriveDownload } from "lucide-react";
import { btnGhost, btnPrimary } from "@/components/AppShell";
import { desktop, type BackupCopyStatus } from "@/lib/desktop";
import { askPassword } from "@/lib/password-prompt";
import { askConfirm } from "@/lib/choice-prompt";
import { saveBackup } from "@/lib/db/backups";
import { localDb } from "@/lib/db/local";
import { maybeAutoBackup } from "@/lib/db/sync";
import { FoldBox } from "@/components/FoldBox";

/** The react-query key the copies' status is kept under (Sync & backup's banner reads it too). */
export const BACKUP_COPY_KEY = ["backup-copy"];
const KEEP_CHOICES = [5, 10, 30, 100]; // as electron/backup-copy.mjs
const when = (iso: string) => new Date(iso).toLocaleString();

/** The copies' status, refreshed every minute (the main process copies by itself, after each backup). */
export const useBackupCopy = () =>
  useQuery({ queryKey: BACKUP_COPY_KEY, enabled: !!desktop, queryFn: () => desktop!.backupCopy.status(), refetchInterval: 60_000 });

const PASSWORD_DETAIL = "You'll need this password to restore a copy, for example on a new computer after this one's disk is wiped. The app remembers a key made from it, so it never asks again while copying. Without the password nobody can open the copies, including you, so keep it somewhere other than this computer.";

/**
 * Sync & backup's "Copy backups to another drive": after every backup, the main process also writes the
 * newest one into a folder the user picks (electron/backup-copy.mjs), as a password-protected backup file
 * that "Restore from file" opens on any computer. This only chooses the folder and password and shows how
 * the last copy went.
 */
export function BackupCopyPanel() {
  const qc = useQueryClient();
  const status = useBackupCopy();
  const [busy, setBusy] = useState<string | null>(null);
  if (!desktop) return null;
  const s = status.data;
  const copy = desktop.backupCopy;
  // The page updates by itself (hot reload, or a new build's pages) but the main process only on a restart.
  if (!copy) {
    return (
      <section className="glass-panel space-y-2 p-5">
        <div className="flex items-center gap-2 font-display font-extrabold tracking-tight"><HardDriveDownload className="h-4 w-4" /> Copy backups to another drive</div>
        <p className="text-sm text-muted-foreground">Close the app and open it again to finish updating: this part needs the app restarted.</p>
      </section>
    );
  }

  const act = async (label: string, fn: () => Promise<BackupCopyStatus | void>) => {
    setBusy(label);
    try {
      const next = await fn();
      if (next) qc.setQueryData(BACKUP_COPY_KEY, next);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  /** Picks a folder and checks it; null if cancelled or the user would rather pick another. */
  const pickFolder = async () => {
    const folder = await copy.choose();
    if (!folder) return null;
    const checked = await copy.check(folder);
    const warnings = [
      checked.sameDrive && "It's on the same drive as the app's own data, so a failed or wiped disk would take the copies too. A USB stick or another drive keeps them safe from that.",
      checked.cloudFolder && "It's in a folder that a cloud service (such as OneDrive) uploads, so the copies will be uploaded too. With a password they can't be read there.",
    ].filter((w): w is string => !!w);
    if (warnings.length && !(await askConfirm({ title: `Copy backups to ${checked.folder}?`, detail: warnings.join("\n\n"), confirm: "Use this folder" }))) return null;
    return checked.folder;
  };
  /** A new password, null for none, undefined when cancelled. */
  const pickPassword = async (title: string, action: string) => {
    const r = await askPassword({ mode: "set", title, detail: PASSWORD_DETAIL, action });
    return !r ? undefined : "plain" in r ? null : r.password;
  };
  const report = (next: BackupCopyStatus & { skipped?: number }, done: string) => {
    if (next.on && next.error) toast.error(`Saved, but the first copy failed: ${next.error.message}`);
    else toast.success(done);
    if (next.skipped) toast.warning(`${next.skipped} older ${next.skipped === 1 ? "copy" : "copies"} in that folder couldn't be opened, so ${next.skipped === 1 ? "it keeps" : "they keep"} the password ${next.skipped === 1 ? "it was" : "they were"} made with.`);
    return next;
  };

  const turnOn = () => act("on", async () => {
    const folder = await pickFolder();
    if (!folder) return;
    const password = await pickPassword("Password for the copies", "Turn on copies");
    if (password === undefined) return;
    return report(await copy.set({ folder, password }), "Backups will be copied there from now on, starting with the newest.");
  });
  const moveFolder = () => act("folder", async () => {
    const folder = await pickFolder();
    if (!folder) return;
    return report(await copy.set({ folder }), "Backups will be copied to the new folder. The copies in the old one stay there.");
  });
  const changePassword = () => act("password", async () => {
    const password = await pickPassword("New password for the copies", "Change password");
    if (password === undefined) return;
    return report(await copy.set({ password }), password === null ? "The copies are no longer password-protected." : "The copies use the new password, including the ones already in the folder.");
  });
  /** Backs up first if anything changed since the last automatic backup, so the copy has the latest data. */
  const copyNow = async () => {
    await maybeAutoBackup(await localDb(), saveBackup, Date.now(), 0);
    void qc.invalidateQueries({ queryKey: ["backups"] });
    const next = await copy.now();
    if (next.on && next.error) toast.error(`Couldn't copy: ${next.error.message}`);
    else toast.success("The newest backup is in the folder.");
    return next;
  };
  const turnOff = () => act("off", async () => {
    if (!(await askConfirm({ title: "Stop copying backups?", detail: "The copies already in the folder stay there. Only this computer's backups remain, and they go with it if its disk fails.", confirm: "Stop copying", danger: true }))) return;
    return copy.off();
  });

  return (
    <FoldBox id="settings:backup-copies" title="Copies on another drive">
      <section className="glass-panel space-y-3 p-5">
        <div className="flex items-center gap-2 font-display font-extrabold tracking-tight"><HardDriveDownload className="h-4 w-4" /> Copy backups to another drive</div>
        {!s ? (
          status.isError ? (
            <>
              <p className="text-sm text-destructive">Couldn't read the copy settings: {status.error.message}. If the app was just updated, close it and open it again.</p>
              <button onClick={() => void status.refetch()} className={btnGhost}>Try again</button>
            </>
          ) : <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !s.on ? (
          <>
            <p className="text-sm text-muted-foreground">
              The backups below are on this computer's disk: if it fails or is wiped, they go with it. Pick a folder on a USB stick or another drive, and after every backup the app also saves the newest there as a password-protected backup file. To get your data back, install the app on any computer and use Restore from file.
            </p>
            <button onClick={turnOn} disabled={!!busy} className={btnPrimary}>{busy === "on" ? "Setting up…" : "Choose where to copy backups…"}</button>
          </>
        ) : (
          <>
            <p className="text-sm">
              Copying to <code className="break-all">{s.folder}</code>{" "}
              <span className="inline-flex gap-3 text-xs text-muted-foreground">
                <button className="underline underline-offset-2" onClick={moveFolder} disabled={!!busy}>Change…</button>
                <button className="inline-flex items-center gap-1 underline underline-offset-2" onClick={() => desktop!.openFolder("copy").catch((e: Error) => toast.error(e.message))}><FolderOpen className="h-3 w-3" /> Open folder</button>
              </span>
            </p>
            {s.error ? (
              <p className="flex items-start gap-2 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>Couldn't copy at {when(s.error.at)}: {s.error.message}. It tries again every few minutes and after the next backup.{s.copied && ` The last copy there is from ${when(s.copied.backupAt)}.`}</span>
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">{s.copied ? `Last copy: the backup from ${when(s.copied.backupAt)}, copied ${when(s.copied.at)}.` : "No copy yet: one is made after the next backup."}</p>
            )}
            {s.keyLost && <p className="text-sm text-destructive">This computer's key changed since copies were turned on, so the app can't use the copies' password any more. Set it again to keep copying.</p>}
            {!s.protected && <p className="text-xs text-destructive">The copies have no password: anyone with the drive can read everything in them, including ID numbers.</p>}
            {s.sameDrive && <p className="text-xs text-muted-foreground">This folder is on the same drive as the app's data, so a failed or wiped disk would take the copies too.</p>}
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => act("now", copyNow)} disabled={!!busy} className={btnPrimary}>{busy === "now" ? "Copying…" : "Copy now"}</button>
              <button onClick={moveFolder} disabled={!!busy} className={btnGhost}>Change folder…</button>
              <button onClick={changePassword} disabled={!!busy} className={btnGhost}>{s.keyLost ? "Set the password again…" : s.protected ? "Change password…" : "Add a password…"}</button>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                Keep the newest
                <select
                  className="h-9 rounded-xl bg-secondary px-2 text-sm text-foreground ring-1 ring-border"
                  value={s.keep}
                  disabled={!!busy}
                  onChange={(e) => void act("keep", () => copy.set({ keep: Number(e.target.value) }))}
                >
                  {KEEP_CHOICES.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <button onClick={turnOff} disabled={!!busy} className={`${btnGhost} ml-auto`}>Stop copying</button>
            </div>
            <p className="text-[11px] text-muted-foreground">Copies of backups you save yourself (Back up now) are always kept. Files in the folder that aren't this computer's copies are never touched.</p>
          </>
        )}
      </section>
    </FoldBox>
  );
}
