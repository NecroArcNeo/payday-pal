import { useLayoutEffect, useRef, type ReactNode } from "react";
import { getPref, setPref } from "@/lib/prefs";

// A <table> whose cell borders can be dragged: a cell's right edge resizes its
// column, its bottom edge resizes its row. Double-click an edge to reset it.
// Cells don't wrap, and every column is as wide as its widest entry (or the
// width the user dragged it to, if wider), measured again whenever the rows
// change. Only dragged widths are saved, so a row being edited, or a long
// entry that's since been removed, never leaves a column wide. Space left over
// in the panel goes to the last column.
// Dragged widths are remembered on this device per table (keyed by a header's
// data-col, its label's alias key, or its text); row heights last until the rows change.

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

export function DataTable({ id, className = "", children }: { id: string; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLTableElement>(null);
  // v2: widths saved before autofit stopped saving its own growth are dropped.
  const prefKey = `meridian-col-widths:v2:${id}`;
  const lastSig = useRef("");

  // After every render: lay the columns out again if they, their saved widths or the rows changed.
  useLayoutEffect(() => {
    const table = ref.current;
    if (!table) return;
    const ths = headerCells(table);
    const saved = getPref<Widths>(prefKey, {});
    const sig = `${ths.map(keyOf).join("|")}\u0000${JSON.stringify(saved)}\u0000${table.textContent ?? ""}`;
    if (sig === lastSig.current) return;
    lastSig.current = sig;
    layout(table, ths, saved);
  });

  useLayoutEffect(() => {
    const table = ref.current;
    if (!table) return;
    let drag: null | { kind: "col"; th: HTMLTableCellElement; x: number; w: number } | { kind: "row"; tr: HTMLTableRowElement; y: number; h: number } = null;
    let moved = false;
    const relayout = () => layout(table, headerCells(table), getPref<Widths>(prefKey, {}));

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
        // Save just this column; laying out again keeps it at least as wide as its widest entry.
        const i = headerCells(table).indexOf(drag.th);
        setPref(prefKey, { ...getPref<Widths>(prefKey, {}), [keyOf(drag.th, i)]: Math.round(parseFloat(drag.th.style.width)) });
        relayout();
      }
      drag = null;
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
      relayout();
    };
    // The leftover space given to the last column depends on the panel's width.
    const resize = new ResizeObserver(() => { if (!drag) relayout(); });
    if (table.parentElement) resize.observe(table.parentElement);

    table.addEventListener("pointermove", onHover);
    table.addEventListener("pointerdown", onDown);
    table.addEventListener("pointermove", onMove);
    table.addEventListener("pointerup", onUp);
    table.addEventListener("pointercancel", onUp);
    table.addEventListener("click", onClick, true);
    table.addEventListener("dblclick", onDouble);
    return () => {
      resize.disconnect();
      table.removeEventListener("pointermove", onHover);
      table.removeEventListener("pointerdown", onDown);
      table.removeEventListener("pointermove", onMove);
      table.removeEventListener("pointerup", onUp);
      table.removeEventListener("pointercancel", onUp);
      table.removeEventListener("click", onClick, true);
      table.removeEventListener("dblclick", onDouble);
    };
  }, [prefKey]);

  return <table ref={ref} className={`data-grid ${className}`}>{children}</table>;
}

/**
 * Measures each column at its content width (a max-content table, nothing wrapping), widens the ones dragged
 * wider, gives the panel's leftover space to the last column, and fixes those widths.
 */
function layout(table: HTMLTableElement, ths: HTMLTableCellElement[], saved: Widths) {
  table.classList.remove("is-sized");
  for (const th of ths) th.style.width = "";
  if (!ths.length) { table.style.width = ""; return; }
  table.style.width = "max-content";
  const widths = ths.map((th, i) => Math.ceil(Math.max(th.getBoundingClientRect().width, saved[keyOf(th, i)] ?? 0)));
  const box = table.parentElement;
  const room = box ? box.clientWidth - parseFloat(getComputedStyle(box).paddingLeft) - parseFloat(getComputedStyle(box).paddingRight) : 0;
  const spare = room - widths.reduce((s, w) => s + w, 0);
  if (spare > 0) widths[widths.length - 1]! += spare;
  ths.forEach((th, i) => { th.style.width = `${widths[i]}px`; });
  table.classList.add("is-sized");
  fitTable(table);
}

/** Fixed layout needs the table as wide as its columns. */
function fitTable(table: HTMLTableElement) {
  const sum = headerCells(table).reduce((s, th) => s + (parseFloat(th.style.width) || 0), 0);
  table.style.width = `${sum}px`;
}
