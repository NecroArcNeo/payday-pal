import { useEffect, useSyncExternalStore } from "react";
import { usePref } from "@/lib/prefs";
import type { TimesheetTemplate } from "./timesheet-export";

// The user's timesheet templates and export routines, kept on this device, not in the payroll database.
// Templates hold whole Excel files, so they get their own IndexedDB database (room for many) rather than
// localStorage, which holds a few megabytes in all and is shared with every display preference.

const DB_NAME = "meridian-timesheet-templates";
const STORE = "templates";
/** Where templates were kept before; moved into IndexedDB the first time the list is read. */
const OLD_KEY = "meridian-timesheet-templates";
export const MAX_TEMPLATE_BYTES = 5_000_000;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Could not open template storage"));
  });
}

/** Runs `fn` in one transaction and resolves once it has committed. */
function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(req ? req.result : (undefined as T)); };
    tx.onerror = tx.onabort = () => {
      db.close();
      reject(tx.error?.name === "QuotaExceededError"
        ? new Error("There isn't room to keep this template on this device. Delete a template you don't use, or use a smaller file.")
        : tx.error ?? new Error("Template storage failed"));
    };
  }));
}

// The list in memory, so every Export menu and editor shows the same templates and updates together.
let cache: TimesheetTemplate[] | null = null;
let loading: Promise<TimesheetTemplate[]> | null = null;
const listeners = new Set<() => void>();
const EMPTY: TimesheetTemplate[] = [];
const byName = (list: TimesheetTemplate[]) => [...list].sort((a, b) => a.name.localeCompare(b.name));
const publish = (list: TimesheetTemplate[]) => { cache = byName(list); for (const l of listeners) l(); };

/** Every saved template, by name. Moves any kept in localStorage by older versions into IndexedDB first. */
export function getTemplates(): Promise<TimesheetTemplate[]> {
  if (cache) return Promise.resolve(cache);
  loading ??= (async () => {
    let old: TimesheetTemplate[] = [];
    try { old = JSON.parse(localStorage.getItem(OLD_KEY) ?? "[]") as TimesheetTemplate[]; } catch { /* unreadable: nothing to move */ }
    if (old.length) {
      await run("readwrite", (s) => { for (const t of old) s.put(t); });
      // Only once they're safely committed in the new place.
      localStorage.removeItem(OLD_KEY);
    }
    const all = await run("readonly", (s) => s.getAll() as IDBRequest<TimesheetTemplate[]>);
    publish(all);
    return cache!;
  })().finally(() => { loading = null; });
  return loading;
}

/** The saved templates, kept up to date (empty until they've loaded). */
export function useTemplates(): TimesheetTemplate[] {
  const list = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => cache ?? EMPTY, () => EMPTY);
  useEffect(() => { if (!cache) void getTemplates().catch(() => { /* shown as no templates */ }); }, []);
  return list;
}

/** Adds the template, or replaces the one with its id. Throws if this device can't hold it. */
export async function saveTemplate(t: TimesheetTemplate) {
  const list = await getTemplates();
  await run("readwrite", (s) => s.put(t));
  publish([...list.filter((x) => x.id !== t.id), t]);
}

export async function deleteTemplate(id: string) {
  const list = await getTemplates();
  await run("readwrite", (s) => s.delete(id));
  publish(list.filter((x) => x.id !== id));
}

// ---------------------------------------------------------------- routines

/** A saved bulk export: who, made how. The dates are picked each time it's run. */
export type ExportRoutine = {
  id: string; name: string;
  employeeIds: string[];
  /** "xlsx", "csv", or a template's id. */
  output: string;
  /** Leave out people with no time records in the period. */
  skipEmpty: boolean;
};

// Routines are small, so they live with the display preferences.
export const useRoutines = () => usePref<ExportRoutine[]>("meridian-export-routines", []);
