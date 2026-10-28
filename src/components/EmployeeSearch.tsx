import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, Search, X } from "lucide-react";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { inputCls } from "@/components/AppShell";
import { fullName, type Employee } from "@/lib/payroll";
import { FacetFilter } from "@/components/FacetFilter";
import { describeEmployeeFilter, employeeFacets, facetActive, isFiltering, NO_FILTER, SEARCH_HINT, searchEmployees, type EmployeeFilter } from "@/lib/employee-search";

/** Department and position checklists (tick to include, or exclude). Hidden when no employee has either. */
function FacetSelects({ employees, value, onChange, className = "", selectCls = inputCls }: {
  employees: Employee[]; value: EmployeeFilter; onChange: (f: EmployeeFilter) => void; className?: string; selectCls?: string;
}) {
  const { departments, positions } = useMemo(() => employeeFacets(employees), [employees]);
  const select = (key: "department" | "position", all: string, list: string[]) =>
    (list.length > 0 || facetActive(value[key])) && (
      <FacetFilter options={list.map((x) => ({ value: x, label: x }))} value={value[key]} onChange={(v) => onChange({ ...value, [key]: v })}
        allLabel={all} label={key} triggerCls={selectCls} />
    );
  if (!departments.length && !positions.length && !facetActive(value.department) && !facetActive(value.position)) return null;
  return (
    <div className={`flex gap-2 ${className}`}>
      {select("department", "All departments", departments)}
      {select("position", "All positions", positions)}
    </div>
  );
}

/** A search box for filtering employee lists, with department and position dropdowns. Esc clears the text. */
export function SearchInput({ value, onChange, employees, placeholder = SEARCH_HINT, className = "" }: {
  value: EmployeeFilter; onChange: (f: EmployeeFilter) => void; employees: Employee[]; placeholder?: string; className?: string;
}) {
  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      <div className="relative min-w-[12rem] flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search" className={`${inputCls} pl-9 pr-8`} placeholder={placeholder} value={value.text} aria-label="Search employees"
          onChange={(e) => onChange({ ...value, text: e.target.value })} onKeyDown={(e) => { if (e.key === "Escape") onChange({ ...value, text: "" }); }}
        />
        {value.text && (
          <button type="button" onClick={() => onChange({ ...value, text: "" })} aria-label="Clear search" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <FacetSelects employees={employees} value={value} onChange={onChange} />
    </div>
  );
}

const SHOWN = 100;

/** Pick one employee by typing any part of their details. `hideResigned` leaves out resigned people (unless already picked). */
export function EmployeePicker({ employees: all, value, onChange, placeholder = "Pick an employee", emptyLabel, className = "", invalid = false, hideResigned = false }: {
  employees: Employee[]; value: string; onChange: (id: string) => void;
  placeholder?: string; emptyLabel?: string; className?: string; invalid?: boolean; hideResigned?: boolean;
}) {
  const employees = useMemo(() => (hideResigned ? all.filter((e) => e.active || e.id === value) : all), [all, hideResigned, value]);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<EmployeeFilter>(NO_FILTER);
  const q = f.text;
  const setQ = (text: string) => setF((x) => ({ ...x, text }));
  const selected = employees.find((e) => e.id === value);
  const hits = useMemo(() => searchEmployees(employees, f), [employees, f]);
  const pick = (id: string) => { onChange(id); setOpen(false); setF(NO_FILTER); };

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setF(NO_FILTER); }}>
      <PopoverTrigger asChild>
        <button type="button" role="combobox" aria-expanded={open}
          className={`${inputCls} flex items-center justify-between gap-2 text-left ${invalid ? "ring-2 ring-destructive" : ""} ${className}`}>
          <span className={`truncate ${selected ? "" : "text-muted-foreground"}`}>
            {selected ? <>{fullName(selected)} <span className="font-mono text-[11px] text-muted-foreground">{selected.employee_code}</span></> : (emptyLabel ?? placeholder)}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[22rem] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder={SEARCH_HINT} value={q} onValueChange={setQ} />
          <FacetSelects employees={employees} value={f} onChange={setF} className="border-b border-border p-2" selectCls={`${inputCls} !py-1 text-xs flex-1`} />
          <CommandList className="max-h-72">
            <CommandEmpty>No employee matches {describeEmployeeFilter(f)}.</CommandEmpty>
            {emptyLabel !== undefined && !isFiltering(f) && (
              <CommandItem value="__none" onSelect={() => pick("")}>
                <Check className={`mr-2 h-4 w-4 ${value ? "opacity-0" : ""}`} /> <span className="text-muted-foreground">{emptyLabel}</span>
              </CommandItem>
            )}
            {hits.slice(0, SHOWN).map((e) => (
              <CommandItem key={e.id} value={e.id} onSelect={() => pick(e.id)}>
                <Check className={`mr-2 h-4 w-4 shrink-0 ${e.id === value ? "" : "opacity-0"}`} />
                <div className="min-w-0">
                  <div className="truncate">{fullName(e)} <span className="font-mono text-[11px] text-muted-foreground">{e.employee_code}</span>{!e.active && <span className="ml-1 text-[11px] text-muted-foreground">(resigned)</span>}</div>
                  {(e.job_title || e.department) && <div className="truncate text-[11px] text-muted-foreground">{[e.job_title, e.department].filter(Boolean).join(" · ")}</div>}
                </div>
              </CommandItem>
            ))}
            {hits.length > SHOWN && <div className="px-3 py-2 text-xs text-muted-foreground">{hits.length - SHOWN} more — keep typing to narrow it down</div>}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
