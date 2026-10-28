import type { Employee, FieldDef } from "@/lib/payroll";

// The built-in employee details, grouped as the profile page shows them. Shared by the profile and the timesheet.
/** `sensitive` fields (everything under Personal) stay on the profile, and are left off timesheets and the payroll table and its exports. */
export type EmployeeField = { k: string; label: string; type?: string; span?: boolean; suggest?: boolean; sensitive?: boolean };
export const EMPLOYEE_SECTIONS: { title: string; fields: EmployeeField[] }[] = [
  { title: "Payroll", fields: [
    { k: "employee_code", label: "Employee ID" }, { k: "first_name", label: "First name" }, { k: "last_name", label: "Last name" },
    { k: "hourly_rate", label: "Hourly rate", type: "number" }, { k: "department", label: "Department" }, { k: "job_title", label: "Job title" },
  ] },
  { title: "Personal", fields: [
    { k: "date_of_birth", label: "Date of birth", type: "date", sensitive: true }, { k: "gender", label: "Gender", suggest: true, sensitive: true }, { k: "nationality", label: "Nationality", suggest: true, sensitive: true },
    { k: "passport_no", label: "Passport no.", sensitive: true }, { k: "ssn", label: "Social security no.", sensitive: true }, { k: "residential_status", label: "Residential status", suggest: true, sensitive: true },
  ] },
  { title: "Contact", fields: [
    { k: "email", label: "Email", type: "email" }, { k: "phone", label: "Phone", type: "tel" }, { k: "hire_date", label: "Hire date", type: "date" },
  ] },
  { title: "Address", fields: [
    { k: "address_line1", label: "Street address", span: true }, { k: "address_line2", label: "Apt / suite", span: true },
    { k: "city", label: "City" }, { k: "state", label: "State / region" }, { k: "postal_code", label: "Postal code" }, { k: "country", label: "Country" },
  ] },
  { title: "Emergency contact", fields: [
    { k: "emergency_contact_name", label: "Name" }, { k: "emergency_contact_phone", label: "Phone", type: "tel" },
  ] },
];

/** Set per person, so never part of the default profile. */
export const PER_PERSON_FIELDS = ["employee_code", "first_name", "last_name", "passport_no", "ssn"];

/** Values a new employee starts with: employee columns, plus custom_fields keyed by category id. */
export type EmployeeDefaults = { custom_fields?: Record<string, string>; [k: string]: string | number | boolean | Record<string, string> | undefined };

/** Shared empty value, so hooks depending on the defaults don't rerun every render. */
export const NO_DEFAULTS: EmployeeDefaults = {};

/** Fills in the default profile under whatever was given for a new employee (empty values count as not given). */
export function withDefaults<T extends Record<string, unknown>>(row: T, defaults: EmployeeDefaults): T {
  const out: Record<string, unknown> = { ...row };
  for (const [k, v] of Object.entries(defaults)) {
    if (k === "custom_fields" || PER_PERSON_FIELDS.includes(k) || v === undefined || v === "") continue;
    if (out[k] === undefined || out[k] === null || out[k] === "") out[k] = v;
  }
  if (defaults.custom_fields && Object.keys(defaults.custom_fields).length) {
    out["custom_fields"] = { ...defaults.custom_fields, ...((row["custom_fields"] ?? {}) as Record<string, unknown>) };
  }
  return out as T;
}

/** Offered first for these fields; anything else can be typed. */
const STARTING_OPTIONS: Record<string, string[]> = {
  gender: ["Female", "Male", "Non-binary", "Prefer not to say"],
  residential_status: ["Citizen", "Permanent resident", "Temporary resident", "Work visa", "Non-resident"],
};

/** Custom categories with no section show under this heading. */
export const OTHER_SECTION = "Other details";

export type ProfileSection = { title: string; fields: EmployeeField[]; defs: FieldDef[]; custom: boolean };

/**
 * The profile's sections in order: the built-in ones, then sections the user
 * made (in the order their first category was added), then "Other details".
 * A category whose section matches a built-in title (any case) joins it.
 */
export function profileSections(defs: FieldDef[]): ProfileSection[] {
  const out: ProfileSection[] = EMPLOYEE_SECTIONS.map((s) => ({ title: s.title, fields: s.fields, defs: [], custom: false }));
  const other: ProfileSection = { title: OTHER_SECTION, fields: [], defs: [], custom: false };
  for (const d of defs) {
    const name = d.section?.trim();
    if (!name) { other.defs.push(d); continue; }
    let s = out.find((x) => x.title.toLowerCase() === name.toLowerCase());
    if (!s) out.push((s = { title: name, fields: [], defs: [], custom: true }));
    s.defs.push(d);
  }
  return [...out, other];
}

/** Every section a category can be put in: built-ins, then the user's own. */
export function sectionNames(defs: FieldDef[]): string[] {
  return profileSections(defs).filter((s) => s.title !== OTHER_SECTION).map((s) => s.title);
}

/**
 * Suggestions for a free-text field: the starting options plus every value
 * already used by an employee, so a value typed once is offered from then on.
 */
export function fieldSuggestions(key: string, employees: Employee[]): string[] {
  const seen = new Map<string, string>();
  const add = (v: unknown) => { if (typeof v === "string" && v.trim() && !seen.has(v.trim().toLowerCase())) seen.set(v.trim().toLowerCase(), v.trim()); };
  const start = STARTING_OPTIONS[key] ?? [];
  start.forEach(add);
  for (const e of employees) add((e as Record<string, unknown>)[key]);
  const base = start.length;
  const vals = [...seen.values()];
  return [...vals.slice(0, base), ...vals.slice(base).sort((a, b) => a.localeCompare(b))];
}
