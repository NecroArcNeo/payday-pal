import { useLayoutEffect, useRef, type ReactNode } from "react";
import { getPref, setPref } from "@/lib/prefs";

// A <table> whose cell borders can be dragged: a cell's right edge resizes its
// column, its bottom edge resizes its row. Double-click an edge to reset it.
//
// Cells don't wrap, and every column is as wide as its widest entry (or the
// width the user dragged it to, if wider). Widths are measured cell by cell
// and remembered, and only cells the page actually adds or changes are
// measured again (a MutationObserver reports them), so editing one row reads
// one row, typing into an input reads nothing, and a removed cell is simply
// forgotten, letting its column shrink. The whole table is measured only on
// mount, when the columns change, and once web fonts have loaded.
// Only dragged widths are saved; space left over in the panel goes to the last column.
// Dragged widths are remembered on this device per table (keyed by a header's
// data-col, its label's alias key, or its text); row heights last until the rows change.
// With `stickyHeader`, the header row follows the page down while the table is in view (moved with a
// transform, since the panel's horizontal scrolling rules out position: sticky), stopping at the top of the window.

const EDGE = 5;
const MIN_W = 36;
const MIN_H = 22;
type Widths = Record<string, number>;

/** The columns, from the last header row (each header cell is one column). */
function headerCells(table: HTMLTableElement): HTMLTableCellElement[] {
  const row = table.tHead?.rows[table.tHead.rows.length - 1];
  if (!row) return [];
  const cells = [...row.cells];
  return cells.some((c) => c.colSpan > 1) ? [] : cells;
}
/** Stable when the user renames the column (EditableLabel's data-label-key). */
const keyOf = (th: HTMLTableCellElement, i: number) =>
  th.dataset["col"] || th.querySelector<HTMLElement>("[data-label-key]")?.dataset["labelKey"] || th.textContent?.trim().slice(0, 60) || `#${i}`;

/** Which column a cell's right edge belongs to: its last column, counting colspans. */
function columnOf(cell: HTMLTableCellElement) {
  let col = 0;
  for (const c of (cell.parentElement as HTMLTableRowElement).cells) {
    col += c.colSpan;
    if (c === cell) return col - 1;
  }
  return col - 1;
}

/**
 * The width a cell's content needs: from the leftmost to the rightmost piece of text or leaf element
 * (input, icon…), plus padding. Text that overflows a fixed-width cell still reports its full extent,
 * and block wrappers are skipped, so this is the content's width, not the cell's current one.
 */
function contentWidth(cell: HTMLTableCellElement) {
  let left = Infinity, right = -Infinity;
  const take = (r: DOMRect) => { if (r.width > 0) { left = Math.min(left, r.left); right = Math.max(right, r.right); } };
  const range = document.createRange();
  const walk = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      if (!n.textContent?.trim()) continue;
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) take(r);
    } else if ((n as Element).childElementCount === 0 && !(n as Element).textContent?.trim() || n instanceof HTMLInputElement || n instanceof HTMLSelectElement || n instanceof HTMLButtonElement) {
      take((n as Element).getBoundingClientRect());
    }
  }
  if (left === Infinity) return 0;
  const s = getComputedStyle(cell);
  return Math.ceil(right - left + parseFloat(s.paddingLeft) + parseFloat(s.paddingRight) + parseFloat(s.borderRightWidth));
}

