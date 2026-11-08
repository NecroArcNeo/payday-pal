import { localStore, type DataStore } from "./store";
import { localUndo } from "./undo";

/** Cloud features need VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env. */
export const cloudConfigured = Boolean(import.meta.env["VITE_SUPABASE_URL"] && import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"]);

/** Runs an action that writes more than once (a profile with its rate history, an import) as one undo step. */
export function undoable<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return localUndo.record(label, fn);
}

/** This computer's database, where pages read and write (every write one undo step). */
export function db(): DataStore {
  return localStore;
}
