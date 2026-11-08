import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { rangeSelection, sameSelection } from "@/lib/drag-select";

// Selecting table rows by dragging, as in a file list: press on a row (its tick box, or anywhere that isn't a link
// or button) and drag up or down; every row passed over takes the state the first row gets (ticked, or unticked
// when the drag started on a ticked row). Shift+click ticks (or unticks) every row from the last one clicked.
// A press that never leaves its row is an ordinary click: it ticks the box, or opens the row.

/** Where a press can't start a drag: the row's links, buttons and menus keep their own clicks. */
const CONTROLS = "a, button, label, select, textarea, [role=menu], input:not([type=checkbox])";
/** How close to the window's top or bottom edge (px) the pointer makes the page scroll, and the fastest speed. */
const EDGE = 48;
const SPEED = 18;

/**
 * Pass the returned handler to the table's `<tbody onPointerDown>`. Rows are `<tr data-{attr}={id}>`; `order` is
 * their ids as shown, `selected`/`setSelected` the table's selection.
 */
export function useDragSelect({ attr, order, selected, setSelected, boxesOnly = false }: {
  attr: string; order: readonly string[]; selected: ReadonlySet<string>; setSelected: (s: Set<string>) => void;
  /** Only from a tick box (when a press on a cell means something else, as in "Edit in cells"). */
  boxesOnly?: boolean;
}) {
  // Handlers outlive renders (window listeners), so they read the latest props through a ref.
  const latest = useRef({ order, selected, setSelected });
  latest.current = { order, selected, setSelected };
  const anchor = useRef<string | null>(null); // the last row pressed, for Shift+click

  const rowId = (el: EventTarget | null, body: HTMLElement) => {
    const tr = (el as HTMLElement | null)?.closest?.<HTMLElement>(`tr[data-${attr}]`);
    return tr && body.contains(tr) ? tr.dataset[attr] ?? null : null;
  };

  return (e: ReactPointerEvent<HTMLElement>) => {
    // Left button and mouse/pen only (a finger drags to scroll); a DataTable edge drag (resizing) prevents it first.
    if (e.button !== 0 || e.pointerType === "touch" || e.nativeEvent.defaultPrevented) return;
    const target = e.target as HTMLElement;
    if (target.closest(CONTROLS) || (boxesOnly && !target.closest("input[type=checkbox]"))) return;
    const body = e.currentTarget;
    const id = rowId(target, body);
    if (!id) return;
    const { order: ids, selected: before } = latest.current;
    const value = !before.has(id);

    if (e.shiftKey && anchor.current && ids.includes(anchor.current)) {
      latest.current.setSelected(rangeSelection(before, ids, anchor.current, id, value));
      // Shift+press would also extend the page's text selection; clear it once the button is up.
      addEventListener("pointerup", () => { swallowClick(); getSelection()?.removeAllRanges(); }, { once: true });
      return;
    }
    anchor.current = id;

    let current = id;
    let dragging = false;
    let y = e.clientY;
    let x = e.clientX;
    let frame = 0;

    const update = () => {
      const now = rowId(document.elementFromPoint(x, y), body) ?? current;
      if (now === current && !dragging) return;
      current = now;
      if (!dragging && current === id) return;
      if (!dragging) {
        // From here on it's a drag: no text selection, and the click that ends it doesn't open or tick anything.
        dragging = true;
        getSelection()?.removeAllRanges();
        document.documentElement.classList.add("drag-selecting");
      }
      const next = rangeSelection(before, latest.current.order, id, current, value);
      if (!sameSelection(next, latest.current.selected)) latest.current.setSelected(next);
    };
    // Where the table is in the page (not the window): it moves when something above it changes size, such as the
    // "N selected" bar appearing with the first tick, which would slide other rows under the pointer.
    const pageTop = () => body.getBoundingClientRect().top + scrollY;
    let top = pageTop();
    // Every frame of the drag: scroll by any such shift so the table stays put under the pointer, and near the
    // window's top or bottom edge scroll on, the row under the pointer changing with it.
    const tick = () => {
      frame = 0;
      if (!dragging) return;
      const shift = pageTop() - top;
      if (shift) { scrollBy(0, shift); top = pageTop(); }
      const step = y < EDGE ? -SPEED * (1 - y / EDGE) : y > innerHeight - EDGE ? SPEED * (1 - (innerHeight - y) / EDGE) : 0;
      if (step) scrollBy(0, Math.round(step) || Math.sign(step));
      if (shift || step) update();
      frame = requestAnimationFrame(tick);
    };
    const move = (ev: PointerEvent) => {
      x = ev.clientX; y = ev.clientY;
      update();
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const end = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", end);
      removeEventListener("pointercancel", end);
      cancelAnimationFrame(frame);
      document.documentElement.classList.remove("drag-selecting");
      if (dragging) swallowClick();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", end);
    addEventListener("pointercancel", end);
  };
}

/**
 * Called as the button comes up: stops the click that follows (on the window, before React sees it), so it neither
 * opens the row nor flips the tick box under the pointer. The browser sends that click in the same task as the
 * pointerup, so the timeout only clears the listener when no click comes (released outside the table).
 */
function swallowClick() {
  const stop = (ev: MouseEvent) => { ev.stopPropagation(); ev.preventDefault(); };
  addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => removeEventListener("click", stop, { capture: true }), 0);
}
