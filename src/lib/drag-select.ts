// Selecting table rows by dragging, and Shift+click ranges: which rows end up selected. Pure, so it's tested
// without a page; `useDragSelect` (src/components/DragSelect.tsx) feeds it the pointer's rows.

/**
 * The selection while a drag (or a Shift+click) covers the rows from `anchor` to `current`, in the table's
 * `order`: every row in between is set to `value` (true ticks them, false unticks them) on top of `base`, the
 * selection before the drag started. Rows outside the range keep their state from `base`, so dragging back
 * shrinks the range and gives those rows back as they were.
 */
export function rangeSelection(base: ReadonlySet<string>, order: readonly string[], anchor: string, current: string, value: boolean): Set<string> {
  const out = new Set(base);
  const a = order.indexOf(anchor);
  const b = order.indexOf(current);
  if (a < 0 || b < 0) return out;
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
    const id = order[i]!;
    if (value) out.add(id); else out.delete(id);
  }
  return out;
}

/** True when two selections hold the same rows (so a drag that moves within one row changes nothing). */
export function sameSelection(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}
