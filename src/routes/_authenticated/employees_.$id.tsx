import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { db } from "@/lib/db/mode";
import { AppShell } from "@/components/AppShell";
import { ProfileForm, profileValues, type ProfileValues } from "@/components/ProfileForm";
import { fullName, useEmployees, useShifts } from "@/lib/payroll";
import { shiftFor } from "@/lib/pay";
import { EMPLOYEE_SECTIONS as sections } from "@/lib/employee-fields";
import { ArrowLeft } from "lucide-react";

export const Route = createFileRoute("/_authenticated/employees_/$id")({
  head: () => ({ meta: [{ title: "Employee profile — Meridian Payroll" }] }),
  component: ProfilePage,
  notFoundComponent: () => <div className="p-8">Employee not found.</div>,
  errorComponent: ({ error }) => <div className="p-8">{(error as Error).message}</div>,
});

const required = ["employee_code", "first_name", "last_name"];

function ProfilePage() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const { data: employees = [], isLoading } = useEmployees();
  const emp = employees.find((e) => e.id === id);
  const { data: shifts = [] } = useShifts();
  const source = useMemo(() => (emp ? profileValues(emp) : null), [emp]);

  if (isLoading) return <AppShell eyebrow="Profile" title="Loading…"><div /></AppShell>;
  if (!emp) return <AppShell eyebrow="Profile" title="Not found"><Link to="/employees" className="underline">Back to employees</Link></AppShell>;

  const save = async ({ form, custom }: ProfileValues) => {
    for (const k of required) if (!form[k]?.trim()) { toast.error("Employee ID, first and last name are required"); return; }
    const rate = Number(form["hourly_rate"]);
    if (!Number.isFinite(rate) || rate < 0) { toast.error("Hourly rate must be a positive number"); return; }
    const row: Record<string, string | number | null> = {};
    for (const s of sections) for (const f of s.fields) row[f.k] = form[f.k]?.trim() || null;
    row["hourly_rate"] = rate;
    row["notes"] = form["notes"]?.trim() || null;
    row["shift_id"] = form["shift_id"] || shiftFor(null, shifts).id;
    row["pay_type"] = form["pay_type"] === "salary" ? "salary" : "hourly";
    (row as Record<string, unknown>)["active"] = form["active"] !== "false";
    const cf: Record<string, string> = {};
    for (const [k, v] of Object.entries(custom)) if (v.trim()) cf[k] = v.trim().slice(0, 1000);
    (row as Record<string, unknown>)["custom_fields"] = cf;
    const { error } = await db().update("employees", id, row as never);
    if (error) { toast.error(error.message); return; }
    toast.success("Profile saved");
    qc.invalidateQueries({ queryKey: ["employees"] });
  };

  return (
    <AppShell eyebrow="Profile" title={fullName(emp)}>
      <div className="flex items-center justify-between gap-3">
        <Link to="/employees" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> All employees</Link>
        <Link to="/timesheet" search={{ employee: emp.id }} className="text-sm text-muted-foreground underline hover:text-foreground">View timesheet</Link>
      </div>
      <ProfileForm source={source} employees={employees} submitLabel="Save profile" onSave={save} />
    </AppShell>
  );
}
