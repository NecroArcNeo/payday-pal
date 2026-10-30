import { ArrowDown, ArrowUp } from "lucide-react";
import { btnGhost, inputCls } from "@/components/AppShell";
import { directionLabel, NATURAL_DESC, SORT_LABELS, type Sort, type SortKey } from "@/lib/record-sort";

/** "Sort by [key]" plus a button that flips the direction (like SQL's DESC/ASC). Picking a new key starts it its usual way round. */
export function SortControl<K extends SortKey>({ value, onChange, keys, natural }: {
  value: Sort<K>; onChange: (s: Sort<K>) => void; keys: readonly K[];
  /** Overrides which way round a key starts, e.g. a timesheet's dates read oldest first. */
  natural?: Partial<Record<K, boolean>>;
}) {
  return (
    <span className="flex items-center gap-1.5 font-body text-xs font-medium print:hidden">
      <span className="text-muted-foreground">Sort by</span>
      <select className={`${inputCls} !w-auto !px-2 !py-1 text-xs`} value={value.by} aria-label="Sort by"
        onChange={(e) => { const by = e.target.value as K; onChange({ by, desc: natural?.[by] ?? NATURAL_DESC[by] }); }}>
        {keys.map((k) => <option key={k} value={k}>{SORT_LABELS[k]}</option>)}
      </select>
      <button type="button" onClick={() => onChange({ ...value, desc: !value.desc })} className={`${btnGhost} !px-2.5 !py-1 text-xs font-medium`} title="Reverse the order">
        {value.desc ? <ArrowDown className="mr-1 inline h-3.5 w-3.5" /> : <ArrowUp className="mr-1 inline h-3.5 w-3.5" />}{directionLabel(value)}
      </button>
    </span>
  );
}
