import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { db } from "@/lib/db/mode";
import { AppShell } from "@/components/AppShell";
import { ProfileForm, profileValues, type ProfileValues } from "@/components/ProfileForm";
import { useEmployeeDefaults, useEmployees } from "@/lib/payroll";
import { EMPLOYEE_SECTIONS as sections, PER_PERSON_FIELDS, type EmployeeDefaults } from "@/lib/employee-fields";
import { ArrowLeft } from "lucide-react";

export const Route = createFileRoute("/_authenticated/employees_/template")({
  head: () => ({ meta: [{ title: "Default profile — KoPayroll" }] }),
  component: TemplatePage,
});

/** The profile every new employee starts from, edited like an employee's own profile. */
function TemplatePage() {
  const qc = useQueryClient();
  const { data: employees = [] } = useEmployees();
  const { data: defaults, isLoading } = useEmployeeDefaults();
  const source = useMemo(() => (defaults ? profileValues(defaults) : null), [defaults]);

  const save = async ({ form, custom }: ProfileValues) => {
    const d: EmployeeDefaults = {};
    for (const s of sections) for (const f of s.fields) {
      const v = form[f.k]?.trim();
      if (v && !PER_PERSON_FIELDS.includes(f.k)) d[f.k] = v;
    }
    if (d["hourly_rate"] !== undefined) {
      const rate = Number(d["hourly_rate"]);
      if (!Number.isFinite(rate) || rate < 0 || rate > 10000) { toast.error("Hourly rate must be a number between 0 and 10,000"); return; }
      d["hourly_rate"] = rate;
    }
    if (d["email"] && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(d["email"]))) { toast.error("That default email isn't valid"); return; }
    if (form["notes"]?.trim()) d["notes"] = form["notes"].trim().slice(0, 2000);
    if (form["shift_id"]) d["shift_id"] = form["shift_id"];
    d["pay_type"] = form["pay_type"] === "salary" ? "salary" : "hourly";
    d["active"] = form["active"] !== "false";
    const cf: Record<string, string> = {};
    for (const [k, v] of Object.entries(custom)) if (v.trim()) cf[k] = v.trim().slice(0, 1000);
    if (Object.keys(cf).length) d.custom_fields = cf;
    const { error } = await db().saveEmployeeDefaults(d);
    if (error) { toast.error(error.message); return; }
    toast.success("Default profile saved. New employees start with these values.");
    qc.invalidateQueries({ queryKey: ["payroll-settings"] });
  };

  return (
    <AppShell eyebrow="Profile" title="Default profile">
      <div className="flex items-center justify-between gap-3">
        <Link to="/employees" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> All employees</Link>
      </div>
      <p className="text-sm text-muted-foreground">
        This is the profile every new employee starts with, whether you add them on the Employees page or import them. Anything you enter for a person
        (or that their import file has) replaces these values. Existing employees aren't changed.
      </p>
      {isLoading ? <div /> : <ProfileForm source={source} employees={employees} template submitLabel="Save default profile" onSave={save} />}
    </AppShell>
  );
}
