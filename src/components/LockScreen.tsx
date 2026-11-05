import { useState } from "react";
import { btnGhost, btnPrimary, inputCls } from "@/components/AppShell";
import { ThemeToggle } from "@/components/ThemeToggle";
import { MIN_PASSWORD_LENGTH } from "@/lib/backup-crypto";
import { cloudConfigured } from "@/lib/db/mode";
import { desktop, type SecurityStatus } from "@/lib/desktop";
import { escrowWithCode, sendResetCode } from "@/lib/key-escrow";

type Step = "password" | "recovery" | "email" | "start-over";

/**
 * Shown at start when the payroll data's key is locked (an app password is set, or Windows couldn't unlock it),
 * or can't be used at all. Every way in ends in the main process (electron/main.mjs), which checks it and slows
 * down after wrong guesses; this screen only collects what the user types.
 */
export function LockScreen({ status, onUnlocked }: { status: SecurityStatus; onUnlocked: (s: SecurityStatus) => void }) {
  const broken = status.state === "error";
  const [step, setStep] = useState<Step>(broken ? "start-over" : status.password ? "password" : status.recovery ? "recovery" : status.cloud ? "email" : "start-over");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const attempt = async (fn: () => Promise<SecurityStatus>) => {
    setBusy(true);
    setProblem(null);
    try {
      onUnlocked(await fn());
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const go = (s: Step) => { setStep(s); setProblem(null); };

  const ways = [
    status.password && step !== "password" && <button key="p" className="hover:text-foreground" onClick={() => go("password")}>Use the password</button>,
    status.recovery && step !== "recovery" && <button key="r" className="hover:text-foreground" onClick={() => go("recovery")}>Use the recovery key</button>,
    status.cloud && cloudConfigured && step !== "email" && <button key="e" className="hover:text-foreground" onClick={() => go("email")}>Reset by email</button>,
    step !== "start-over" && <button key="s" className="hover:text-foreground" onClick={() => go("start-over")}>None of these work</button>,
  ].filter(Boolean);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-6">
      <div className="absolute right-6 top-6"><ThemeToggle /></div>
      <div className="glass-panel anim-rise relative w-full max-w-md space-y-4 p-7">
        <div>
          <div className="label-mono">KoPayroll</div>
          <h1 className="mt-1 font-display text-2xl font-extrabold tracking-tight">{broken ? "The data's key can't be used" : "Locked"}</h1>
          {broken && <p className="mt-2 text-sm text-muted-foreground">{status.error}</p>}
          {!broken && status.deviceFailed && (
            <p className="mt-2 text-sm text-muted-foreground">Windows couldn't unlock this computer's payroll data. This happens when the app's folder was copied from another computer or Windows account. Use the recovery key{status.cloud ? " or reset by email" : ""}.</p>
          )}
        </div>

        {step === "password" && <PasswordStep busy={busy} onSubmit={(pw) => attempt(() => desktop!.security.unlock(pw))} />}
        {step === "recovery" && <RecoveryStep busy={busy} hadPassword={status.password} onSubmit={(key, pw) => attempt(() => desktop!.security.recover(key, pw))} />}
        {step === "email" && <EmailStep busy={busy} setBusy={setBusy} setProblem={setProblem} hadPassword={status.password}
          onEscrow={(escrow, pw) => attempt(() => desktop!.security.recoverWithCloud(escrow, pw))} keyringId={status.keyringId!} />}
        {step === "start-over" && <StartOver broken={broken} busy={busy} onConfirm={() => attempt(() => desktop!.security.startOver())} />}

        {problem && <p className="text-sm text-destructive">{problem}</p>}
        {ways.length > 0 && <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">{ways}</div>}
      </div>
    </div>
  );
}

function PasswordStep({ busy, onSubmit }: { busy: boolean; onSubmit: (pw: string) => void }) {
  const [pw, setPw] = useState("");
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (pw) onSubmit(pw); }}>
      <input className={inputCls} type="password" autoFocus autoComplete="current-password" placeholder="App password" value={pw} onChange={(e) => setPw(e.target.value)} />
      <button disabled={busy || !pw} className={`${btnPrimary} w-full`}>{busy ? "Checking…" : "Unlock"}</button>
    </form>
  );
}

/** A new password, typed twice; empty means none (the app then opens without asking). */
function NewPassword({ value, onChange, hadPassword }: { value: { pw: string; again: string }; onChange: (v: { pw: string; again: string }) => void; hadPassword: boolean }) {
  return (
    <div className="space-y-2">
      <input className={inputCls} type="password" autoComplete="new-password" placeholder="New app password" value={value.pw} onChange={(e) => onChange({ ...value, pw: e.target.value })} />
      <input className={inputCls} type="password" autoComplete="new-password" placeholder="Type it again" value={value.again} onChange={(e) => onChange({ ...value, again: e.target.value })} />
      <p className="text-xs text-muted-foreground">{hadPassword ? "Leave both empty to open without a password from now on." : "Optional: leave both empty to keep opening without a password."}</p>
    </div>
  );
}
const passwordProblem = ({ pw, again }: { pw: string; again: string }) =>
  !pw && !again ? null : pw.length < MIN_PASSWORD_LENGTH ? `The new password needs at least ${MIN_PASSWORD_LENGTH} characters.` : pw !== again ? "The two passwords don't match." : null;