export function DataTable({ id, className = "", stickyHeader = false, children }: { id: string; className?: string; stickyHeader?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLTableElement>(null);
  // v2: widths saved before autofit stopped saving its own growth are dropped.
  const prefKey = `meridian-col-widths:v2:${id}`;

  useLayoutEffect(() => {
    const table = ref.current;
    if (!table) return;
    /** Each measured cell's content width. Cells leave when the page removes them. */
    const sizes = new Map<HTMLTableCellElement, { col: number; w: number }>();
    let cols = "";
    let drag: null | { kind: "col"; th: HTMLTableCellElement; x: number; w: number } | { kind: "row"; tr: HTMLTableRowElement; y: number; h: number } = null;
    let moved = false;

    const measure = (cell: HTMLTableCellElement) => {
      if (cell.colSpan !== 1 || !cell.isConnected) { sizes.delete(cell); return; }
      sizes.set(cell, { col: columnOf(cell), w: contentWidth(cell) });
    };
    const measureAll = () => {
      sizes.clear();
      for (const cell of table.querySelectorAll<HTMLTableCellElement>("th, td")) if (cell.closest("table") === table) measure(cell);
    };
    /** Sets each column to its widest remembered cell (or its dragged width), from memory: no reading the page. */
    const apply = () => {
      const ths = headerCells(table);
      if (!ths.length) { table.classList.remove("is-sized"); table.style.width = ""; return; }
      const saved = getPref<Widths>(prefKey, {});
      const widths = ths.map((th, i) => Math.max(MIN_W, saved[keyOf(th, i)] ?? 0));
      for (const { col, w } of sizes.values()) if (col < widths.length && w > widths[col]!) widths[col] = w;
      const box = table.parentElement;
      const room = box ? box.clientWidth - parseFloat(getComputedStyle(box).paddingLeft) - parseFloat(getComputedStyle(box).paddingRight) : 0;
      const spare = room - widths.reduce((s, w) => s + w, 0);
      if (spare > 0) widths[widths.length - 1]! += spare;
      ths.forEach((th, i) => { const w = `${widths[i]}px`; if (th.style.width !== w) th.style.width = w; });
      table.classList.add("is-sized");
      fitTable(table);
    };
    /** A full pass, when the set of columns changed (or on mount). */
    const fullIfColumnsChanged = () => {
      const now = headerCells(table).map(keyOf).join("|");
      if (now === cols) return false;
      cols = now;
      measureAll();
      return true;
    };

    // Only what changed: cells added, cells whose text or children changed, rows added.
    const changed = new MutationObserver((records) => {
      if (drag) return;
      if (!fullIfColumnsChanged()) {
        const cells = new Set<HTMLTableCellElement>();
        for (const r of records) {
          for (const n of r.removedNodes) {
            if (n instanceof HTMLTableCellElement) sizes.delete(n);
            else if (n instanceof HTMLElement) for (const c of n.querySelectorAll<HTMLTableCellElement>("th, td")) sizes.delete(c);
          }
          for (const n of r.addedNodes) {
            if (n instanceof HTMLTableRowElement) { for (const c of n.cells) cells.add(c); continue; }
            if (n instanceof HTMLElement && n.querySelector("tr")) { for (const c of n.querySelectorAll<HTMLTableCellElement>("th, td")) cells.add(c); continue; }
          }
          const target = r.target instanceof Element ? r.target : r.target.parentElement;
          const cell = target?.closest<HTMLTableCellElement>("th, td");
          if (cell && cell.closest("table") === table) cells.add(cell);
        }
        for (const c of cells) measure(c);
        // Rows removed by React leave their cells' rows detached; forget those too.
        for (const c of sizes.keys()) if (!c.isConnected) sizes.delete(c);
      }
      apply();
    });

    measureAll();
    cols = headerCells(table).map(keyOf).join("|");
    apply();
    changed.observe(table, { childList: true, subtree: true, characterData: true });
    // Text is measured in whatever font has loaded; measure again once the real fonts are in.
    let alive = true;
    void document.fonts?.ready.then(() => { if (alive) { measureAll(); apply(); } });

    const edgeAt = (e: PointerEvent | MouseEvent) => {
      const cell = (e.target as HTMLElement).closest("th,td") as HTMLTableCellElement | null;
      if (!cell || cell.closest("table") !== table) return null;
      const r = cell.getBoundingClientRect();
      if (e.clientX >= r.right - EDGE && e.clientX <= r.right + 1) {
        const th = headerCells(table)[columnOf(cell)];
        if (th) return { kind: "col" as const, cell, th };
      }
      if (e.clientY >= r.bottom - EDGE && e.clientY <= r.bottom + 1) return { kind: "row" as const, cell, tr: cell.parentElement as HTMLTableRowElement };
      return null;
    };

    const onHover = (e: PointerEvent) => {
      if (drag) return;
      const hit = edgeAt(e);
      table.style.cursor = hit ? (hit.kind === "col" ? "col-resize" : "row-resize") : "";
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const hit = edgeAt(e);
      if (!hit) return;
      e.preventDefault();
      moved = false;
      if (hit.kind === "col") {
        drag = { kind: "col", th: hit.th, x: e.clientX, w: hit.th.getBoundingClientRect().width };
      } else {
        drag = { kind: "row", tr: hit.tr, y: e.clientY, h: hit.tr.getBoundingClientRect().height };
      }
      table.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      moved = true;
      if (drag.kind === "col") {
        drag.th.style.width = `${Math.max(MIN_W, Math.round(drag.w + e.clientX - drag.x))}px`;
        fitTable(table);
      } else {
        drag.tr.style.height = `${Math.max(MIN_H, Math.round(drag.h + e.clientY - drag.y))}px`;
      }
    };
    const onUp = (e: PointerEvent) => {
      if (!drag) return;
      if (drag.kind === "col" && moved) {
        // Save just this column; apply() keeps it at least as wide as its widest entry.
        const i = headerCells(table).indexOf(drag.th);
        setPref(prefKey, { ...getPref<Widths>(prefKey, {}), [keyOf(drag.th, i)]: Math.round(parseFloat(drag.th.style.width)) });
      }
      drag = null;
      apply();
      if (table.hasPointerCapture(e.pointerId)) table.releasePointerCapture(e.pointerId);
    };
    // A drag ends with a click on whatever is under the pointer; don't let it act.
    const onClick = (e: MouseEvent) => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } };
    const onDouble = (e: MouseEvent) => {
      const hit = edgeAt(e);
      if (!hit) return;
      e.preventDefault();
      if (hit.kind === "row") { hit.tr.style.height = ""; return; }
      const saved = { ...getPref<Widths>(prefKey, {}) };
      delete saved[keyOf(hit.th, headerCells(table).indexOf(hit.th))];
      setPref(prefKey, saved);
      apply();
    };
    // Keeps the header row in sight: just under the app's (sticky) header, never past the table's last row.
    let frame = 0;
    const float = () => {
      frame = 0;
      const head = table.tHead;
      if (!head || !stickyHeader) return;
      // Under the app's header while it shows, else at the top of the window.
      const top = Math.max(0, document.querySelector("main > header")?.getBoundingClientRect().bottom ?? 0);
      const box = table.getBoundingClientRect();
      const shift = Math.round(Math.max(0, Math.min(top - box.top, box.height - head.getBoundingClientRect().height * 2)));
      const t = shift ? `translateY(${shift}px)` : "";
      if (head.style.transform !== t) head.style.transform = t;
      head.classList.toggle("is-floating", shift > 0);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(float); };
    if (stickyHeader) {
      window.addEventListener("scroll", onScroll, { capture: true, passive: true });
      window.addEventListener("resize", onScroll);
      float();
    }

    // The leftover space given to the last column depends on the panel's width (no measuring needed).
    const resize = new ResizeObserver(() => { if (!drag) apply(); onScroll(); });
    if (table.parentElement) resize.observe(table.parentElement);

    table.addEventListener("pointermove", onHover);
    table.addEventListener("pointerdown", onDown);
    table.addEventListener("pointermove", onMove);
    table.addEventListener("pointerup", onUp);
    table.addEventListener("pointercancel", onUp);
    table.addEventListener("click", onClick, true);
    table.addEventListener("dblclick", onDouble);
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onScroll);
      changed.disconnect();
      resize.disconnect();
      table.removeEventListener("pointermove", onHover);
      table.removeEventListener("pointerdown", onDown);
      table.removeEventListener("pointermove", onMove);
      table.removeEventListener("pointerup", onUp);
      table.removeEventListener("pointercancel", onUp);
      table.removeEventListener("click", onClick, true);
      table.removeEventListener("dblclick", onDouble);
    };
  }, [prefKey, stickyHeader]);

  return <table ref={ref} className={`data-grid ${className}`}>{children}</table>;
}

/** Fixed layout needs the table as wide as its columns. */
function fitTable(table: HTMLTableElement) {
  const sum = headerCells(table).reduce((s, th) => s + (parseFloat(th.style.width) || 0), 0);
  table.style.width = `${sum}px`;
}
