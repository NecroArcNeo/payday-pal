// "Open where I left off": the page (with its address's settings) last shown is remembered on this device, and the
// app opens on it again instead of the Dashboard. Pages' own state that isn't in their address (Payroll's period,
// Time records' filters, Reports' choice of people) is kept by `useKeptState` (prefs.ts), checked with these.
import { ANY, NO_FILTER, type EmployeeFilter, type Facet } from "./employee-search";

export const LAST_PLACE = "meridian-last-place";

/** The app's own pages (and an employee's profile); never the landing page or anything outside the app. */
const PAGES = /^\/(dashboard|employees|employees\/[\w-]+|employees\/template|records|timesheet|import|payroll|reports|sync|history)(\?[^#]*)?$/;

export function placeWorthKeeping(href: unknown): href is string {
  return typeof href === "string" && href.length < 2000 && PAGES.test(href);
}

/** Where the app should open: the remembered page, when it started on the Dashboard (its default) and one is kept. */
export function placeToReopen(startedAt: string, remembered: unknown): string | null {
  return startedAt === "/dashboard" && placeWorthKeeping(remembered) && remembered !== startedAt ? remembered : null;
}

// ---- checks for kept state (an older version, or a hand-edited pref, must not break a page)

export const isDateOrEmpty = (v: unknown): v is string => v === "" || (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v));
export const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
export function validFacet(v: unknown): v is Facet {
  const f = v as Facet | null;
  return !!f && typeof f === "object" && strings(f.include) && strings(f.exclude);
}
export function validFilter(v: unknown): v is EmployeeFilter {
  const f = v as EmployeeFilter | null;
  return !!f && typeof f === "object" && typeof f.text === "string" && validFacet(f.department) && validFacet(f.position);
}
export { ANY, NO_FILTER };
