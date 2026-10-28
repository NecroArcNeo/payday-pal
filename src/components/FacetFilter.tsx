import { useState } from "react";
import { Ban, Check, ChevronsUpDown } from "lucide-react";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { inputCls } from "@/components/AppShell";
import { ANY, describeFacet, facetActive, type Facet } from "@/lib/employee-search";

export type FacetOption = { value: string; label: string };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const without = (list: string[], v: string) => list.filter((x) => !same(x, v));
const has = (list: string[], v: string) => list.some((x) => same(x, v));

/**
 * A dropdown checklist: tick values to show only those (any of them), or press a value's exclude
 * button to leave it out. Nothing ticked or excluded means "all".
 */
export function FacetFilter({ options, value, onChange, allLabel, label, className = "", triggerCls = inputCls }: {
  options: FacetOption[]; value: Facet; onChange: (f: Facet) => void;
  /** Shown when nothing is chosen, e.g. "All departments". */
  allLabel: string;
  /** For screen readers and the tooltip, e.g. "department". */
  label: string;
  className?: string; triggerCls?: string;
}) {
  const [open, setOpen] = useState(false);
  // Keep chosen values listed even if nobody has them any more, so they can be seen and cleared.
  const extra = [...value.include, ...value.exclude].filter((v) => !options.some((o) => same(o.value, v))).map((v) => ({ value: v, label: v }));
  const all = [...extra, ...options];
  const name = (v: string) => all.find((o) => same(o.value, v))?.label ?? v;
  const active = facetActive(value);
  const include = (v: string) => onChange({ include: has(value.include, v) ? without(value.include, v) : [...value.include, v], exclude: without(value.exclude, v) });
  const exclude = (v: string) => onChange({ include: without(value.include, v), exclude: has(value.exclude, v) ? without(value.exclude, v) : [...value.exclude, v] });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`Filter by ${label}`} title={active ? `${label}: ${describeFacet(value, name)}` : `Filter by ${label}`}
          className={`${triggerCls} flex w-auto max-w-[14rem] items-center justify-between gap-2 text-left ${active ? "ring-2 ring-primary/40" : ""} ${className}`}>
          <span className="truncate">{active ? describeFacet(value, name) : allLabel}</span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[18rem] p-0" align="start">
        <Command>
          {all.length > 8 && <CommandInput placeholder={`Find a ${label}…`} />}
          <CommandList className="max-h-72">
            <CommandEmpty>No {label} matches.</CommandEmpty>
            {all.map((o) => {
              const inc = has(value.include, o.value);
              const exc = has(value.exclude, o.value);
              return (
                <CommandItem key={o.value} value={o.label} onSelect={() => include(o.value)} className="group">
                  <span className={`mr-2 grid h-4 w-4 shrink-0 place-items-center rounded border ${inc ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}>
                    {inc && <Check className="h-3 w-3" />}
                  </span>
                  <span className={`flex-1 truncate ${exc ? "text-muted-foreground line-through" : ""}`}>{o.label}</span>
                  <button type="button" aria-label={`${exc ? "Stop excluding" : "Exclude"} ${o.label}`} aria-pressed={exc}
                    title={exc ? "Excluded: click to stop excluding" : "Exclude: leave these out"}
                    onClick={(e) => { e.stopPropagation(); exclude(o.value); }} onPointerDown={(e) => e.stopPropagation()}
                    className={`ml-2 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] ring-1 ${exc ? "bg-destructive/15 text-destructive ring-destructive/40" : "text-muted-foreground opacity-60 ring-border hover:text-foreground hover:opacity-100 group-data-[selected=true]:opacity-100"}`}>
                    <Ban className="h-3 w-3" /> {exc ? "Excluded" : "Exclude"}
                  </button>
                </CommandItem>
              );
            })}
          </CommandList>
          <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-muted-foreground">
            <span>Tick to show only those; Exclude to leave out.</span>
            {active && <button type="button" className="hover:text-foreground" onClick={() => onChange(ANY)}>Clear</button>}
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
