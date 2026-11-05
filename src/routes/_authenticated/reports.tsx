import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { EmployeePicker, SearchInput } from "@/components/EmployeeSearch";
import { EmployeeLink } from "@/components/EmployeeLink";
import { ReportChart } from "@/components/ReportChart";
import { describeEmployeeFilter, isFiltering, matchesEmployee, NO_FILTER, type EmployeeFilter } from "@/lib/employee-search";
import { fullName, useEmployees } from "@/lib/payroll";

/** `?emp=<id>` opens the report on one person (the profile's "Open in Reports" does). */
type ReportsSearch = { emp?: string };

export const Route = createFileRoute("/_authenticated/reports")({
  head: () => ({ meta: [{ title: "Reports — KoPayroll" }] }),
  validateSearch: (s: Record<string, unknown>): ReportsSearch => (typeof s["emp"] === "string" && s["emp"] ? { emp: s["emp"] } : {}),
  component: ReportsPage,
});

function ReportsPage() {
  const search = Route.useSearch();
  const { data: employees = [] } = useEmployees();
  const [scope, setScope] = useState<"all" | "one">(search.emp ? "one" : "all");
  const [person, setPerson] = useState(search.emp ?? "");
  const [q, setQ] = useState<EmployeeFilter>(NO_FILTER);
  // A link to someone's report while this page is already open switches to them.
  useEffect(() => { if (search.emp) { setScope("one"); setPerson(search.emp); } }, [search.emp]);
  const picked = employees.find((e) => e.id === person);
  // Everyone, everyone the filter matches, or one person.
  const ids = scope === "one" ? (person ? [person] : []) : isFiltering(q) ? employees.filter((e) => matchesEmployee(e, q)).map((e) => e.id) : undefined;

  const tab = (v: "all" | "one", label: string) => (
    <button type="button" onClick={() => setScope(v)}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ring-border ${scope === v ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`}>
      {label}
    </button>
  );
  return (
    <AppShell eyebrow="Reports" title="Pay and hours over time">
      <div className="glass-panel flex flex-wrap items-center gap-3 px-5 py-3">
        <span className="label-mono">Who</span>
        {tab("all", "Everyone")}
        {tab("one", "One person")}
        {scope === "all"
          ? <SearchInput value={q} onChange={setQ} employees={employees} placeholder="Narrow by name, department, position…" className="min-w-[16rem] flex-1" />
          : <EmployeePicker employees={employees} value={person} onChange={setPerson} className="min-w-[16rem] max-w-md flex-1" />}
        {scope === "one" && picked && <EmployeeLink id={picked.id} name={`${fullName(picked)}'s profile`} className="text-sm text-muted-foreground" />}
      </div>
      {scope === "all" && isFiltering(q) && <p className="text-xs text-muted-foreground">{ids?.length ?? 0} people matching {describeEmployeeFilter(q)}.</p>}
      {scope === "one" && !person
        ? <div className="glass-panel px-5 py-10 text-center text-sm text-muted-foreground">Pick someone to see their pay and hours.</div>
        : <ReportChart key={scope} prefKey={scope === "one" ? "reports-person" : "reports"} employeeIds={ids} single={scope === "one"}
            subject={scope === "one" ? (picked ? fullName(picked) : undefined) : isFiltering(q) ? `${ids?.length ?? 0} people matching ${describeEmployeeFilter(q)}` : "Everyone"} />}
    </AppShell>
  );
}
