import { Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/lib/payroll";
import { ThemeToggle } from "./ThemeToggle";
import { LogOut } from "lucide-react";

const adminNav = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/employees", label: "Employees" },
  { to: "/records", label: "Time records" },
  { to: "/import", label: "Import" },
  { to: "/payroll", label: "Payroll" },
] as const;

export function AppShell({ eyebrow, title, actions, children }: { eyebrow: string; title: string; actions?: ReactNode; children: ReactNode }) {
  const { data: session } = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const nav = session?.isAdmin ? adminNav : ([{ to: "/me", label: "My hours & pay" }] as const);
  const email = session?.user?.email ?? "";

  const signOut = async () => {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
      <div className="anim-breathe pointer-events-none fixed -left-40 -top-48 h-[42rem] w-[42rem] rounded-full bg-glow-a blur-3xl" />
      <div className="anim-breathe pointer-events-none fixed -right-52 top-1/3 h-[40rem] w-[40rem] rounded-full bg-glow-b blur-3xl" />

      <div className="relative flex min-h-screen">
        <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-glass backdrop-blur-xl md:flex">
          <div className="flex items-center gap-2 border-b border-border px-5 py-5">
            <div className="grid h-7 w-7 place-items-center rounded-lg bg-primary font-display text-sm font-extrabold text-primary-foreground">M</div>
            <div>
              <div className="font-display text-[15px] font-extrabold leading-none tracking-tight">Meridian</div>
              <div className="mt-1 font-mono text-[10px] tracking-widest text-muted-foreground">PAYROLL OS</div>
            </div>
          </div>
          <nav className="space-y-1 p-3">
            {nav.map((n, i) => (
              <Link
                key={n.to}
                to={n.to}
                className="flex items-center justify-between rounded-xl px-3 py-2 text-sm text-foreground/80 hover:bg-secondary"
                activeProps={{ className: "bg-accent font-medium !text-accent-foreground ring-1 ring-primary/15" }}
              >
                {n.label} <span className="font-mono text-[10px] text-muted-foreground">0{i + 1}</span>
              </Link>
            ))}
          </nav>
          <div className="mt-auto border-t border-border p-3">
            <div className="flex items-center gap-3 rounded-xl bg-secondary p-3 ring-1 ring-border">
              <div className="grid h-9 w-9 place-items-center rounded-full bg-accent font-display text-sm font-bold text-accent-foreground">
                {email.slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold leading-none">{email}</div>
                <div className="mt-1 text-[11px] text-muted-foreground">{session?.isAdmin ? "Payroll admin" : "Employee"}</div>
              </div>
              <button onClick={signOut} aria-label="Sign out" className="text-muted-foreground hover:text-foreground">
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-glass px-8 py-4 backdrop-blur-xl">
            <div>
              <div className="label-mono">{eyebrow}</div>
              <div className="font-display text-lg font-extrabold leading-tight tracking-tight">{title}</div>
            </div>
            <div className="flex items-center gap-3">
              {actions}
              <ThemeToggle />
            </div>
          </header>
          <div className="space-y-6 p-8">{children}</div>
        </main>
      </div>
    </div>
  );
}

export function StatCard({ label, value, sub, highlight, delay = 0 }: { label: string; value: string; sub?: string; highlight?: boolean; delay?: number }) {
  return (
    <div
      className={`anim-rise rounded-2xl p-4 backdrop-blur-xl ${highlight ? "bg-accent ring-1 ring-primary/20" : "glass-panel"}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className={`label-mono ${highlight ? "!text-accent-foreground" : ""}`}>{label}</div>
      <div className={`mt-1 font-display text-2xl font-extrabold tracking-tight ${highlight ? "text-accent-foreground" : ""}`}>{value}</div>
      {sub && <div className={`mt-1 text-[11px] ${highlight ? "text-accent-foreground/80" : "text-muted-foreground"}`}>{sub}</div>}
    </div>
  );
}

export const btnPrimary =
  "rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/25 hover:bg-primary/90 disabled:opacity-50 transition-colors";
export const btnGhost =
  "rounded-xl bg-secondary px-3 py-2 text-sm font-medium ring-1 ring-border hover:text-foreground text-muted-foreground";
export const inputCls =
  "w-full rounded-xl bg-secondary px-3 py-2 text-sm ring-1 ring-border outline-none focus:ring-2 focus:ring-ring";
