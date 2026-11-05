import { useEffect, useState } from "react";
import { useIsFetching } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";

// Loading placeholders and progress bars.
//
// The data is on this device, so most reads take a few milliseconds. A placeholder that flashes for one frame is worse
// than none, so they only appear once loading has gone on for a moment (`useLater`). What they're for is the slower
// cases (a big Time records list sorted by pay, years of reports) and, above all, not saying "No employees yet" while
// the employees are still being read.

/** True once `on` has stayed true for `ms`; false again as soon as it's false. */
export function useLater(on: boolean, ms = 150) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!on) { setLate(false); return; }
    const t = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return on && late;
}

// Bar widths that vary from row to row and column to column, so the placeholder reads as a table rather than stripes.
const WIDTHS = ["w-24", "w-16", "w-20", "w-12", "w-28", "w-14", "w-10", "w-24", "w-16"];

/** Placeholder rows for a table body: `cols` cells each (the first `skip` left empty, as for a tick box column). */
export function SkeletonRows({ cols, rows = 6, skip = 0 }: { cols: number; rows?: number; skip?: number }) {
  const show = useLater(true);
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} aria-hidden className="border-b border-border last:border-0">
          {Array.from({ length: cols }, (_, c) => (
            <td key={c} className={c === 0 ? "py-3 pl-5 pr-3" : "px-3 py-3"}>
              {/* Invisible (not absent) at first, so the row has its height and nothing jumps when they show. */}
              {c >= skip && <Skeleton className={`h-4 ${WIDTHS[(r + c) % WIDTHS.length]} ${show ? "" : "invisible"}`} />}
            </td>
          ))}
        </tr>
      ))}
      {/* For screen readers, which skip the bars. */}
      <tr className="sr-only"><td>Loading…</td></tr>
    </>
  );
}

/** A placeholder block (a chart, a card) after the same short wait. */
export function SkeletonBlock({ className, style }: { className?: string; style?: React.CSSProperties }) {
  const show = useLater(true);
  return <Skeleton className={`${className ?? ""} ${show ? "" : "invisible"}`} style={style} role="status" aria-label="Loading" />;
}

/** A thin bar across the top of the page while any data is being read for longer than a moment. */
export function FetchBar() {
  const busy = useLater(useIsFetching() > 0, 300);
  return (
    <div aria-hidden className={`pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden transition-opacity duration-300 ${busy ? "opacity-100" : "opacity-0"}`}>
      <div className={`h-full w-1/4 bg-primary ${busy ? "animate-sweep" : ""}`} />
    </div>
  );
}

/** How far a job of `total` steps has got: a bar, "12 of 30" and what it's doing now. */
export function TaskProgress({ done, total, label, className }: { done: number; total: number; label?: string; className?: string }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className={`space-y-1.5 ${className ?? ""}`} role="status" aria-live="polite">
      <div className="flex justify-between gap-3 text-xs text-muted-foreground">
        <span className="truncate">{label}</span>
        <span className="shrink-0 font-mono">{done} of {total}</span>
      </div>
      <Progress value={pct} aria-label={label ?? "Progress"} />
    </div>
  );
}
