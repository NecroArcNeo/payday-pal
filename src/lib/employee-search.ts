import type { Employee } from "@/lib/payroll";

// One search used everywhere an employee is looked up. Every word typed must
// appear somewhere in the employee's details, so "ware lead" finds a Lead in
// the Warehouse department, and "okafor" or "E100" find people directly.
// A word starting with "-" leaves out anyone it appears for: "ware -temp".

const haystacks = new WeakMap<Employee, string>();

function haystack(e: Employee): string {
  let h = haystacks.get(e);
  if (h === undefined) {
    const custom = Object.values((e.custom_fields ?? {}) as Record<string, unknown>).map(String);
    h = [
      e.first_name, e.last_name, `${e.first_name} ${e.last_name}`, `${e.last_name}, ${e.first_name}`,
      e.employee_code, e.email, e.department, e.job_title, e.phone, e.phone?.replace(/\D/g, ""),
      e.city, e.state, e.country, e.gender, e.nationality, e.residential_status, e.postal_code, e.active ? "active" : "resigned inactive", ...custom,
    ].filter(Boolean).join(" \u0001 ").toLowerCase();
    haystacks.set(e, h);
  }
  return h;
}

const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
/** The typed words to find, and the "-word"s to leave out (a lone "-" is neither). */
const terms = (q: string) => {
  const all = words(q);
  return { want: all.filter((w) => !w.startsWith("-")), not: all.filter((w) => w.startsWith("-") && w.length > 1).map((w) => w.slice(1)) };
};
const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

/** Ticked values (match any of them; none ticked means any) and excluded ones (match none of them). */
export type Facet = { include: string[]; exclude: string[] };
export const ANY: Facet = { include: [], exclude: [] };
export const facetActive = (f: Facet) => f.include.length > 0 || f.exclude.length > 0;
/** Whether a value passes the facet, ignoring case and surrounding spaces. */
export function facetAllows(f: Facet, value: string | null | undefined) {
  const v = norm(value);
  if (f.include.length && !f.include.some((x) => norm(x) === v)) return false;
  return !f.exclude.some((x) => norm(x) === v);
}
/** "Warehouse or Sales, not Temp" */
export function describeFacet(f: Facet, names: (v: string) => string = (v) => v) {
  const or = (xs: string[]) => { const n = xs.map(names); return n.length > 1 ? `${n.slice(0, -1).join(", ")} or ${n[n.length - 1]}` : n[0] ?? ""; };
  return [f.include.length ? or(f.include) : "", f.exclude.length ? `not ${or(f.exclude)}` : ""].filter(Boolean).join(", ");
}

/** Typed text plus department and position (job title) checklists. Empty means "any". */
export type EmployeeFilter = { text: string; department: Facet; position: Facet };
export const NO_FILTER: EmployeeFilter = { text: "", department: ANY, position: ANY };
/** Plain text is the same as a filter with only text. */
export type EmployeeQuery = string | EmployeeFilter;
const asFilter = (q: EmployeeQuery): EmployeeFilter => (typeof q === "string" ? { ...NO_FILTER, text: q } : q);

const hasTerms = (text: string) => { const t = terms(text); return t.want.length + t.not.length > 0; };
export const isFiltering = (q: EmployeeQuery) => { const f = asFilter(q); return hasTerms(f.text) || facetActive(f.department) || facetActive(f.position); };

/** "“ada” in Warehouse as Lead, not Driver", for messages like "No employee matches …". */
export function describeEmployeeFilter(q: EmployeeQuery) {
  const f = asFilter(q);
  const facet = (x: Facet, word: string) => {
    const inc = x.include.length ? `${word} ${describeFacet({ include: x.include, exclude: [] })}` : "";
    const exc = x.exclude.length ? `not ${word} ${describeFacet({ include: x.exclude, exclude: [] })}` : "";
    return [inc, exc].filter(Boolean).join(", ");
  };
  return [f.text.trim() && `“${f.text.trim()}”`, facet(f.department, "in"), facet(f.position, "as")].filter(Boolean).join(" ");
}

export function matchesEmployee(e: Employee, query: EmployeeQuery): boolean {
  const f = asFilter(query);
  if (!facetAllows(f.department, e.department)) return false;
  if (!facetAllows(f.position, e.job_title)) return false;
  const { want, not } = terms(f.text);
  if (!want.length && !not.length) return true;
  const h = haystack(e);
  return want.every((w) => h.includes(w)) && !not.some((w) => h.includes(w));
}

/** Matching employees, best first: exact ID, then name starting with the query, then the rest by name. */
export function searchEmployees<T extends Employee>(list: T[], query: EmployeeQuery): T[] {
  const f = asFilter(query);
  const q = terms(f.text).want.join(" ");
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

export const SEARCH_HINT = "Search name, ID, position, department, email, phone… (-word leaves out)";
