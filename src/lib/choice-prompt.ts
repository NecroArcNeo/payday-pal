import { useSyncExternalStore } from "react";

// Questions asked from anywhere through the one <ChoicePrompt /> mounted in the root layout: askChoice for a question
// with several answers, askConfirm for a yes/no one (in place of the browser's confirm(), which is a grey Windows box
// that freezes the page and can only show plain text). Closing the dialog (Escape) answers null / false.

export type Choice<T extends string> = {
  id: T; label: string; primary?: boolean; danger?: boolean;
  /** Only offered with a date entered. */ needsDate?: boolean;
  /** Only offered with some text typed. */ needsText?: boolean;
};
export type ChoiceRequest<T extends string = string> = {
  title: string;
  /** Plain text; a blank line starts a new paragraph. */
  detail?: string;
  /** A short list shown under the detail, e.g. which people and days. */
  items?: string[];
  /** Left to right; the last one is the default (Enter), unless `focus` names another. */
  choices: Choice<T>[];
  /** The answer that has the focus at first (so Enter picks it). */
  focus?: T;
  /** A date to fill in, given back with the answer. */
  date?: { label: string; value: string; min?: string; max?: string };
  /** A line of text to type (a name), given back with the answer. */
  text?: { label: string; value: string; placeholder?: string; maxLength?: number };
};
/** The choice picked, with the date and text as they were when picked (empty when the request had none). */
export type ChoiceAnswer<T extends string> = { id: T; date: string; text: string };

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

export type ConfirmRequest = {
  title: string;
  detail?: string;
  items?: string[];
  /** The button that says yes: name the action ("Delete 3 employees"), not "OK". */
  confirm: string;
  cancel?: string;
  /** Deleting or replacing something: the button is red, and Cancel has the focus, so Enter doesn't do it. */
  danger?: boolean;
};

/** A yes/no question: true when the user picks `confirm`. Await it: `if (!(await askConfirm({…}))) return;`. */
export async function askConfirm({ title, detail, items, confirm, cancel = "Cancel", danger = false }: ConfirmRequest): Promise<boolean> {
  const answer = await askChoice({
    title, ...(detail ? { detail } : {}), ...(items ? { items } : {}),
    choices: [{ id: "cancel", label: cancel }, { id: "ok", label: confirm, primary: !danger, danger }],
    focus: danger ? "cancel" : "ok",
  });
  return answer?.id === "ok";
}

/**
 * Asks for a line of text (in place of the browser's prompt(), which Electron doesn't support: it returns nothing).
 * The text typed, trimmed; null when cancelled. Enter in the box picks `confirm`.
 */
export async function askText({ title, detail, label, value = "", placeholder, maxLength, confirm }: {
  title: string; detail?: string; label: string; value?: string; placeholder?: string; maxLength?: number; confirm: string;
}): Promise<string | null> {
  const answer = await askChoice({
    title, ...(detail ? { detail } : {}),
    text: { label, value, ...(placeholder ? { placeholder } : {}), ...(maxLength ? { maxLength } : {}) },
    choices: [{ id: "cancel", label: "Cancel" }, { id: "ok", label: confirm, primary: true, needsText: true }],
  });
  return answer?.id === "ok" ? answer.text.trim() : null;
}

/** Moving away from a side panel's form with changes not saved yet. */
export const LEAVE_UNSAVED: ConfirmRequest = { title: "Leave without saving?", detail: "Your changes here haven't been saved and will be lost.", confirm: "Leave without saving", cancel: "Keep editing", danger: true };

/**
 * A modal dialog (a question, a menu) is open, so keys belong to it: the side panels' Escape and ↑/↓ wait. The side
 * panels themselves are non-modal dialogs and don't count.
 */
export const modalOpen = () => dialogOpen() || !!document.querySelector('[role="menu"]');
/** A modal dialog or a question is open (menus not counted). */
export const dialogOpen = () => typeof document !== "undefined" && !!document.querySelector('[role="dialog"]:not([aria-modal="false"]), [role="alertdialog"]');

/**
 * For a menu's onCloseAutoFocus. A menu gives the focus back to its button as it closes (after its closing
 * animation); when the item picked opened a question (Delete…) or a dialog, that would pull the focus out of it, so
 * the menu leaves the focus where it is.
 */
export const keepDialogFocus = (e: Event) => { if (dialogOpen()) e.preventDefault(); };

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
