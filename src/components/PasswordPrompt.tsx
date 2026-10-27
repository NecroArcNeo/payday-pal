import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { btnGhost, btnPrimary, inputCls } from "@/components/AppShell";
import { MIN_PASSWORD_LENGTH } from "@/lib/backup-crypto";
import { answerPassword, usePasswordRequest } from "@/lib/password-prompt";

/** The dialog behind askPassword(). Mounted once, in the root layout. */
export function PasswordPrompt() {
  const req = usePasswordRequest();
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [plain, setPlain] = useState(false);
  useEffect(() => { setPassword(""); setAgain(""); setPlain(false); }, [req]);
  if (!req) return null;

  const setting = req.mode === "set";
  const tooShort = password.length < MIN_PASSWORD_LENGTH;
  const mismatch = setting && again !== password;
  const problem = plain ? null : !password ? null : setting && tooShort ? `At least ${MIN_PASSWORD_LENGTH} characters.` : setting && again && mismatch ? "The two passwords don't match." : null;
  const ready = plain || (setting ? !tooShort && !mismatch : password.length > 0);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (ready) answerPassword(plain ? { plain: true } : { password });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) answerPassword(null); }}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{req.title}</DialogTitle>
            {req.detail && <DialogDescription>{req.detail}</DialogDescription>}
          </DialogHeader>
          {!plain && (
            <div className="space-y-2">
              <input className={inputCls} type="password" autoFocus autoComplete="new-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
              {setting && <input className={inputCls} type="password" autoComplete="new-password" placeholder="Type it again" value={again} onChange={(e) => setAgain(e.target.value)} />}
            </div>
          )}
          {(problem || req.error) && <p className="text-sm text-destructive">{problem ?? req.error}</p>}
          {setting && (
            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <input type="checkbox" className="mt-0.5" checked={plain} onChange={(e) => setPlain(e.target.checked)} />
              <span>Save without a password. Anyone who gets the file can read everything in it, including ID numbers.</span>
            </label>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className={btnGhost} onClick={() => answerPassword(null)}>Cancel</button>
            <button type="submit" className={btnPrimary} disabled={!ready}>{setting ? (plain ? "Save unprotected file" : "Save protected file") : "Open"}</button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
