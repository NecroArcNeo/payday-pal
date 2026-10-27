// The kinds of value a custom employee category (employee_field_defs.field_type) can hold.
// Values are always stored as strings in employees.custom_fields; the type decides the input, display and checks.
import { isEmail } from "@/lib/email";

export const FIELD_TYPES = [
  { value: "text", label: "Text" },
  { value: "longtext", label: "Long text" },
  { value: "number", label: "Number" },
  { value: "money", label: "Money" },
  { value: "date", label: "Date" },
  { value: "time", label: "Time" },
  { value: "yesno", label: "Yes / No" },
  { value: "email", label: "Email" },
  { value: "tel", label: "Phone" },
  { value: "url", label: "Link" },
] as const;

export type FieldType = (typeof FIELD_TYPES)[number]["value"];

/** Unknown or missing types (older data) are treated as text. */
export const fieldType = (t: string | null | undefined): FieldType => FIELD_TYPES.find((f) => f.value === t)?.value ?? "text";
export const fieldTypeLabel = (t: string | null | undefined) => FIELD_TYPES.find((f) => f.value === fieldType(t))!.label;

const isNumber = (v: string) => v.trim() !== "" && Number.isFinite(Number(v));
const isDate = (v: string) => {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
};
export const isUrl = (v: string) => {
  try { const u = new URL(v.trim()); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; }
};

/** Whether a stored value is what the type expects. Empty values always fit. */
export function fitsType(type: string | null | undefined, value: string): boolean {
  if (!value.trim()) return true;
  switch (fieldType(type)) {
    case "number": case "money": return isNumber(value);
    case "date": return isDate(value);
    case "time": return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    case "yesno": return value === "yes" || value === "no";
    case "email": return isEmail(value);
    case "tel": return /^\+?[\d\s().-]{4,}$/.test(value.trim()) && /\d{3}/.test(value.replace(/\D/g, ""));
    case "url": return isUrl(value);
    default: return true;
  }
}

/** Best-effort conversion of typed or imported text to the type's stored form; unconvertible values come back unchanged. */
export function toType(type: string | null | undefined, value: string): string {
  const v = value.trim();
  if (!v) return "";
  switch (fieldType(type)) {
    case "number": case "money": {
      const n = Number(v.replace(/[$€£,\s]/g, ""));
      return Number.isFinite(n) && /\d/.test(v) ? String(n) : v;
    }
    case "yesno": {
      const k = v.toLowerCase();
      if (["yes", "y", "true", "1", "x", "✓"].includes(k)) return "yes";
      if (["no", "n", "false", "0"].includes(k)) return "no";
      return v;
    }
    case "url": return !/^[a-z]+:/i.test(v) && /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v) ? `https://${v}` : v;
    default: return v;
  }
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** A value as people read it (timesheets, exports). */
export function formatValue(type: string | null | undefined, value: string): string {
  if (!value || !fitsType(type, value)) return value;
  switch (fieldType(type)) {
    case "money": return usd.format(Number(value));
    case "yesno": return value === "yes" ? "Yes" : "No";
    default: return value;
  }
}
