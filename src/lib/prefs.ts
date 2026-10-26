import { useSyncExternalStore } from "react";

// Display preferences remembered on this device (tab order, column widths,
// break unit). Not payroll data, so they live in localStorage, not the database.

const listeners = new Set<() => void>();
const cache = new Map<string, unknown>();

function read<T>(key: string, fallback: T): T {
  if (cache.has(key)) return cache.get(key) as T;
  let v = fallback;
  try {
    const raw = typeof window === "undefined" ? null : localStorage.getItem(key);
    if (raw !== null) v = JSON.parse(raw) as T;
  } catch { /* unreadable: use the fallback */ }
  cache.set(key, v);
  return v;
}

export function getPref<T>(key: string, fallback: T): T {
  return read(key, fallback);
}

export function setPref<T>(key: string, value: T) {
  cache.set(key, value);
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* just won't be remembered */ }
  for (const l of listeners) l();
}

export function usePref<T>(key: string, fallback: T): [T, (v: T) => void] {
  const v = useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => read(key, fallback),
    () => fallback,
  );
  return [v, (next: T) => setPref(key, next)];
}
