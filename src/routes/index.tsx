import { createFileRoute, Link } from "@tanstack/react-router";
import { ThemeToggle } from "@/components/ThemeToggle";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "KoPayroll — Employees, hours & pay" },
      { name: "description", content: "Store employee details, track clock-in or daily hours, import CSV/Excel timesheets and calculate pay." },
      { property: "og:title", content: "KoPayroll" },
      { property: "og:description", content: "Employees, work hours and pay in one live ledger." },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-6">
      <div className="anim-breathe pointer-events-none fixed -left-40 -top-48 h-[42rem] w-[42rem] rounded-full bg-glow-a blur-3xl" />
      <div className="anim-breathe pointer-events-none fixed -right-52 top-1/3 h-[40rem] w-[40rem] rounded-full bg-glow-b blur-3xl" />
      <div className="absolute right-6 top-6"><ThemeToggle /></div>
      <div className="anim-rise relative max-w-xl text-center">
        <div className="mx-auto mb-6 grid h-12 w-12 place-items-center rounded-2xl bg-primary font-display text-xl font-extrabold text-primary-foreground">K</div>
        <div className="label-mono">Payroll OS</div>
        <h1 className="mt-3 font-display text-5xl font-extrabold tracking-tight">Every hour, on the ledger.</h1>
        <p className="mt-4 text-muted-foreground">
          Keep employee records, log clock-in/out or daily hours, import timesheets from CSV or Excel, and see pay instantly.
        </p>
        <Link to="/dashboard" className="mt-8 inline-block rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/25 hover:bg-primary/90">
          Open the ledger
        </Link>
      </div>
    </div>
  );
}
