import { useSyncExternalStore } from "react";

// A question with more answers than OK/Cancel, asked from anywhere through the one <ChoicePrompt />
// mounted in the root layout. Closing the dialog answers null.

export type Choice<T extends string> = { id: T; label: string; primary?: boolean; danger?: boolean };
export type ChoiceRequest<T extends string = string> = {
  title: string;
  detail?: string;
  /** A short list shown under the detail, e.g. which people and days. */
  items?: string[];
  /** Left to right; the last one is the default (Enter). */
  choices: Choice<T>[];
};

type Pending = ChoiceRequest & { resolve: (id: string | null) => void };
let pending: Pending | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };

export function askChoice<T extends string>(req: ChoiceRequest<T>): Promise<T | null> {
  pending?.resolve(null);
  return new Promise((resolve) => {
    pending = { ...req, resolve: resolve as (id: string | null) => void };
    notify();
  });
}

export function answerChoice(id: string | null) {
  const p = pending;
  pending = null;
  notify();
  p?.resolve(id);
}

export function useChoiceRequest() {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => pending,
    () => null,
  );
}
