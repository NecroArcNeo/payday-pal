import { useMemo, useState } from "react";
import { Search, X, Trash2, Filter, Pencil, XCircle, ChevronDown } from "lucide-react";
import { fullName, money, computeHours, dayOfWeek, isWeekend, type Employee, type RecordWithEmp } from "@/lib/payroll";
import { inputCls } from "@/components/AppShell";

interface Props {
  records: RecordWithEmp[];
  employees?: Employee[];
  title?: string;
  onDelete?: (id: string) => void;
  onDeleteMany?: (ids: string[]) => void;
  onEdit?: (id: string, data: EditData) => Promise<void>;
  onEditMany?: (ids: string[], data: EditData) => Promise<void>;
  showName?: boolean;
  hasMore?: boolean;
  remainingCount?: number;
  onLoadMore?: () => void;
}

export interface EditData {
  work_date?: string;
  entry_mode?: "clock" | "hours";
  clock_in?: string | null;
  clock_out?: string | null;
  lunch_minutes?: number;
  hours?: number;
}

type SortKey = "date" | "name" | "hours" | "pay";

export function RecordsTable({ records, employees = [], title = "Time records", onDelete, onDeleteMany, onEdit, onEditMany, showName = true, hasMore = false, remainingCount = 0, onLoadMore }: Props) {
  const [mode, setMode] = useState<"all" | "clock" | "hours">("all");
  const [search, setSearch] = useState("");
  const [dept, setDept] = useState("");
  const [position, setPosition] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDesc, setSortDesc] = useState(true);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Edit modal state
  const [editSingle, setEditSingle] = useState<RecordWithEmp | null>(null);
  const [showBulkEdit, setShowBulkEdit] = useState(false);

  // Bulk edit form — fields are optional, only applied if changed
  const [bulkForm, setBulkForm] = useState<{
    work_date: string;
    entry_mode: "clock" | "hours";
    clock_in: string;
    clock_out: string;
    lunch_minutes: string;
    hours: string;
    useDate: boolean;
    useMode: boolean;
    useClockIn: boolean;
    useClockOut: boolean;
    useLunch: boolean;
    useHours: boolean;
  }>({
    work_date: "",
    entry_mode: "clock",
    clock_in: "09:00",
    clock_out: "17:00",
    lunch_minutes: "30",
    hours: "8",
    useDate: false,
    useMode: false,
    useClockIn: false,
    useClockOut: false,
    useLunch: false,
    useHours: false,
  });

  // Single edit form
  const [singleForm, setSingleForm] = useState({
    work_date: "",
    entry_mode: "clock" as "clock" | "hours",
    clock_in: "",
    clock_out: "",
    lunch_minutes: "",
    hours: "",
  });

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

  const empById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);

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

  const openEditSingle = (r: RecordWithEmp) => {
    setSingleForm({
      work_date: r.work_date,
      entry_mode: r.entry_mode as "clock" | "hours",
      clock_in: r.clock_in ?? "09:00",
      clock_out: r.clock_out ?? "17:00",
      lunch_minutes: String(r.lunch_minutes ?? 0),
      hours: String(r.hours ?? 0),
    });
    setEditSingle(r);
  };

  const submitSingleEdit = async () => {
    if (!editSingle || !onEdit) return;
    const data: EditData = {
      work_date: singleForm.work_date,
      entry_mode: singleForm.entry_mode,
    };
    if (singleForm.entry_mode === "clock") {
      data.clock_in = singleForm.clock_in;
      data.clock_out = singleForm.clock_out;
      data.lunch_minutes = Number(singleForm.lunch_minutes) || 0;
    } else {
      data.hours = Number(singleForm.hours) || 0;
    }
    await onEdit(editSingle.id, data);
    setEditSingle(null);
  };

  const submitBulkEdit = async () => {
    if (!onEditMany || checked.size === 0) return;
    const data: EditData = {};
    if (bulkForm.useDate) data.work_date = bulkForm.work_date;
    if (bulkForm.useMode) data.entry_mode = bulkForm.entry_mode;
    if (bulkForm.useMode && bulkForm.entry_mode === "clock") {
      if (bulkForm.useClockIn) data.clock_in = bulkForm.clock_in;
      if (bulkForm.useClockOut) data.clock_out = bulkForm.clock_out;
      if (bulkForm.useLunch) data.lunch_minutes = Number(bulkForm.lunch_minutes) || 0;
    }
    if (bulkForm.useMode && bulkForm.entry_mode === "hours") {
      if (bulkForm.useHours) data.hours = Number(bulkForm.hours) || 0;
    }
    if (!bulkForm.useMode) {
      // Keep existing mode but allow field overrides
      if (bulkForm.useClockIn) data.clock_in = bulkForm.clock_in;
      if (bulkForm.useClockOut) data.clock_out = bulkForm.clock_out;
      if (bulkForm.useLunch) data.lunch_minutes = Number(bulkForm.lunch_minutes) || 0;
      if (bulkForm.useHours) data.hours = Number(bulkForm.hours) || 0;
    }
    await onEditMany([...checked], data);
    setShowBulkEdit(false);
    setChecked(new Set());
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
  const singlePreview = singleForm.entry_mode === "clock"
    ? computeHours(singleForm.clock_in, singleForm.clock_out, Number(singleForm.lunch_minutes) || 0)
    : Number(singleForm.hours) || 0;

  return (
    <div className="glass-panel overflow-hidden">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
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
          {checked.size > 0 && onEditMany && (
            <button
              onClick={() => setShowBulkEdit(true)}
              className="flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary ring-1 ring-primary/20 hover:bg-primary/20"
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit {checked.size} selected
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
                  <input type="checkbox" checked={allVisibleChecked} onChange={toggleAll} className="h-3.5 w-3.5" />
                </th>
              )}
              {showName && <th className="px-5 py-3 text-left font-medium">{sortBtn("name", "Employee")}</th>}
              <th className="px-3 py-3 text-left font-medium">{sortBtn("date", "Date")}</th>
              <th className="px-3 py-3 text-left font-medium">Day</th>
              <th className="px-3 py-3 text-left font-medium">Type</th>
              <th className="px-3 py-3 text-right font-medium">In</th>
              <th className="px-3 py-3 text-right font-medium">Out</th>
              <th className="px-3 py-3 text-right font-medium">Lunch</th>
              <th className="px-3 py-3 text-right font-medium">{sortBtn("hours", "Hours")}</th>
              <th className="px-3 py-3 text-right font-medium">Rate</th>
              <th className="px-5 py-3 text-right font-medium">{sortBtn("pay", "Gross")}</th>
              {(onDelete || onEdit) && <th className="w-20" />}
            </tr>
          </thead>
          <tbody className="font-mono text-[13px]">
            {filtered.length === 0 && (
              <tr>
                <td colSpan={12} className="px-5 py-10 text-center font-body text-muted-foreground">
                  {hasFilters ? "No records match your filters." : "No time records yet."}
                </td>
              </tr>
            )}
            {filtered.map((r) => {
              const emp = empById.get(r.employee_id) ?? r.employees;
              const rate = Number(emp?.hourly_rate ?? 0);
              const isChecked = checked.has(r.id);
              const weekend = isWeekend(r.work_date);
              const dow = dayOfWeek(r.work_date);
              return (
                <tr
                  key={r.id}
                  className={`border-b border-border last:border-0 transition-colors ${isChecked ? "bg-primary/5" : "hover:bg-secondary/50"}`}
                >
                  {onDeleteMany && (
                    <td className="px-3 py-3">
                      <input type="checkbox" checked={isChecked} onChange={() => toggleOne(r.id)} className="h-3.5 w-3.5" />
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
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${weekend ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : "bg-secondary text-muted-foreground"}`}>
                      {dow}
                    </span>
                  </td>
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
                  {(onDelete || onEdit) && (
                    <td className="pr-4">
                      <div className="flex items-center gap-2">
                        {onEdit && (
                          <button
                            onClick={() => openEditSingle(r)}
                            aria-label="Edit record"
                            className="text-muted-foreground transition-colors hover:text-primary"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                        )}
                        {onDelete && (
                          <button
                            onClick={() => onDelete(r.id)}
                            aria-label="Delete record"
                            className="text-muted-foreground transition-colors hover:text-destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Load more */}
      {hasMore && onLoadMore && (
        <div className="flex items-center justify-center gap-3 border-t border-border px-5 py-4">
          <button
            onClick={onLoadMore}
            className="flex items-center gap-2 rounded-xl bg-secondary px-5 py-2.5 text-sm font-medium ring-1 ring-border text-muted-foreground transition-all hover:text-foreground hover:ring-primary/30"
          >
            <ChevronDown className="h-4 w-4" />
            Load {remainingCount > 40 ? "40 more" : `${remainingCount} more`}
            {remainingCount > 0 && <span className="text-muted-foreground/70">({remainingCount} remaining)</span>}
          </button>
        </div>
      )}

      {/* Single edit modal */}
      {editSingle && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={() => setEditSingle(null)}>
          <div className="glass-panel max-w-md space-y-4 p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <div>
                <div className="font-display text-lg font-extrabold">Edit record</div>
                <div className="text-xs text-muted-foreground">
                  {editSingle.employees ? fullName(editSingle.employees) : "Unknown"} · {editSingle.work_date} · {dayOfWeek(editSingle.work_date)}
                </div>
              </div>
              <button onClick={() => setEditSingle(null)} className="text-muted-foreground hover:text-foreground">
                <XCircle className="h-5 w-5" />
              </button>
            </div>

            <div className="flex rounded-xl bg-secondary p-1 text-xs font-medium ring-1 ring-border">
              {(["clock", "hours"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setSingleForm((f) => ({ ...f, entry_mode: m }))}
                  className={`flex-1 rounded-lg px-3 py-1.5 ${singleForm.entry_mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {m === "clock" ? "Clock in / out" : "Daily hours"}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="col-span-2">
                <span className="label-mono">Date</span>
                <input type="date" className={`${inputCls} mt-1`} value={singleForm.work_date} onChange={(e) => setSingleForm((f) => ({ ...f, work_date: e.target.value }))} />
              </label>
              {singleForm.entry_mode === "clock" ? (
                <>
                  <label>
                    <span className="label-mono">Clock in</span>
                    <input type="time" className={`${inputCls} mt-1`} value={singleForm.clock_in} onChange={(e) => setSingleForm((f) => ({ ...f, clock_in: e.target.value }))} />
                  </label>
                  <label>
                    <span className="label-mono">Clock out</span>
                    <input type="time" className={`${inputCls} mt-1`} value={singleForm.clock_out} onChange={(e) => setSingleForm((f) => ({ ...f, clock_out: e.target.value }))} />
                  </label>
                  <label>
                    <span className="label-mono">Lunch (min)</span>
                    <input type="number" min={0} className={`${inputCls} mt-1`} value={singleForm.lunch_minutes} onChange={(e) => setSingleForm((f) => ({ ...f, lunch_minutes: e.target.value }))} />
                  </label>
                </>
              ) : (
                <label className="col-span-2">
                  <span className="label-mono">Hours worked</span>
                  <input type="number" step="0.25" min={0} max={24} className={`${inputCls} mt-1`} value={singleForm.hours} onChange={(e) => setSingleForm((f) => ({ ...f, hours: e.target.value }))} />
                </label>
              )}
            </div>

            <div className="flex items-center justify-between">
              <span className="font-mono text-xs text-muted-foreground">{singlePreview.toFixed(2)} hours</span>
              <div className="flex gap-2">
                <button onClick={() => setEditSingle(null)} className="rounded-xl bg-secondary px-4 py-2 text-sm font-medium ring-1 ring-border text-muted-foreground hover:text-foreground">Cancel</button>
                <button onClick={submitSingleEdit} className="rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90">Save changes</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Bulk edit modal */}
      {showBulkEdit && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={() => setShowBulkEdit(false)}>
          <div className="glass-panel max-w-lg space-y-4 p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <div>
                <div className="font-display text-lg font-extrabold">Edit {checked.size} records</div>
                <div className="text-xs text-muted-foreground">Check the fields you want to change. Unchecked fields keep their current values.</div>
              </div>
              <button onClick={() => setShowBulkEdit(false)} className="text-muted-foreground hover:text-foreground">
                <XCircle className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-3">
              {/* Date */}
              <label className="flex items-center gap-3 rounded-xl bg-secondary p-3 ring-1 ring-border">
                <input type="checkbox" checked={bulkForm.useDate} onChange={() => setBulkForm((f) => ({ ...f, useDate: !f.useDate }))} className="h-4 w-4" />
                <div className="flex flex-1 items-center gap-3">
                  <span className="label-mono whitespace-nowrap">Date</span>
                  <input
                    type="date"
                    disabled={!bulkForm.useDate}
                    className={`${inputCls} flex-1 ${!bulkForm.useDate ? "opacity-40" : ""}`}
                    value={bulkForm.work_date}
                    onChange={(e) => setBulkForm((f) => ({ ...f, work_date: e.target.value }))}
                  />
                </div>
              </label>

              {/* Entry mode */}
              <div className="flex items-center gap-3 rounded-xl bg-secondary p-3 ring-1 ring-border">
                <input type="checkbox" checked={bulkForm.useMode} onChange={() => setBulkForm((f) => ({ ...f, useMode: !f.useMode }))} className="h-4 w-4" />
                <div className="flex flex-1 items-center gap-3">
                  <span className="label-mono whitespace-nowrap">Type</span>
                  <div className="flex flex-1 rounded-lg bg-background p-1 text-xs font-medium ring-1 ring-border">
                    {(["clock", "hours"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        disabled={!bulkForm.useMode}
                        onClick={() => setBulkForm((f) => ({ ...f, entry_mode: m }))}
                        className={`flex-1 rounded-lg px-3 py-1.5 ${bulkForm.entry_mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground"} ${!bulkForm.useMode ? "opacity-40" : ""}`}
                      >
                        {m === "clock" ? "Clock in / out" : "Daily hours"}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Clock fields */}
              <div className="grid grid-cols-3 gap-3">
                <label className={`flex items-center gap-2 rounded-xl bg-secondary p-3 ring-1 ring-border ${!bulkForm.useClockIn ? "opacity-60" : ""}`}>
                  <input type="checkbox" checked={bulkForm.useClockIn} onChange={() => setBulkForm((f) => ({ ...f, useClockIn: !f.useClockIn }))} className="h-4 w-4" />
                  <div className="flex-1">
                    <span className="label-mono">In</span>
                    <input type="time" disabled={!bulkForm.useClockIn} className={`${inputCls} mt-1`} value={bulkForm.clock_in} onChange={(e) => setBulkForm((f) => ({ ...f, clock_in: e.target.value }))} />
                  </div>
                </label>
                <label className={`flex items-center gap-2 rounded-xl bg-secondary p-3 ring-1 ring-border ${!bulkForm.useClockOut ? "opacity-60" : ""}`}>
                  <input type="checkbox" checked={bulkForm.useClockOut} onChange={() => setBulkForm((f) => ({ ...f, useClockOut: !f.useClockOut }))} className="h-4 w-4" />
                  <div className="flex-1">
                    <span className="label-mono">Out</span>
                    <input type="time" disabled={!bulkForm.useClockOut} className={`${inputCls} mt-1`} value={bulkForm.clock_out} onChange={(e) => setBulkForm((f) => ({ ...f, clock_out: e.target.value }))} />
                  </div>
                </label>
                <label className={`flex items-center gap-2 rounded-xl bg-secondary p-3 ring-1 ring-border ${!bulkForm.useLunch ? "opacity-60" : ""}`}>
                  <input type="checkbox" checked={bulkForm.useLunch} onChange={() => setBulkForm((f) => ({ ...f, useLunch: !f.useLunch }))} className="h-4 w-4" />
                  <div className="flex-1">
                    <span className="label-mono">Lunch</span>
                    <input type="number" min={0} disabled={!bulkForm.useLunch} className={`${inputCls} mt-1`} value={bulkForm.lunch_minutes} onChange={(e) => setBulkForm((f) => ({ ...f, lunch_minutes: e.target.value }))} />
                  </div>
                </label>
              </div>

              {/* Hours */}
              <label className={`flex items-center gap-3 rounded-xl bg-secondary p-3 ring-1 ring-border ${!bulkForm.useHours ? "opacity-60" : ""}`}>
                <input type="checkbox" checked={bulkForm.useHours} onChange={() => setBulkForm((f) => ({ ...f, useHours: !f.useHours }))} className="h-4 w-4" />
                <div className="flex flex-1 items-center gap-3">
                  <span className="label-mono whitespace-nowrap">Hours</span>
                  <input type="number" step="0.25" min={0} max={24} disabled={!bulkForm.useHours} className={`${inputCls} flex-1`} value={bulkForm.hours} onChange={(e) => setBulkForm((f) => ({ ...f, hours: e.target.value }))} />
                </div>
              </label>
            </div>

            <div className="flex justify-end gap-2">
              <button onClick={() => setShowBulkEdit(false)} className="rounded-xl bg-secondary px-4 py-2 text-sm font-medium ring-1 ring-border text-muted-foreground hover:text-foreground">Cancel</button>
              <button onClick={submitBulkEdit} className="rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90">Apply to {checked.size} records</button>
            </div>
          </div>
        </div>
      )}

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
