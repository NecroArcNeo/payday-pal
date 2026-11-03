import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/lib/payroll";
import { setDataMode, useDataMode } from "@/lib/db/mode";
import { usePref } from "@/lib/prefs";
import { ThemeToggle } from "./ThemeToggle";
import { EditableLabel } from "./EditableLabel";
import { UndoButtons } from "./UndoButtons";
import { Cloud, GripVertical, HardDrive, LogOut } from "lucide-react";
import { CommandPalette } from "./CommandPalette";

const adminNav = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/employees", label: "Employees" },
  { to: "/records", label: "Time records" },
  { to: "/timesheet", label: "Timesheet" },
  { to: "/import", label: "Import" },
  { to: "/payroll", label: "Payroll" },
  { to: "/reports", label: "Reports" },
  { to: "/sync", label: "Sync & backup" },
] as const;
type NavTo = (typeof adminNav)[number]["to"];

/** The nav in the order the user dragged it into (remembered on this device). Pages added later go at the end. */
function useNavOrder() {
  const [order, setOrder] = usePref<string[]>("meridian-nav-order", []);
  const rank = (to: string) => { const i = order.indexOf(to); return i === -1 ? order.length + adminNav.findIndex((n) => n.to === to) : i; };
  const items = [...adminNav].sort((a, b) => rank(a.to) - rank(b.to));
  /** Puts `from` where `to` is now. */
  const move = (from: NavTo, to: NavTo) => {
    if (from === to) return;
    const list: string[] = items.map((n) => n.to).filter((x) => x !== from);
    const at = list.indexOf(to) + (items.findIndex((n) => n.to === from) < items.findIndex((n) => n.to === to) ? 1 : 0);
    list.splice(at, 0, from);
    setOrder(list);
  };
  const customized = items.some((n, i) => n.to !== adminNav[i]!.to);
  return { items, move, customized, reset: () => setOrder([]) };
}

export function AppShell({ eyebrow, title, actions, children }: { eyebrow: string; title: string; actions?: ReactNode; children: ReactNode }) {
  const { data: session } = useSession();
  const mode = useDataMode();
  const email = session?.user?.email ?? "";
  const nav = useNavOrder();
  const [dragging, setDragging] = useState<NavTo | null>(null);
  const [over, setOver] = useState<NavTo | null>(null);

  // Only disconnects the cloud account; this device's data stays as it is.
  const signOut = async () => {
    setDataMode("local");
    await supabase.auth.signOut();
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
          <nav className="space-y-1 p-3" aria-label="Pages (drag to reorder, or Alt+↑/↓; double-click a name to rename it)">
            {nav.items.map((n, i) => (
              <Link
                key={n.to}
                to={n.to}
                draggable
                onDragStart={(e) => { setDragging(n.to); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", n.label); }}
                onDragOver={(e) => { if (!dragging) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOver(n.to); }}
                onDrop={(e) => { e.preventDefault(); if (dragging) nav.move(dragging, n.to); setDragging(null); setOver(null); }}
                onDragEnd={() => { setDragging(null); setOver(null); }}
                onKeyDown={(e) => {
                  if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                  e.preventDefault();
                  const other = nav.items[i + (e.key === "ArrowUp" ? -1 : 1)];
                  if (other) nav.move(n.to, other.to);
                }}
                title="Drag to reorder. Double-click the name to rename it."
                className={`group flex items-center justify-between rounded-xl px-3 py-2 text-sm text-foreground/80 hover:bg-secondary ${dragging === n.to ? "opacity-40" : ""} ${over === n.to && dragging && dragging !== n.to ? "ring-2 ring-primary/40" : ""}`}
                activeProps={{ className: "bg-accent font-medium !text-accent-foreground ring-1 ring-primary/15" }}
              >
                <span className="flex items-center gap-1.5">
                  <GripVertical className="-ml-1.5 h-3.5 w-3.5 cursor-grab text-muted-foreground/0 group-hover:text-muted-foreground" />
                  <EditableLabel k={`nav:${n.to}`} name={n.label} trigger="dblclick" />
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">0{i + 1}</span>
              </Link>
            ))}
            {nav.customized && (
              <button onClick={nav.reset} className="w-full px-3 pt-1 text-left text-[11px] text-muted-foreground hover:text-foreground">Reset tab order</button>
            )}
          </nav>
          <div className="mt-auto border-t border-border p-3">
            <div className="flex items-center gap-3 rounded-xl bg-secondary p-3 ring-1 ring-border">
              <div className="grid h-9 w-9 place-items-center rounded-full bg-accent font-display text-sm font-bold text-accent-foreground">
                {email ? email.slice(0, 2).toUpperCase() : <HardDrive className="h-4 w-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold leading-none">{email || "Local only"}</div>
                <div className="mt-1 text-[11px] text-muted-foreground">{email ? "Cloud account" : <Link to="/sync" className="underline">Sign in to sync</Link>}</div>
              </div>
              {email && (
                <button onClick={signOut} aria-label="Sign out" className="text-muted-foreground hover:text-foreground">
                  <LogOut className="h-4 w-4" />
                </button>
              )}
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
              <CommandPalette pages={nav.items} />
              <UndoButtons />
              <Link
                to="/sync"
                title={mode === "cloud" ? "Changes are saved straight to your cloud account" : "Changes are saved on this device"}
                className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium ring-1 ${mode === "cloud" ? "bg-primary/10 text-primary ring-primary/30" : "bg-secondary text-muted-foreground ring-border"}`}
              >
                {mode === "cloud" ? <Cloud className="h-3.5 w-3.5" /> : <HardDrive className="h-3.5 w-3.5" />}
                {mode === "cloud" ? "Editing cloud" : "This device"}
              </Link>
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
