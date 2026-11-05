import { useRef } from "react";
import { usePref } from "@/lib/prefs";

// Drag to resize, shared by the side panels (the record and employee panels' left edge, the page list's right edge)
// and the charts that can be made taller (their bottom edge). The size is a per-device pref, like column widths: saved when the drag ends, not on every move.

/** A size in px that the user can change by dragging, remembered under `key`, kept within [min, max]. */
export function useDragSize(key: string, fallback: number, min: number, max: number) {
  const [saved, save] = usePref<number>(key, fallback);
  const clamp = (v: number) => Math.round(Math.min(Math.max(v, min), Math.max(min, max)));
  return { size: clamp(Number.isFinite(saved) ? saved : fallback), save: (v: number) => save(clamp(v)), reset: () => save(fallback), clamp };
}

/**
 * The grip. `edge` says which side of the box it sits on: "left" (dragging left makes the box wider, as for a panel
 * fixed to the right), "right" (dragging right makes it wider, as for the page list on the left) or "bottom" (dragging
 * down makes it taller). While dragging, `onSize` is called with the new
 * size so the box follows the pointer; `onDone` saves it. Double-click resets, as a table column's edge does. Arrow
 * keys move it 16 px for keyboard users (it's focusable, role="separator").
 */
export function ResizeHandle({ edge, size, clamp, onSize, onDone, onReset, label }: {
  edge: "left" | "right" | "bottom"; size: number; clamp: (v: number) => number;
  onSize: (v: number) => void; onDone: (v: number) => void; onReset: () => void; label: string;
}) {
  const start = useRef<{ at: number; size: number; last: number } | null>(null);
  const along = (e: React.PointerEvent) => (edge === "bottom" ? e.clientY : e.clientX);
  // Left edge: the pointer moving left (smaller x) grows the box. Right and bottom edges: moving right or down grows it.
  const sizeAt = (e: React.PointerEvent) => clamp(start.current!.size + (edge === "left" ? start.current!.at - along(e) : along(e) - start.current!.at));
  const horizontal = edge === "bottom";
  return (
    <div role="separator" aria-orientation={horizontal ? "horizontal" : "vertical"} aria-label={label} aria-valuenow={size} tabIndex={0}
      title={`${label}: drag, or double-click to reset`}
      className={`group absolute z-10 touch-none select-none outline-none ${horizontal ? "inset-x-0 -bottom-1 h-2 cursor-row-resize" : `inset-y-0 w-2 cursor-col-resize ${edge === "left" ? "-left-1" : "-right-1"}`}`}
      // Pointer capture: the drag keeps reaching this element even when the pointer runs ahead of it, or over an
      // iframe or a chart that would otherwise take the events.
      onPointerDown={(e) => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); start.current = { at: along(e), size, last: size }; }}
      onPointerMove={(e) => { if (!start.current) return; const v = sizeAt(e); start.current.last = v; onSize(v); }}
      onPointerUp={(e) => { if (!start.current) return; e.currentTarget.releasePointerCapture(e.pointerId); onDone(start.current.last); start.current = null; }}
      onPointerCancel={() => { if (start.current) onDone(start.current.last); start.current = null; }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const grow = edge === "left" ? { ArrowLeft: 16, ArrowRight: -16 } : edge === "right" ? { ArrowRight: 16, ArrowLeft: -16 } : { ArrowDown: 16, ArrowUp: -16 };
        const step = (grow as Record<string, number>)[e.key];
        if (step) { e.preventDefault(); onDone(clamp(size + step)); }
      }}>
      {/* The visible line: faint until hovered, focused or dragged. */}
      <div className={`absolute bg-primary/0 transition-colors group-hover:bg-primary/50 group-focus-visible:bg-primary group-active:bg-primary ${horizontal ? "inset-x-0 top-1/2 h-0.5 -translate-y-1/2" : "inset-y-0 left-1/2 w-0.5 -translate-x-1/2"}`} />
    </div>
  );
}

/** A box whose height the user can drag (bottom edge), remembered under `prefKey`. */
export function TallBox({ prefKey, height, min = 160, max = 1400, className, label = "Height", children }: {
  prefKey: string; height: number; min?: number; max?: number; className?: string; label?: string; children: React.ReactNode;
}) {
  const { size, save, reset, clamp } = useDragSize(prefKey, height, min, max);
  const box = useRef<HTMLDivElement>(null);
  // While dragging, the box is sized directly (no re-render per pointer move); the pref is saved once at the end.
  const follow = (v: number) => { if (box.current) box.current.style.height = `${v}px`; };
  return (
    <div ref={box} className={`relative ${className ?? ""}`} style={{ height: size }}>
      {children}
      <ResizeHandle edge="bottom" size={size} clamp={clamp} onSize={follow} onDone={save} onReset={reset} label={label} />
    </div>
  );
}
