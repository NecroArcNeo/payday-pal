import { getPref, setPref } from "@/lib/prefs";
import { FOLD_PREF, withFold } from "@/lib/fold";

// Ctrl+K's "take me to it": after going to a page, finds a feature on it (an element marked `data-find="…"`, or a
// box's `data-fold="…"`), unfolds its box, scrolls it into view and flashes it, so someone who searched for
// "copy a week" sees the button rather than a whole page. The page may still be loading, so it looks for a few seconds.

const LOOK_FOR_MS = 4000;

export type JumpOptions = {
  /** Press it once found (a button that opens a dialog). */
  click?: boolean;
  /** Put the cursor in its first field once found (a form). */
  focus?: boolean;
  /** The FoldBox it's in, unfolded first. */
  box?: string;
};

export function revealFeature(find: string, opts: JumpOptions = {}) {
  for (const id of [find, opts.box]) if (id) setPref(FOLD_PREF, withFold(getPref<unknown>(FOLD_PREF, []), id, false));
  const started = Date.now();
  const look = () => {
    const sel = `[data-find="${CSS.escape(find)}"], [data-fold="${CSS.escape(find)}"]`;
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) { if (Date.now() - started < LOOK_FOR_MS) setTimeout(look, 100); return; }
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.remove("find-flash");
    void el.offsetWidth; // restart the animation when it's found twice in a row
    el.classList.add("find-flash");
    setTimeout(() => el.classList.remove("find-flash"), 2000);
    if (opts.click) el.click();
    else if (opts.focus) (el.querySelector<HTMLElement>("input:not([type=checkbox]), select, textarea") ?? el.querySelector<HTMLElement>("button"))?.focus({ preventScroll: true });
  };
  // After the dialog that asked closes and the page has had a moment to start drawing.
  setTimeout(look, 50);
}
