import type { ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { usePref } from "@/lib/prefs";
import { FOLD_PREF, isFolded, withFold } from "@/lib/fold";

// Any box on a page can be folded into a one-line bar to save room. The box itself is passed as `children`, so a
// page wraps its existing box without changing it. Folded boxes are unmounted (not just hidden), so a table measures
// its columns and a chart its size afresh when shown again; anything typed into a folded form is dropped.

export function useFolded(): [string[], (ids: string[]) => void] {
  return usePref<string[]>(FOLD_PREF, []);
}

/**
 * A box that folds. `id` names it for the per-device pref (unique per box, e.g. "payroll:table"), `title` labels the
 * folded bar, `summary` adds a short note to it (e.g. "12 people"). `className` goes on the wrapper, for grid placement.
 * `off` shows the box as it is, with no fold (a box inside another foldable box).
 */
export function FoldBox({ id, title, summary, className = "", off = false, children }: {
  id: string; title: ReactNode; summary?: ReactNode; className?: string; off?: boolean; children: ReactNode;
}) {
  const [folded, setFolded] = useFolded();
  const shut = !off && isFolded(folded, id);
  const toggle = () => setFolded(withFold(folded, id, !shut));
  if (off) return className ? <div className={className}>{children}</div> : <>{children}</>;
  if (shut) {
    return (
      <button type="button" onClick={toggle} aria-expanded={false} data-fold={id} title="Show this box again"
        className={`glass-panel flex w-full items-center gap-3 px-5 py-2.5 text-left text-sm hover:bg-accent/40 ${className}`}>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="font-display font-bold tracking-tight">{title}</span>
        {summary && <span className="truncate text-xs text-muted-foreground">{summary}</span>}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">Show</span>
      </button>
    );
  }
  return (
    <div data-fold={id} className={`group/fold relative ${className}`}>
      {children}
      {/* On the box's top edge, outside it, so it never covers the box's own buttons (or is clipped by overflow-hidden). */}
      <button type="button" onClick={toggle} aria-expanded aria-label={`Fold ${typeof title === "string" ? title : "this box"} into a bar`}
        title="Fold into a bar"
        className="absolute -top-2.5 right-5 z-10 flex h-5 items-center gap-0.5 rounded-full bg-secondary px-1.5 text-[10px] text-muted-foreground opacity-40 ring-1 ring-border transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/fold:opacity-100">
        <ChevronUp className="h-3 w-3" />Fold
      </button>
    </div>
  );
}
