import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { cloudConfigured } from "@/lib/db/mode";
import { desktop } from "@/lib/desktop";
import { btnPrimary, inputCls } from "@/components/AppShell";
import { ThemeToggle } from "@/components/ThemeToggle";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — Meridian Payroll" },
      { name: "description", content: "Sign in to sync your payroll data between devices." },
      { property: "og:title", content: "Sign in — Meridian Payroll" },
      { property: "og:description", content: "Access your payroll ledger." },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!cloudConfigured) return;
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/sync" });
    });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => {
      if (s) navigate({ to: "/sync" });
    });
    return () => data.subscription.unsubscribe();
  }, [navigate]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const { error } =
      mode === "in"
        ? await supabase.auth.signInWithPassword({ email, password })
        // The desktop app's address can't be opened from an email, so its confirmation link goes to the project's Site URL.
        : await supabase.auth.signUp({ email, password, options: desktop ? {} : { emailRedirectTo: window.location.origin + "/sync" } });
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    if (mode === "up") toast.success(desktop ? "Check your email and confirm your account, then sign in here." : "Check your email to confirm your account.");
  };

  // Needs the Google provider enabled in the Supabase dashboard (Authentication → Providers).
  const google = async () => {
    const { error } = await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin + "/sync" } });
    if (error) toast.error(error.message);
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-6">
      <div className="anim-breathe pointer-events-none fixed -left-40 -top-48 h-[42rem] w-[42rem] rounded-full bg-glow-a blur-3xl" />
      <div className="anim-breathe pointer-events-none fixed -right-52 top-1/3 h-[40rem] w-[40rem] rounded-full bg-glow-b blur-3xl" />
      <div className="absolute right-6 top-6"><ThemeToggle /></div>
      <div className="glass-panel anim-rise relative w-full max-w-sm p-7">
        <div className="label-mono">Meridian Payroll</div>
        <h1 className="mt-1 font-display text-2xl font-extrabold tracking-tight">{mode === "in" ? "Sign in to sync" : "Create account"}</h1>
        <p className="mt-1 text-xs text-muted-foreground">Optional. An account lets you push your payroll data to the cloud and pull it onto other devices. The app works fully without one.</p>
        {!cloudConfigured && <p className="mt-3 text-xs text-destructive">Cloud sync isn't set up on this install (no Supabase settings in .env).</p>}
        <form onSubmit={submit} className="mt-5 space-y-3">
          <input className={inputCls} type="email" required placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className={inputCls} type="password" required minLength={6} placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button disabled={busy || !cloudConfigured} className={`${btnPrimary} w-full`}>{mode === "in" ? "Sign in" : "Sign up"}</button>
        </form>
        {/* Google sends the user back to a web address, which can't reach the desktop app. */}
        {!desktop && (
          <button onClick={google} disabled={!cloudConfigured} className="mt-3 w-full rounded-xl bg-secondary px-4 py-2 text-sm font-medium ring-1 ring-border hover:bg-accent disabled:opacity-50">
            Continue with Google
          </button>
        )}
        <button onClick={() => setMode(mode === "in" ? "up" : "in")} className="mt-4 w-full text-center text-xs text-muted-foreground hover:text-foreground">
          {mode === "in" ? "No account? Sign up" : "Have an account? Sign in"}
        </button>
        <Link to="/dashboard" className="mt-2 block text-center text-xs text-muted-foreground hover:text-foreground">Continue without an account</Link>
      </div>
    </div>
  );
}
