import { useSyncExternalStore } from "react";

// A question with more answers than OK/Cancel, asked from anywhere through the one <ChoicePrompt />
// mounted in the root layout. Closing the dialog answers null.

export type Choice<T extends string> = { id: T; label: string; primary?: boolean; danger?: boolean; /** Only offered with a date entered. */ needsDate?: boolean };
export type ChoiceRequest<T extends string = string> = {
  title: string;
  detail?: string;
  /** A short list shown under the detail, e.g. which people and days. */
  items?: string[];
  /** Left to right; the last one is the default (Enter). */
  choices: Choice<T>[];
  /** A date to fill in, given back with the answer. */
  date?: { label: string; value: string; min?: string; max?: string };
};
/** The choice picked, with the date as it was when picked (empty when the request had none). */
export type ChoiceAnswer<T extends string> = { id: T; date: string };

type Pending = ChoiceRequest & { resolve: (a: ChoiceAnswer<string> | null) => void };
let pending: Pending | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };

export function askChoice<T extends string>(req: ChoiceRequest<T>): Promise<ChoiceAnswer<T> | null> {
  pending?.resolve(null);
  return new Promise((resolve) => {
    pending = { ...req, resolve: resolve as (a: ChoiceAnswer<string> | null) => void };
    notify();
  });
}

export function answerChoice(a: ChoiceAnswer<string> | null) {
  const p = pending;
  pending = null;
  notify();
  p?.resolve(a);
}

export function useChoiceRequest() {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => pending,
    () => null,
  );
}
