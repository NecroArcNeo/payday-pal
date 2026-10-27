import { useSyncExternalStore } from "react";

// Asks for a password from anywhere (e.g. the backup-file helpers) through the one <PasswordPrompt />
// mounted in the root layout.

export type PasswordRequest = {
  /** "set": choose a new password (typed twice), with the option to go without. "enter": type an existing one. */
  mode: "set" | "enter";
  title: string;
  detail?: string;
  /** Shown under the field, e.g. after a wrong password. */
  error?: string;
};
/** The password, `plain` when the user chose no password, or null when they cancelled. */
export type PasswordResult = { password: string } | { plain: true } | null;

type Pending = PasswordRequest & { resolve: (r: PasswordResult) => void };
let pending: Pending | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };

export function askPassword(req: PasswordRequest): Promise<PasswordResult> {
  pending?.resolve(null);
  return new Promise((resolve) => {
    pending = { ...req, resolve };
    notify();
  });
}

export function answerPassword(result: PasswordResult) {
  const p = pending;
  pending = null;
  notify();
  p?.resolve(result);
}

export function usePasswordRequest() {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => pending,
    () => null,
  );
}
