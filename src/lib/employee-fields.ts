import type { Employee } from "@/lib/payroll";

// The built-in employee details, grouped as the profile page shows them. Shared by the profile and the timesheet.
export type EmployeeField = { k: string; label: string; type?: string; span?: boolean; suggest?: boolean };
export const EMPLOYEE_SECTIONS: { title: string; fields: EmployeeField[] }[] = [
  { title: "Payroll", fields: [
    { k: "employee_code", label: "Employee ID" }, { k: "first_name", label: "First name" }, { k: "last_name", label: "Last name" },
    { k: "hourly_rate", label: "Hourly rate", type: "number" }, { k: "department", label: "Department" }, { k: "job_title", label: "Job title" },
  ] },
  { title: "Personal", fields: [
    { k: "date_of_birth", label: "Date of birth", type: "date" }, { k: "gender", label: "Gender", suggest: true }, { k: "nationality", label: "Nationality", suggest: true },
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

/** Offered first for gender; anything else can be typed. */
const GENDER_OPTIONS = ["Female", "Male", "Non-binary", "Prefer not to say"];

/**
 * Suggestions for a free-text field: the starting options plus every value
 * already used by an employee, so a value typed once is offered from then on.
 */
export function fieldSuggestions(key: string, employees: Employee[]): string[] {
  const seen = new Map<string, string>();
  const add = (v: unknown) => { if (typeof v === "string" && v.trim() && !seen.has(v.trim().toLowerCase())) seen.set(v.trim().toLowerCase(), v.trim()); };
  if (key === "gender") GENDER_OPTIONS.forEach(add);
  for (const e of employees) add((e as Record<string, unknown>)[key]);
  const base = key === "gender" ? GENDER_OPTIONS.length : 0;
  const vals = [...seen.values()];
  return [...vals.slice(0, base), ...vals.slice(base).sort((a, b) => a.localeCompare(b))];
}
