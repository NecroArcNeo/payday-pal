import { useLayoutEffect, useRef, type ReactNode } from "react";
import { getPref, setPref } from "@/lib/prefs";

// A <table> whose cell borders can be dragged: a cell's right edge resizes its
// column, its bottom edge resizes its row. Double-click an edge to reset it.
// Column widths are remembered on this device per table (keyed by header text,
// or a header's data-col); row heights last until the rows change.

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
const keyOf = (th: HTMLTableCellElement, i: number) => th.dataset["col"] || th.textContent?.trim().slice(0, 60) || `#${i}`;

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
  const prefKey = `meridian-col-widths:${id}`;
  const lastSig = useRef("");

  // After every render: apply the saved widths if the columns changed (a mode switch, a new column…).
  useLayoutEffect(() => {
    const table = ref.current;
    if (!table) return;
    const ths = headerCells(table);
    const saved = getPref<Widths>(prefKey, {});
    const sig = ths.map(keyOf).join("|") + JSON.stringify(saved);
    if (sig === lastSig.current) return;
    lastSig.current = sig;
    layout(table, ths, saved);
  });

  useLayoutEffect(() => {
    const table = ref.current;
    if (!table) return;
    let drag: null | { kind: "col"; th: HTMLTableCellElement; x: number; w: number } | { kind: "row"; tr: HTMLTableRowElement; y: number; h: number } = null;
    let moved = false;

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
        freeze(table);
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
      if (drag.kind === "col" && moved) save(table, prefKey);
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
      const ths = headerCells(table);
      const saved = { ...getPref<Widths>(prefKey, {}) };
      delete saved[keyOf(hit.th, ths.indexOf(hit.th))];
      setPref(prefKey, saved);
      lastSig.current = "";
      layout(table, ths, saved);
    };

    table.addEventListener("pointermove", onHover);
    table.addEventListener("pointerdown", onDown);
    table.addEventListener("pointermove", onMove);
    table.addEventListener("pointerup", onUp);
    table.addEventListener("pointercancel", onUp);
    table.addEventListener("click", onClick, true);
    table.addEventListener("dblclick", onDouble);
    return () => {
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

/** Natural layout, then fixed widths for the saved columns (and measured ones for the rest). */
function layout(table: HTMLTableElement, ths: HTMLTableCellElement[], saved: Widths) {
  const keys = ths.map(keyOf);
  table.classList.remove("is-sized");
  table.style.width = "";
  for (const th of ths) th.style.width = "";
  if (!keys.some((k) => saved[k])) return;
  const natural = ths.map((th) => th.getBoundingClientRect().width);
  ths.forEach((th, i) => { th.style.width = `${Math.round(saved[keys[i]!] ?? natural[i]!)}px`; });
  table.classList.add("is-sized");
  fitTable(table);
}

/** Switches to fixed widths at the current sizes, so a column can shrink below its content. */
function freeze(table: HTMLTableElement) {
  if (table.classList.contains("is-sized")) return;
  const ths = headerCells(table);
  const natural = ths.map((th) => th.getBoundingClientRect().width);
  ths.forEach((th, i) => { th.style.width = `${Math.round(natural[i]!)}px`; });
  table.classList.add("is-sized");
  fitTable(table);
}

/** Fixed layout needs the table as wide as its columns (it may still be wider to fill its box). */
function fitTable(table: HTMLTableElement) {
  const sum = headerCells(table).reduce((s, th) => s + (parseFloat(th.style.width) || 0), 0);
  table.style.width = `${sum}px`;
}

function save(table: HTMLTableElement, prefKey: string) {
  const ths = headerCells(table);
  const widths = { ...getPref<Widths>(prefKey, {}) };
  ths.forEach((th, i) => { const w = parseFloat(th.style.width); if (w) widths[keyOf(th, i)] = Math.round(w); });
  setPref(prefKey, widths);
}
