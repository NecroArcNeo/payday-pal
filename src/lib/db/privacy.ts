import { EMPLOYEE_SECTIONS } from "@/lib/employee-fields";
import { getMeta, setMeta } from "./meta";
import type { Row, Snapshot, Sql } from "./snapshot";

// Private fields are employee details that never leave this device. Push and direct cloud writes blank them
// out; pull keeps this device's values for them. The choice is per device (in _meta), so it isn't synced
// and a pull can't change it. It's stored as the fields that *do* sync, so anything added later (a new
// custom category) starts private until the user chooses to sync it.
//
// Keys are employees column names ("ssn") or custom categories ("custom:<def id>").

/** Needed to identify people and compute pay, so they always sync. */
export const ALWAYS_SYNCED = ["employee_code", "first_name", "last_name", "hourly_rate"];
export const PRIVATE_COLUMNS = [...EMPLOYEE_SECTIONS.flatMap((s) => s.fields.map((f) => f.k)).filter((k) => !ALWAYS_SYNCED.includes(k)), "notes"];
/** Work details that sync until the user chooses otherwise. Every other detail, and every custom category, starts private. */
export const DEFAULT_SHARED = ["department", "job_title", "hire_date"];
/** The Personal section's details: date of birth, gender, nationality, ID numbers, residential status. */
export const PERSONAL_DETAILS = EMPLOYEE_SECTIONS.flatMap((s) => s.fields).filter((f) => f.sensitive).map((f) => f.k);

const SHARED = "shared_fields";
/** Before shared_fields: the private list itself. Converted on first read. */
const OLD_PRIVATE = "private_fields";
const CONFIRMED = "private_fields_confirmed";
export const customKey = (defId: string) => `custom:${defId}`;

/**
 * Every key that can be private: the built-in details, each custom category, and any custom value still on
 * an employee or the default profile after its category was deleted (so leftover values stay private too).
 */
async function allKeys(sql: Sql) {
  const defs = (await sql.query<{ id: string }>("select id from employee_field_defs order by created_at, id")).rows.map((r) => String(r.id));
  const leftover = new Set<string>();
  for (const { custom_fields } of (await sql.query<{ custom_fields: unknown }>("select custom_fields from employees")).rows) {
    for (const k of Object.keys(jsonObject(custom_fields))) leftover.add(k);
  }
  for (const { employee_defaults } of (await sql.query<{ employee_defaults: unknown }>("select employee_defaults from payroll_settings")).rows) {
    for (const k of Object.keys(jsonObject(jsonObject(employee_defaults)["custom_fields"]))) leftover.add(k);
  }
  for (const id of defs) leftover.delete(id);
  return [...PRIVATE_COLUMNS, ...[...defs, ...leftover].map(customKey)];
}

/** A JSON column's value as an object ({} for anything else), whether it arrives as text or already parsed. */
function jsonObject(v: unknown): Record<string, unknown> {
  let x = v;
  if (typeof x === "string") {
    try { x = JSON.parse(x); } catch { return {}; }
  }
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
}

async function readList(sql: Sql, key: string): Promise<string[] | null> {
  const v = await getMeta(sql, key);
  if (v === null) return null;
  try {
    const list: unknown = JSON.parse(v);
    return Array.isArray(list) ? list.filter((k): k is string => typeof k === "string") : null;
  } catch {
    return null;
  }
}

export async function getPrivateFields(sql: Sql): Promise<string[]> {
  const all = await allKeys(sql);
  let shared = await readList(sql, SHARED);
  if (!shared) {
    const old = await readList(sql, OLD_PRIVATE);
    if (!old) return all.filter((k) => !DEFAULT_SHARED.includes(k));
    // A choice saved by an older version: keep it exactly, from now on as the list of what syncs.
    shared = all.filter((k) => !old.includes(k));
    await setMeta(sql, SHARED, JSON.stringify(shared));
    await setMeta(sql, OLD_PRIVATE, null);
  }
  return all.filter((k) => !shared.includes(k));
}

export async function savePrivateFields(sql: Sql, keys: string[]) {
  const all = await allKeys(sql);
  await setMeta(sql, SHARED, JSON.stringify(all.filter((k) => !keys.includes(k))));
  await setMeta(sql, OLD_PRIVATE, null);
}

/** Whether the user has looked at the private fields on this device (saved them, or confirmed them before a push). */
export async function privateFieldsConfirmed(sql: Sql) {
  return (await getMeta(sql, CONFIRMED)) !== null;
}
export async function confirmPrivateFields(sql: Sql) {
  await setMeta(sql, CONFIRMED, new Date().toISOString());
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
  // The edit history holds every value ever written, private ones included: it never leaves the device.
  const { history: _local, ...rest } = s;
  if (!keys.length) return rest;
  return {
    ...rest,
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
