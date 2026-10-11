import { useMemo, useState } from "react";
import { Search, X, Trash2, Filter } from "lucide-react";
import { fullName, money, type Employee, type RecordWithEmp } from "@/lib/payroll";
import { inputCls } from "@/components/AppShell";

interface Props {
  records: RecordWithEmp[];
  employees?: Employee[];
  title?: string;
  onDelete?: (id: string) => void;
  onDeleteMany?: (ids: string[]) => void;
  showName?: boolean;
}

type SortKey = "date" | "name" | "hours" | "pay";

export function RecordsTable({ records, employees = [], title = "Time records", onDelete, onDeleteMany, showName = true }: Props) {
  const [mode, setMode] = useState<"all" | "clock" | "hours">("all");
  const [search, setSearch] = useState("");
  const [dept, setDept] = useState("");
  const [position, setPosition] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDesc, setSortDesc] = useState(true);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Unique departments and positions for filter dropdowns
  const departments = useMemo(() => {
    const set = new Set<string>();
    employees.forEach((e) => { if (e.department) set.add(e.department); });
    return [...set].sort();
  }, [employees]);

  const positions = useMemo(() => {
    const set = new Set<string>();
    employees.forEach((e) => { if (e.job_title) set.add(e.job_title); });
    return [...set].sort();
  }, [employees]);

  const empById = useMemo(() => {
    const m = new Map(employees.map((e) => [e.id, e]));
    return m;
  }, [employees]);

  // Apply filters
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    let rows = records.filter((r) => {
      if (mode !== "all" && r.entry_mode !== mode) return false;
      const emp = empById.get(r.employee_id) ?? r.employees;
      if (dept && emp?.department !== dept) return false;
      if (position && emp?.job_title !== position) return false;
      if (q) {
        const name = emp ? fullName(emp).toLowerCase() : "";
        const code = emp?.employee_code?.toLowerCase() ?? "";
        const email = emp?.email?.toLowerCase() ?? "";
        if (!name.includes(q) && !code.includes(q) && !email.includes(q)) return false;
      }
      return true;
    });

    // Sort
    rows = [...rows].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "date") cmp = a.work_date.localeCompare(b.work_date);
      else if (sortKey === "hours") cmp = Number(a.hours) - Number(b.hours);
      else if (sortKey === "pay") {
        const ra = Number(empById.get(a.employee_id)?.hourly_rate ?? a.employees?.hourly_rate ?? 0);
        const rb = Number(empById.get(b.employee_id)?.hourly_rate ?? b.employees?.hourly_rate ?? 0);
        cmp = ra * Number(a.hours) - rb * Number(b.hours);
      } else {
        const na = empById.get(a.employee_id) ? fullName(empById.get(a.employee_id)!) : "";
        const nb = empById.get(b.employee_id) ? fullName(empById.get(b.employee_id)!) : "";
        cmp = na.localeCompare(nb);
      }
      return sortDesc ? -cmp : cmp;
    });

    return rows;
  }, [records, mode, search, dept, position, sortKey, sortDesc, empById]);

  // Remove checked IDs that are no longer visible
  const visibleChecked = useMemo(
    () => filtered.filter((r) => checked.has(r.id)),
    [filtered, checked],
  );
  const allVisibleChecked = filtered.length > 0 && visibleChecked.length === filtered.length;

  const toggleAll = () => {
    if (allVisibleChecked) setChecked(new Set());
    else setChecked(new Set(filtered.map((r) => r.id)));
  };

  const toggleOne = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const doBulkDelete = async () => {
    if (!onDeleteMany) return;
    const ids = [...checked];
    setConfirmDelete(false);
    setChecked(new Set());
    await onDeleteMany(ids);
  };

  const sortBtn = (key: SortKey, label: string) => (
    <button
      onClick={() => setSortKey((k) => {
        if (k === key) { setSortDesc(!sortDesc); return k; }
        setSortDesc(true);
        return key;
      })}
      className="inline-flex items-center gap-1 hover:text-foreground"
    >
      {label}
      {sortKey === key && <span className="text-primary">{sortDesc ? "↓" : "↑"}</span>}
    </button>
  );

  const hasFilters = search || dept || position || mode !== "all";

  return (
    <div className="glass-panel overflow-hidden">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="font-display font-extrabold tracking-tight">{title}</div>
          {checked.size > 0 && onDeleteMany && (
            <button
              onClick={() => setConfirmDelete(true)}
              className="flex items-center gap-1.5 rounded-lg bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive ring-1 ring-destructive/20 hover:bg-destructive/20"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete {checked.size} selected
            </button>
          )}
        </div>
        <div className="flex rounded-xl bg-secondary p-1 text-xs font-medium ring-1 ring-border">
          {(["all", "clock", "hours"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`rounded-lg px-3 py-1.5 ${mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {m === "all" ? "All" : m === "clock" ? "Clock" : "Hours"}
            </button>
          ))}
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-secondary/30 px-5 py-3">
        <div className="relative flex-1 min-w-[14rem]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by name, employee ID, email…"
            className={`${inputCls} pl-9 py-1.5 text-sm`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        {departments.length > 0 && (
          <select className={`${inputCls} max-w-[10rem] py-1.5 text-sm`} value={dept} onChange={(e) => setDept(e.target.value)}>
            <option value="">All departments</option>
            {departments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        )}
        {positions.length > 0 && (
          <select className={`${inputCls} max-w-[10rem] py-1.5 text-sm`} value={position} onChange={(e) => setPosition(e.target.value)}>
            <option value="">All positions</option>
            {positions.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        )}
        {hasFilters && (
          <button
            onClick={() => { setSearch(""); setDept(""); setPosition(""); setMode("all"); }}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <Filter className="h-3 w-3" /> Clear filters
          </button>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {filtered.length} of {records.length}
        </span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
              {onDeleteMany && (
                <th className="w-10 px-3 py-3">
                  <input
                    type="checkbox"
                    checked={allVisibleChecked}
                    onChange={toggleAll}
                    className="h-3.5 w-3.5"
                  />
                </th>
              )}
              {showName && <th className="px-5 py-3 text-left font-medium">{sortBtn("name", "Employee")}</th>}
              <th className="px-3 py-3 text-left font-medium">{sortBtn("date", "Date")}</th>
              <th className="px-3 py-3 text-left font-medium">Type</th>
              <th className="px-3 py-3 text-right font-medium">In</th>
              <th className="px-3 py-3 text-right font-medium">Out</th>
              <th className="px-3 py-3 text-right font-medium">Lunch</th>
              <th className="px-3 py-3 text-right font-medium">{sortBtn("hours", "Hours")}</th>
              <th className="px-3 py-3 text-right font-medium">Rate</th>
              <th className="px-5 py-3 text-right font-medium">{sortBtn("pay", "Gross")}</th>
              {onDelete && <th className="w-10" />}
            </tr>
          </thead>
          <tbody className="font-mono text-[13px]">
            {filtered.length === 0 && (
              <tr>
                <td colSpan={11} className="px-5 py-10 text-center font-body text-muted-foreground">
                  {hasFilters ? "No records match your filters." : "No time records yet."}
                </td>
              </tr>
            )}
            {filtered.map((r) => {
              const emp = empById.get(r.employee_id) ?? r.employees;
              const rate = Number(emp?.hourly_rate ?? 0);
              const isChecked = checked.has(r.id);
              return (
                <tr
                  key={r.id}
                  className={`border-b border-border last:border-0 transition-colors ${isChecked ? "bg-primary/5" : "hover:bg-secondary/50"}`}
                >
                  {onDeleteMany && (
                    <td className="px-3 py-3">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleOne(r.id)}
                        className="h-3.5 w-3.5"
                      />
                    </td>
                  )}
                  {showName && (
                    <td className="px-5 py-3">
                      <div className="font-body font-medium">{emp ? fullName(emp) : "—"}</div>
                      {emp && (
                        <div className="text-[10px] text-muted-foreground">
                          {emp.employee_code}{emp.job_title ? ` · ${emp.job_title}` : ""}{emp.department ? ` · ${emp.department}` : ""}
                        </div>
                      )}
                    </td>
                  )}
                  <td className="px-3 py-3">{r.work_date}</td>
                  <td className="px-3 py-3">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${r.entry_mode === "clock" ? "bg-primary/15 text-primary" : "bg-accent/15 text-accent-foreground"}`}>
                      {r.entry_mode === "clock" ? "Clock" : "Hours"}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right text-muted-foreground">{r.clock_in?.slice(0, 5) ?? "—"}</td>
                  <td className="px-3 py-3 text-right text-muted-foreground">{r.clock_out?.slice(0, 5) ?? "—"}</td>
                  <td className="px-3 py-3 text-right text-muted-foreground">{r.entry_mode === "clock" ? r.lunch_minutes : "—"}</td>
                  <td className="px-3 py-3 text-right font-semibold">{Number(r.hours).toFixed(2)}</td>
                  <td className="px-3 py-3 text-right text-muted-foreground">{money(rate)}</td>
                  <td className="px-5 py-3 text-right font-semibold">{money(rate * Number(r.hours))}</td>
                  {onDelete && (
                    <td className="pr-4">
                      <button
                        onClick={() => onDelete(r.id)}
                        aria-label="Delete record"
                        className="text-muted-foreground transition-colors hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Confirm delete modal */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={() => setConfirmDelete(false)}>
          <div className="glass-panel max-w-sm space-y-4 p-6" onClick={(e) => e.stopPropagation()}>
            <div className="font-display text-lg font-extrabold">Delete {checked.size} records?</div>
            <p className="text-sm text-muted-foreground">This permanently removes the selected time records. This can't be undone.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDelete(false)} className="rounded-xl bg-secondary px-4 py-2 text-sm font-medium ring-1 ring-border text-muted-foreground hover:text-foreground">Cancel</button>
              <button onClick={doBulkDelete} className="rounded-xl bg-destructive px-4 py-2 text-sm font-semibold text-white hover:bg-destructive/90">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
