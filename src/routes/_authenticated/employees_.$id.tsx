import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { EmployeeProfile, PROFILE_TABS, type ProfileTab } from "@/components/EmployeeProfile";
import { SkeletonBlock } from "@/components/Loading";
import { fullName, useEmployees } from "@/lib/payroll";
import { ArrowLeft } from "lucide-react";

/** `?tab=` opens the profile on a tab, so going back (or a link) returns to the one you were on. */
type ProfileSearch = { tab?: ProfileTab };

export const Route = createFileRoute("/_authenticated/employees_/$id")({
  head: () => ({ meta: [{ title: "Employee profile — KoPayroll" }] }),
  validateSearch: (s: Record<string, unknown>): ProfileSearch => (typeof s["tab"] === "string" && s["tab"] in PROFILE_TABS && s["tab"] !== "details" ? { tab: s["tab"] as ProfileTab } : {}),
  component: ProfilePage,
  notFoundComponent: () => <div className="p-8">Employee not found.</div>,
  errorComponent: ({ error }) => <div className="p-8">{(error as Error).message}</div>,
});

function ProfilePage() {
  const { id } = Route.useParams();
  const tab = Route.useSearch().tab ?? "details";
  const navigate = useNavigate({ from: Route.fullPath });
  const { data: employees = [], isLoading } = useEmployees();
  const emp = employees.find((e) => e.id === id);

  if (isLoading) return <AppShell eyebrow="Profile" title="Loading…"><SkeletonBlock className="h-96 w-full rounded-2xl" /></AppShell>;
  if (!emp) return <AppShell eyebrow="Profile" title="Not found"><Link to="/employees" className="underline">Back to employees</Link></AppShell>;

  return (
    <AppShell eyebrow="Profile" title={fullName(emp)}>
      <div className="flex items-center justify-between gap-3">
        <Link to="/employees" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> All employees</Link>
        <Link to="/timesheet" search={{ employee: emp.id }} className="text-sm text-muted-foreground underline hover:text-foreground">View timesheet</Link>
      </div>
      {/* The tab is in the address (replace: switching tabs isn't a step for Back). */}
      <EmployeeProfile emp={emp} employees={employees} tab={tab}
        onTab={(t) => navigate({ search: t === "details" ? {} : { tab: t }, replace: true })} />
    </AppShell>
  );
}
