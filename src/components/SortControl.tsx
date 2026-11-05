import { createContext, useContext, type ReactNode, type ThHTMLAttributes } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { btnGhost, inputCls } from "@/components/AppShell";
import { useLabels } from "@/lib/labels";
import { usePref } from "@/lib/prefs";
import { directionLabel, naturalDesc, nextSort, validTableSort, type Sort, type SortColumns } from "@/lib/table-sort";

// Sorting a table by any of its columns, two ways that share one choice: the "Sort by" menu above the table
// (SortControl) and a small arrow in each column's header (SortTh). Clicking the header's name still renames it
// (EditableLabel), so sorting has its own button beside the name. The table gives its columns once through
// <TableSort>, and every SortTh inside finds them there (React context), so shared headers like RecordPayHeaders
// sort in whichever table they're in.

type Table = { sort: Sort; columns: SortColumns<never>; onSort: (s: Sort) => void };
const TableSortContext = createContext<Table | null>(null);

/** Remembers a table's sort on this device (`key`), checked against its columns. */
export function useTableSort<T>(key: string, columns: SortColumns<T>, fallback: Sort): [Sort, (s: Sort) => void] {
  const [saved, setSaved] = usePref<Sort | null>(key, null);
  return [validTableSort(saved, columns as SortColumns<never>, fallback), setSaved];
}

export function TableSort<T>({ sort, columns, onSort, children }: { sort: Sort; columns: SortColumns<T>; onSort: (s: Sort) => void; children: ReactNode }) {
  return <TableSortContext.Provider value={{ sort, columns: columns as SortColumns<never>, onSort }}>{children}</TableSortContext.Provider>;
}

/**
 * A header cell that sorts by column `k`: its label, then a sort button (↕ faintly, or ↑/↓ while it's the column the
 * table is sorted by). Outside a <TableSort>, or for a column the table can't sort by, a plain header cell.
 */
export function SortTh({ k, children, className, ...rest }: { k: string; children: ReactNode } & ThHTMLAttributes<HTMLTableCellElement>) {
  const t = useContext(TableSortContext);
  const { label } = useLabels();
  const col = t?.columns[k];
  if (!t || !col) return <th className={className} {...rest}>{children}</th>;
  const on = t.sort.by === k;
  const name = label(k, col.label);
  const Icon = on ? (t.sort.desc ? ArrowDown : ArrowUp) : ArrowUpDown;
  return (
    <th className={className} aria-sort={on ? (t.sort.desc ? "descending" : "ascending") : "none"} {...rest}>
      <span className="group/sort inline-flex items-center gap-1">
        {children}
        <button type="button" onClick={() => t.onSort(nextSort(t.sort, k, col))}
          className={`rounded p-0.5 print:hidden ${on ? "text-primary" : "text-muted-foreground/40 hover:text-foreground group-hover/sort:text-muted-foreground"}`}
          aria-label={`Sort by ${name}${on ? ` (${directionLabel(t.sort, col).toLowerCase()}; click to reverse)` : ""}`}
          title={on ? `Sorted by ${name}: ${directionLabel(t.sort, col).toLowerCase()}. Click to reverse.` : `Sort by ${name}`}>
          <Icon className="h-3 w-3" />
        </button>
      </span>
    </th>
  );
}

/** "Sort by [any column]" plus a button that flips the direction. Picking a column starts it its usual way round. */
export function SortControl<T>({ value, onChange, columns }: { value: Sort; onChange: (s: Sort) => void; columns: SortColumns<T> }) {
  const { label } = useLabels();
  const col = columns[value.by] as SortColumns<never>[string] | undefined;
  return (
    <span className="flex items-center gap-1.5 font-body text-xs font-medium print:hidden">
      <span className="text-muted-foreground">Sort by</span>
      <select className={`${inputCls} !w-auto !px-2 !py-1 text-xs`} value={value.by} aria-label="Sort by"
        onChange={(e) => { const by = e.target.value; const c = columns[by]; if (c) onChange({ by, desc: naturalDesc(c as SortColumns<unknown>[string]) }); }}>
        {Object.entries(columns).map(([k, c]) => <option key={k} value={k}>{label(k, c.label)}</option>)}
      </select>
      <button type="button" onClick={() => onChange({ ...value, desc: !value.desc })} className={`${btnGhost} !px-2.5 !py-1 text-xs font-medium`} title="Reverse the order">
        {value.desc ? <ArrowDown className="mr-1 inline h-3.5 w-3.5" /> : <ArrowUp className="mr-1 inline h-3.5 w-3.5" />}{directionLabel(value, col)}
      </button>
    </span>
  );
}