function RecoveryStep({ busy, hadPassword, onSubmit }: { busy: boolean; hadPassword: boolean; onSubmit: (key: string, pw: string | null) => void }) {
  const [key, setKey] = useState("");
  const [next, setNext] = useState({ pw: "", again: "" });
  const problem = passwordProblem(next);
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (key && !problem) onSubmit(key, next.pw || null); }}>
      <p className="text-sm text-muted-foreground">Type the recovery key you saved when you set the password: 32 letters and digits, in groups of 4.</p>
      <input className={`${inputCls} font-mono uppercase`} autoFocus spellCheck={false} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" value={key} onChange={(e) => setKey(e.target.value)} />
      <NewPassword value={next} onChange={setNext} hadPassword={hadPassword} />
      {problem && <p className="text-sm text-destructive">{problem}</p>}
      <button disabled={busy || !key || !!problem} className={`${btnPrimary} w-full`}>{busy ? "Checking…" : "Unlock"}</button>
    </form>
  );
}

function EmailStep({ busy, setBusy, setProblem, hadPassword, keyringId, onEscrow }: {
  busy: boolean; setBusy: (b: boolean) => void; setProblem: (p: string | null) => void; hadPassword: boolean; keyringId: string;
  onEscrow: (escrow: string, pw: string | null) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [next, setNext] = useState({ pw: "", again: "" });
  const problem = passwordProblem(next);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await sendResetCode(email.trim());
      setSent(true);
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const unlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (problem) return;
    setBusy(true);
    setProblem(null);
    let escrow: string;
    try {
      escrow = await escrowWithCode(email.trim(), code, keyringId);
    } catch (err) {
      setProblem((err as Error).message);
      setBusy(false);
      return;
    }
    setBusy(false);
    await onEscrow(escrow, next.pw || null);
  };

  if (!sent) {
    return (
      <form className="space-y-3" onSubmit={send}>
        <p className="text-sm text-muted-foreground">We'll email a sign-in code to your cloud account's address.</p>
        <input className={inputCls} type="email" required autoFocus placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button disabled={busy || !email} className={`${btnPrimary} w-full`}>{busy ? "Sending…" : "Email me a code"}</button>
      </form>
    );
  }
  return (
    <form className="space-y-3" onSubmit={unlock}>
      <p className="text-sm text-muted-foreground">Type the code from the email sent to {email}.</p>
      <input className={`${inputCls} font-mono tracking-widest`} autoFocus inputMode="numeric" autoComplete="one-time-code" placeholder="Code" value={code} onChange={(e) => setCode(e.target.value)} />
      <NewPassword value={next} onChange={setNext} hadPassword={hadPassword} />
      {problem && <p className="text-sm text-destructive">{problem}</p>}
      <div className="flex gap-2">
        <button type="button" className={btnGhost} onClick={() => setSent(false)}>Back</button>
        <button disabled={busy || !code || !!problem} className={`${btnPrimary} flex-1`}>{busy ? "Checking…" : "Unlock"}</button>
      </div>
    </form>
  );
}

const START_OVER_WORD = "START OVER";

function StartOver({ broken, busy, onConfirm }: { broken: boolean; busy: boolean; onConfirm: () => void }) {
  const [typed, setTyped] = useState("");
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (typed.trim().toUpperCase() === START_OVER_WORD) onConfirm(); }}>
      <p className="text-sm text-muted-foreground">
        {broken
          ? "If you have a copy of keyring.json (for example in a copy of the app's folder), put it back in the app's folder and start the app again. Without it, this computer's payroll data can't be opened: not by the app, not by anyone."
          : "Without the password, the recovery key or email reset, this computer's payroll data can't be opened: not by the app, not by anyone."}{" "}
        You can start again with no data and restore a backup file you downloaded (Sync & backup → Restore from file), or pull your data from the cloud.
      </p>
      <p className="text-xs text-muted-foreground">
        Nothing is deleted: the locked data and its key file are moved aside in the app's folder (<code>database-locked-…</code> and <code>keyring-….json</code>) and kept.
      </p>
      <input className={inputCls} placeholder={`Type ${START_OVER_WORD} to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} />
      <button disabled={busy || typed.trim().toUpperCase() !== START_OVER_WORD} className={`${btnGhost} w-full`}>Start again with no data</button>
    </form>
  );
}
