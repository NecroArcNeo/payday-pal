import { EMPLOYEE_SECTIONS } from "@/lib/employee-fields";
import { getMeta, setMeta } from "./local";
import type { Row, Snapshot, Sql } from "./snapshot";

// Private fields are employee details that never leave this device. Push and direct cloud writes blank them
// out; pull keeps this device's values for them. The choice is per device (in _meta), so it isn't synced
// and a pull can't change it.
//
// Keys are employees column names ("ssn") or custom categories ("custom:<def id>").

/** Needed to identify people and compute pay, so they always sync. */
export const ALWAYS_SYNCED = ["employee_code", "first_name", "last_name", "hourly_rate"];
export const PRIVATE_COLUMNS = [...EMPLOYEE_SECTIONS.flatMap((s) => s.fields.map((f) => f.k)).filter((k) => !ALWAYS_SYNCED.includes(k)), "notes"];
/** Until the user chooses, ID numbers stay on the device. */
export const DEFAULT_PRIVATE = EMPLOYEE_SECTIONS.flatMap((s) => s.fields).filter((f) => f.sensitive).map((f) => f.k);

const KEY = "private_fields";
export const customKey = (defId: string) => `custom:${defId}`;

export async function getPrivateFields(sql: Sql): Promise<string[]> {
  const v = await getMeta(sql, KEY);
  if (v === null) return DEFAULT_PRIVATE;
  try {
    const keys: unknown = JSON.parse(v);
    return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : DEFAULT_PRIVATE;
  } catch {
    return DEFAULT_PRIVATE;
  }
}

export async function savePrivateFields(sql: Sql, keys: string[]) {
  await setMeta(sql, KEY, JSON.stringify([...new Set(keys)]));
}

const split = (keys: string[]) => ({
  columns: keys.filter((k) => PRIVATE_COLUMNS.includes(k)),
  custom: keys.filter((k) => k.startsWith("custom:")).map((k) => k.slice(7)),
});
const filled = (v: unknown) => v !== null && v !== undefined && v !== "";
const asObject = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : null);

/**
 * An employee row (or patch) without private values. Columns become null ("delete" drops them instead, for the
 * default profile), and private custom categories are removed from custom_fields.
 */
export function stripPrivate<T extends Row>(row: T, keys: string[], how: "null" | "delete" = "null"): T {
  if (!keys.length) return row;
  const { columns, custom } = split(keys);
  const out: Row = { ...row };
  for (const c of columns) {
    if (!(c in out)) continue;
    if (how === "null") out[c] = null; else delete out[c];
  }
  const cf = asObject(out["custom_fields"]);
  if (cf && custom.some((id) => id in cf)) {
    const next = { ...cf };
    for (const id of custom) delete next[id];
    out["custom_fields"] = next;
  }
  return out as T;
}

/** What push sends: the snapshot with every private value removed, including from the default profile. */
export function redactSnapshot(s: Snapshot, keys: string[]): Snapshot {
  if (!keys.length) return s;
  return {
    ...s,
    data: {
      ...s.data,
      employees: s.data.employees.map((e) => stripPrivate(e, keys)),
      payroll_settings: s.data.payroll_settings.map((r) => {
        const d = asObject(r["employee_defaults"]);
        return d ? { ...r, employee_defaults: stripPrivate(d, keys, "delete") } : r;
      }),
    },
  };
}

/** Puts this device's private values back into what's being pulled. A value only the cloud has (from before it was private) is kept too. */
function mergePrivate(incoming: Row, local: Row, keys: string[]): Row {
  const { columns, custom } = split(keys);
  const out: Row = { ...incoming };
  for (const c of columns) if (filled(local[c])) out[c] = local[c];
  const localCf = asObject(local["custom_fields"]) ?? {};
  const keep = custom.filter((id) => filled(localCf[id]));
  if (keep.length) {
    const cf = { ...(asObject(out["custom_fields"]) ?? {}) };
    for (const id of keep) cf[id] = localCf[id];
    out["custom_fields"] = cf;
  }
  return out;
}

/** What pull saves: the cloud copy, with this device's private values kept for the employees it already has. */
export function keepPrivate(incoming: Snapshot, current: Snapshot, keys: string[]): Snapshot {
  if (!keys.length) return incoming;
  const local = new Map(current.data.employees.map((e) => [e["id"], e]));
  const localDefaults = asObject(current.data.payroll_settings[0]?.["employee_defaults"]);
  return {
    ...incoming,
    data: {
      ...incoming.data,
      employees: incoming.data.employees.map((e) => {
        const l = local.get(e["id"]);
        return l ? mergePrivate(e, l, keys) : e;
      }),
      payroll_settings: incoming.data.payroll_settings.map((r) => {
        if (!localDefaults) return r;
        return { ...r, employee_defaults: mergePrivate(asObject(r["employee_defaults"]) ?? {}, localDefaults, keys) };
      }),
    },
  };
}
