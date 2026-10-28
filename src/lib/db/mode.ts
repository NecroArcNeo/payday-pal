import { useSyncExternalStore } from "react";
import { cloudStore, localStore, type DataStore } from "./store";
import { localUndo } from "./undo";

/** Where reads and writes go: this device's database, or the signed-in account's cloud copy. */
export type DataMode = "local" | "cloud";

const KEY = "meridian-data-mode";
const listeners = new Set<() => void>();

/** Cloud features need VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env. */
export const cloudConfigured = Boolean(import.meta.env["VITE_SUPABASE_URL"] && import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"]);

function read(): DataMode {
  try {
    return cloudConfigured && localStorage.getItem(KEY) === "cloud" ? "cloud" : "local";
  } catch {
    return "local";
  }
}

let mode: DataMode = typeof window === "undefined" ? "local" : read();

export function getDataMode() {
  return mode;
}

export function setDataMode(next: DataMode) {
  mode = next;
  try { localStorage.setItem(KEY, next); } catch { /* the mode just won't be remembered */ }
  for (const l of listeners) l();
}

export function useDataMode(): DataMode {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => mode,
    () => "local",
  );
}

export function storeFor(m: DataMode): DataStore {
  return m === "cloud" ? cloudStore : localStore;
}

/** Runs an action that writes more than once (a profile with its rate history, an import) as one undo step. */
export function undoable<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return mode === "local" ? localUndo.record(label, fn) : fn();
}

/** The store for the current mode. Pages call this for writes. */
export function db(): DataStore {
  return storeFor(mode);
}
