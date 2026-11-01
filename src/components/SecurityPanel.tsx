import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Copy, Download, ShieldCheck } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { btnGhost, btnPrimary, inputCls } from "@/components/AppShell";
import { downloadBlob } from "@/lib/db/backups";
import { localDb } from "@/lib/db/local";
import { cloudConfigured } from "@/lib/db/mode";
import { deviceIdentity } from "@/lib/db/sync";
import { desktop, SECURITY_STATUS_KEY, type SecurityStatus } from "@/lib/desktop";
import { deleteEscrow, uploadEscrow } from "@/lib/key-escrow";
import { askPassword } from "@/lib/password-prompt";
import { useSession } from "@/lib/payroll";

/**
 * Sync & backup's "Security" section: the data's encryption on this computer, the optional app password, the
 * recovery key and email reset. The keys themselves stay in the main process (electron/keyring.mjs); this only
 * asks for passwords and shows the recovery key once.
 */
export function SecurityPanel() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: SECURITY_STATUS_KEY, queryFn: () => desktop?.security.status() ?? null, staleTime: Infinity });
  const { data: session } = useSession();
  const [busy, setBusy] = useState(false);
  const [shownKey, setShownKey] = useState<string | null>(null);

  if (!desktop) {
    return (
      <section className="glass-panel space-y-2 p-5">
        <div className="flex items-center gap-2 font-display font-extrabold tracking-tight"><ShieldCheck className="h-4 w-4" /> Security</div>
        <p className="text-sm text-muted-foreground">Encryption on the device and the app password are part of the desktop app. In a browser, the data is kept in this browser's own storage for this site.</p>
      </section>
    );
  }
  const s = status.data;
  if (!s) return null;
  const { security } = desktop;

  const update = (next: SecurityStatus) => queryClient.setQueryData(SECURITY_STATUS_KEY, next);
  /** Asks for the current password when there is one (null: cancelled). */
  const current = async (title: string): Promise<string | null | undefined> => {
    if (!s.password) return null;
    const r = await askPassword({ mode: "enter", title, detail: "Type the current app password to confirm.", action: "Continue" });
    return r && "password" in r ? r.password : undefined;
  };
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setPassword = () => act(async () => {
    const now = await current("Change the app password");
    if (now === undefined) return;
    const r = await askPassword({
      mode: "set", required: true, action: "Set password",
      title: s.password ? "New app password" : "Set an app password",
      detail: "Asked each time the app starts. Without it (or the recovery key you'll be given next), nobody can open this computer's payroll data, not even you.",
    });
    if (!r || !("password" in r)) return;
    const { status: next, recoveryKey } = await security.setPassword(now, r.password);
    update(next);
    if (recoveryKey) setShownKey(recoveryKey);
    else toast.success(s.password ? "Password changed." : "Password set. Your recovery key from before still works.");
  });

  const removePassword = () => act(async () => {
    const now = await current("Remove the app password");
    if (!now) return;
    update(await security.removePassword(now));
    toast.success("Password removed. The data stays encrypted; Windows unlocks it for your account when the app starts.");
  });

  const newRecoveryKey = () => act(async () => {
    if (s.recovery && !confirm("Make a new recovery key? The old one stops working.")) return;
    const now = await current("Make a new recovery key");
    if (now === undefined) return;
    const { status: next, recoveryKey } = await security.newRecoveryKey(now);
    update(next);
    setShownKey(recoveryKey);
  });

  const toggleCloud = () => act(async () => {
    if (s.cloud) {
      // Off here first: the cloud's copy is useless without this computer's wrap of the key.
      update(await security.disableCloudReset());
      await deleteEscrow(s.keyringId!).catch(() => toast.warning("Email reset is off on this computer; the cloud's copy of its reset key couldn't be removed right now."));
      toast.success("Email reset turned off.");
      return;
    }
    if (!confirm("Turn on email reset?\n\nIf you forget the app password, a code emailed to your cloud account will unlock this computer's data. That makes the data as safe as that email account: anyone who can read its mail and has this computer could open it.")) return;
    const now = await current("Turn on email reset");
    if (now === undefined) return;
    const { status: next, escrowKey } = await security.enableCloudReset(now);
    try {
      const { name } = await deviceIdentity(await localDb());
      await uploadEscrow(next.keyringId!, escrowKey, name);
    } catch (e) {
      update(await security.disableCloudReset());
      throw new Error(`Email reset couldn't be turned on: ${(e as Error).message}`);
    }
    update(next);
    toast.success("Email reset is on.");
  });

  const line = [
    s.encrypted ? "Encrypted on this computer" : "Not encrypted yet",
    s.password ? "app password on" : "no app password",
    s.recovery ? "recovery key made" : null,
    s.cloud ? "email reset on" : null,
  ].filter(Boolean).join(" · ");

  return (
    <section className="glass-panel space-y-3 p-5">
      <div className="flex items-center gap-2 font-display font-extrabold tracking-tight"><ShieldCheck className="h-4 w-4" /> Security</div>
      <p className="text-sm">{line}</p>
      {s.encryptError && <p className="text-sm text-destructive">Couldn't encrypt the data yet: {s.encryptError}. The app tries again each time it starts.</p>}
      <p className="text-xs text-muted-foreground">
        The payroll database and the automatic backups in the app's folder are encrypted. {s.password
          ? "The app password is asked when the app starts; without it or the recovery key, nobody can read them."
          : "Without an app password, Windows unlocks them for your account, so someone who signs in as you can open the app. Add a password to require it at start."}
      </p>
      <div className="flex flex-wrap gap-2">
        <button className={btnPrimary} disabled={busy} onClick={setPassword}>{s.password ? "Change password" : "Set an app password"}</button>
        {s.password && <button className={btnGhost} disabled={busy} onClick={removePassword}>Remove password</button>}
        <button className={btnGhost} disabled={busy} onClick={newRecoveryKey}>{s.recovery ? "Make a new recovery key" : "Make a recovery key"}</button>
        {cloudConfigured && session?.user && (
          <button className={btnGhost} disabled={busy} onClick={toggleCloud}>{s.cloud ? "Turn off email reset" : "Turn on email reset"}</button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Not covered: files you download or export (backup files have their own password), and the app's display settings, saved timesheet templates and cloud sign-in on this computer.
        Encryption protects the data when the app is closed; while it's open, anything running as you can see what the app shows. For the whole disk, turn on BitLocker or Device encryption in Windows.
        {s.justEncrypted && " Copies of the data from before encryption may remain on the disk until it's reused; folders named database-damaged-… from before also stay unencrypted."}
      </p>
      {shownKey && <RecoveryKeyDialog recoveryKey={shownKey} onDone={() => setShownKey(null)} />}
    </section>
  );
}

/** Shows the recovery key once. Closing needs its last group typed back, so it isn't dismissed unsaved. */
function RecoveryKeyDialog({ recoveryKey, onDone }: { recoveryKey: string; onDone: () => void }) {
  const [typed, setTyped] = useState("");
  const lastGroup = recoveryKey.split("-").at(-1)!;
  const confirmed = typed.trim().toUpperCase() === lastGroup;
  const copy = async () => {
    await navigator.clipboard.writeText(recoveryKey);
    toast.success("Copied. Paste it somewhere safe, then clear it from wherever you pasted it temporarily.");
  };
  const save = () => downloadBlob(
    new Blob([`Meridian Payroll recovery key\r\n\r\n${recoveryKey}\r\n\r\nUnlocks this computer's payroll data if the app password is forgotten. Keep it away from the computer.\r\n`], { type: "text/plain" }),
    "meridian-recovery-key.txt",
  );
  return (
    <Dialog open onOpenChange={() => { /* closes only through Done */ }}>
      <DialogContent onEscapeKeyDown={(e) => e.preventDefault()} onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Save your recovery key</DialogTitle>
          <DialogDescription>
            If you forget the app password, this key is the only way back in (besides email reset, if you turn it on). It's shown once.
            Write it down or print it and keep it somewhere other than this computer.
          </DialogDescription>
        </DialogHeader>
        <div className="select-all rounded-xl bg-secondary p-4 text-center font-mono text-lg tracking-wider ring-1 ring-border">{recoveryKey}</div>
        <div className="flex flex-wrap gap-2">
          <button className={btnGhost} onClick={copy}><Copy className="mr-1 inline h-4 w-4" />Copy</button>
          <button className={btnGhost} onClick={save}><Download className="mr-1 inline h-4 w-4" />Save as a text file</button>
        </div>
        <label className="block space-y-1 text-sm">
          <span className="text-muted-foreground">To check you have it, type its last 4 characters:</span>
          <input className={`${inputCls} font-mono uppercase`} value={typed} onChange={(e) => setTyped(e.target.value)} />
        </label>
        <div className="flex justify-end">
          <button className={btnPrimary} disabled={!confirmed} onClick={onDone}>Done</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
