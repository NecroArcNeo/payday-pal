import type { Employee } from "@/lib/payroll";

// One search used everywhere an employee is looked up. Every word typed must
// appear somewhere in the employee's details, so "ware lead" finds a Lead in
// the Warehouse department, and "okafor" or "E100" find people directly.

const haystacks = new WeakMap<Employee, string>();

function haystack(e: Employee): string {
  let h = haystacks.get(e);
  if (h === undefined) {
    const custom = Object.values((e.custom_fields ?? {}) as Record<string, unknown>).map(String);
    h = [
      e.first_name, e.last_name, `${e.first_name} ${e.last_name}`, `${e.last_name}, ${e.first_name}`,
      e.employee_code, e.email, e.department, e.job_title, e.phone, e.phone?.replace(/\D/g, ""),
      e.city, e.state, e.country, e.gender, e.nationality, e.postal_code, e.active ? "active" : "inactive", ...custom,
    ].filter(Boolean).join(" \u0001 ").toLowerCase();
    haystacks.set(e, h);
  }
  return h;
}

const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

/** Typed text plus optional exact department and position (job title). Empty means "any". */
export type EmployeeFilter = { text: string; department: string; position: string };
export const NO_FILTER: EmployeeFilter = { text: "", department: "", position: "" };
/** Plain text is the same as a filter with only text. */
export type EmployeeQuery = string | EmployeeFilter;
const asFilter = (q: EmployeeQuery): EmployeeFilter => (typeof q === "string" ? { ...NO_FILTER, text: q } : q);

export const isFiltering = (q: EmployeeQuery) => { const f = asFilter(q); return !!(f.text.trim() || f.department || f.position); };

/** "“ada” in Warehouse as Lead", for messages like "No employee matches …". */
export function describeEmployeeFilter(q: EmployeeQuery) {
  const f = asFilter(q);
  return [f.text.trim() && `“${f.text.trim()}”`, f.department && `in ${f.department}`, f.position && `as ${f.position}`].filter(Boolean).join(" ");
}

export function matchesEmployee(e: Employee, query: EmployeeQuery): boolean {
  const f = asFilter(query);
  if (f.department && norm(e.department) !== norm(f.department)) return false;
  if (f.position && norm(e.job_title) !== norm(f.position)) return false;
  const ws = words(f.text);
  if (!ws.length) return true;
  const h = haystack(e);
  return ws.every((w) => h.includes(w));
}

/** Matching employees, best first: exact ID, then name starting with the query, then the rest by name. */
export function searchEmployees<T extends Employee>(list: T[], query: EmployeeQuery): T[] {
  const f = asFilter(query);
  const q = f.text.trim().toLowerCase();
  const hits = isFiltering(f) ? list.filter((e) => matchesEmployee(e, f)) : [...list];
  if (!q) return hits;
  const rank = (e: Employee) =>
    e.employee_code.toLowerCase() === q ? 0
    : `${e.first_name} ${e.last_name}`.toLowerCase().startsWith(q) || e.last_name.toLowerCase().startsWith(q) ? 1
    : 2;
  return hits.sort((a, b) => rank(a) - rank(b) || a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name));
}

/** The departments and positions in use, for the filter dropdowns. Case differences count as one. */
export function employeeFacets(list: Employee[]) {
  const unique = (vals: (string | null)[]) => {
    const seen = new Map<string, string>();
    for (const v of vals) if (v?.trim() && !seen.has(norm(v))) seen.set(norm(v), v.trim());
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  };
  return { departments: unique(list.map((e) => e.department)), positions: unique(list.map((e) => e.job_title)) };
}

export const SEARCH_HINT = "Search name, ID, position, department, email, phone…";
