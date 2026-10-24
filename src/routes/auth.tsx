import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { btnPrimary, inputCls } from "@/components/AppShell";
import { ThemeToggle } from "@/components/ThemeToggle";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — Meridian Payroll" },
      { name: "description", content: "Sign in to manage payroll or view your hours and pay." },
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
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/dashboard" });
    });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => {
      if (s) navigate({ to: "/dashboard" });
    });
    return () => data.subscription.unsubscribe();
  }, [navigate]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const { error } =
      mode === "in"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin + "/auth" } });
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    if (mode === "up") toast.success("Check your email to confirm your account.");
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-6">
      <div className="anim-breathe pointer-events-none fixed -left-40 -top-48 h-[42rem] w-[42rem] rounded-full bg-glow-a blur-3xl" />
      <div className="anim-breathe pointer-events-none fixed -right-52 top-1/3 h-[40rem] w-[40rem] rounded-full bg-glow-b blur-3xl" />
      <div className="absolute right-6 top-6"><ThemeToggle /></div>
      <div className="glass-panel anim-rise relative w-full max-w-sm p-7">
        <div className="label-mono">Meridian Payroll</div>
        <h1 className="mt-1 font-display text-2xl font-extrabold tracking-tight">{mode === "in" ? "Sign in" : "Create account"}</h1>
        <p className="mt-1 text-xs text-muted-foreground">The first account becomes the payroll admin. Employees sign up with the email on their record.</p>
        <form onSubmit={submit} className="mt-5 space-y-3">
          <input className={inputCls} type="email" required placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className={inputCls} type="password" required minLength={6} placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button disabled={busy} className={`${btnPrimary} w-full`}>{mode === "in" ? "Sign in" : "Sign up"}</button>
        </form>
        <button onClick={() => setMode(mode === "in" ? "up" : "in")} className="mt-4 w-full text-center text-xs text-muted-foreground hover:text-foreground">
          {mode === "in" ? "No account? Sign up" : "Have an account? Sign in"}
        </button>
      </div>
    </div>
  );
}
