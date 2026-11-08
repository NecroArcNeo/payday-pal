import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { z } from "zod";
import { db, undoable } from "@/lib/db/mode";
import { backupBefore } from "@/lib/db/safety";
import { AppShell, btnGhost, btnPrimary, inputCls } from "@/components/AppShell";
import { SearchInput } from "@/components/EmployeeSearch";
import { DataTable } from "@/components/DataTable";
import { EmailLink } from "@/components/EmailLink";
import { CategoryInput } from "@/components/ProfileCategories";
import { codeTakenMessage, employeeWithCode, friendlySaveError } from "@/lib/employee-code";
import { planRateChange, type RatePlan } from "@/lib/pay-rates";
import { askRateDate, writeRateHistory } from "@/lib/rate-change";
import { confirmNewName, confirmRates } from "@/lib/typo-prompt";
import { fullName, money, useEmployeeDefaults, useEmployees, useFieldDefs, usePayRates, usePayrollSettings, useShifts, type Employee, type FieldDef, type Shift } from "@/lib/payroll";
import { NO_DEFAULTS, withDefaults } from "@/lib/employee-fields";
import { PAY_TYPES, shiftFor } from "@/lib/pay";
import { describeEmployeeFilter, isFiltering, NO_FILTER, searchEmployees, type EmployeeFilter } from "@/lib/employee-search";
import { IdCard, MinusCircle, Pencil, Trash2, X } from "lucide-react";
import { BulkDeductionDialog } from "@/components/DeductionsEditor";
import { EditableLabel } from "@/components/EditableLabel";
import { useLabels } from "@/lib/labels";
import { SkeletonRows } from "@/components/Loading";
import { EmployeePanel } from "@/components/EmployeePanel";
import { EmployeeContextMenu, EmployeeMenuButton } from "@/components/EmployeeMenu";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { SortControl, SortTh, TableSort, useTableSort } from "@/components/SortControl";
import { useDragSelect } from "@/components/DragSelect";
import { sortTable, type SortColumns } from "@/lib/table-sort";
import { askChoice, askConfirm, LEAVE_UNSAVED, modalOpen } from "@/lib/choice-prompt";
import { FoldBox } from "@/components/FoldBox";

export const Route = createFileRoute("/_authenticated/employees")({
  head: () => ({ meta: [{ title: "Employees — KoPayroll" }] }),
  component: EmployeesPage,
});

const schema = z.object({
  employee_code: z.string().trim().min(1, "ID required").max(40),
  first_name: z.string().trim().min(1, "First name required").max(80),
  last_name: z.string().trim().min(1, "Last name required").max(80),
  email: z.string().trim().email("Invalid email").max(255).or(z.literal("")),
  department: z.string().trim().max(80),
  hourly_rate: z.coerce.number().min(0).max(10000),
});

const empty = { employee_code: "", first_name: "", last_name: "", email: "", department: "", hourly_rate: "", shift_id: "", pay_type: "hourly" };

function EmployeesPage() {
  const { data: employees = [], isLoading } = useEmployees();
  const { data: defs = [] } = useFieldDefs();
  const { label } = useLabels();
  const { data: shifts = [] } = useShifts();
  const { data: defaults = NO_DEFAULTS } = useEmployeeDefaults();
  const { data: settings } = usePayrollSettings();
  const qc = useQueryClient();
  // The add form starts from the default profile.
  const defaultShift = shiftFor(defaults["shift_id"] as string | undefined, shifts).id ?? "";
  const blank = useMemo(() => {
    const d = (k: string) => (defaults[k] == null ? "" : String(defaults[k]));
    return { ...empty, email: d("email"), department: d("department"), hourly_rate: d("hourly_rate"), pay_type: defaults["pay_type"] === "salary" ? "salary" : "hourly", shift_id: defaultShift };
  }, [defaults, defaultShift]);
  const [form, setForm] = useState<Record<string, string>>(empty);
  useEffect(() => setForm(blank), [blank]);
  const [q, setQ] = useState<EmployeeFilter>(NO_FILTER);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkEdit, setBulkEdit] = useState(false);
  const [bulkDeduction, setBulkDeduction] = useState(false);
  const [busy, setBusy] = useState(false);

  // Forget selections of employees that no longer exist.
  useEffect(() => {
    setSelected((s) => {
      const live = new Set(employees.map((e) => e.id));
      const next = new Set([...s].filter((id) => live.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [employees]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = schema.safeParse(form);
    if (!parsed.success) { toast.error(parsed.error.issues[0]?.message ?? "Invalid input"); return; }
    const owner = employeeWithCode(employees, parsed.data.employee_code);
    if (owner) { toast.error(codeTakenMessage(parsed.data.employee_code, owner)); return; }
    if (!(await confirmNewName(parsed.data.first_name, parsed.data.last_name, employees))) return;
    const row = { ...parsed.data, email: parsed.data.email || null, department: parsed.data.department || null, shift_id: form["shift_id"] || shifts[0]?.id || null, pay_type: form["pay_type"] === "salary" ? "salary" : "hourly" };
    const { error } = await db().insert("employees", withDefaults(row, defaults));
    if (error) { toast.error(friendlySaveError(error.message)); return; }
    toast.success("Employee added");
    setForm(blank);
    qc.invalidateQueries({ queryKey: ["employees"] });
  };

  // Sorted by any column (name A to Z at first); the search narrows it, and ↑/↓ in the panel follow this order.
  const columns = useMemo<SortColumns<Employee>>(() => ({
    employee: { label: "Employee", kind: "text", value: fullName },
    employee_code: { label: "ID", kind: "text", value: (e) => e.employee_code },
    job_title: { label: "Position", kind: "text", value: (e) => e.job_title },
    department: { label: "Department", kind: "text", value: (e) => e.department },
    shift: { label: "Shift", kind: "text", value: (e) => shiftFor(e.shift_id, shifts).name },
    email: { label: "Email", kind: "text", value: (e) => e.email },
    hourly_rate: { label: "Rate", kind: "number", value: (e) => Number(e.hourly_rate) },
  }), [shifts]);
  const [sort, setSort] = useTableSort("meridian-employees-sort", columns, { by: "employee", desc: false });
  const list = useMemo(() => sortTable(searchEmployees(employees, q), sort, columns), [employees, q, sort, columns]);

  // The side panel: whose profile is open beside the roster. It stays open while the search changes (so typing a
  // search never throws away an unsaved edit), and closes by itself if that employee is deleted.
  const [openId, setOpenId] = useState<string | null>(null);
  const openEmp = openId ? employees.find((e) => e.id === openId) : undefined;
  const openIndex = openEmp ? list.indexOf(openEmp) : -1;
  // Unsaved changes in the panel's form (a ref: only read when moving, so typing doesn't re-render the roster).
  const dirty = useRef(false);
  const onDirty = useCallback((d: boolean) => { dirty.current = d; }, []);
  const open = useCallback(async (id: string | null) => {
    if (dirty.current && !(await askConfirm(LEAVE_UNSAVED))) return false;
    dirty.current = false;
    setOpenId(id);
    return true;
  }, []);
  useEffect(() => { if (openId && !isLoading && !openEmp) { dirty.current = false; setOpenId(null); } }, [openId, openEmp, isLoading]);
  const move = async (step: -1 | 1) => {
    // From someone the search hides, ↓ goes to the first shown and ↑ to the last.
    const next = openIndex < 0 ? list[step === 1 ? 0 : list.length - 1] : list[openIndex + step];
    if (next && (await open(next.id))) document.querySelector(`[data-employee="${next.id}"]`)?.scrollIntoView({ block: "nearest" });
  };
  const moveRef = useRef(move);
  moveRef.current = move;
  // Escape closes the panel; ↑/↓ step through the roster, except while typing in a field or while a dialog (a
  // question, a menu) has the keyboard.
  useEffect(() => {
    if (!openId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || modalOpen()) return;
      if (e.key === "Escape") { void open(null); return; }
      if ((e.target as HTMLElement).closest("input, select, textarea, [contenteditable=true], [role=tablist], [role=separator]")) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); void moveRef.current(e.key === "ArrowDown" ? 1 : -1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId, open]);
  const picked = employees.filter((e) => selected.has(e.id));
  const hiddenPicked = picked.filter((e) => !list.includes(e)).length;
  const allShownPicked = list.length > 0 && list.every((e) => selected.has(e.id));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleShown = () => setSelected((s) => {
    const n = new Set(s);
    for (const e of list) if (allShownPicked) n.delete(e.id); else n.add(e.id);
    return n;
  });
  const dragSelect = useDragSelect({ attr: "employee", order: list.map((e) => e.id), selected, setSelected });

  // The row menus (⋯ and right-click): which row was right-clicked, and what every row's menu can do.
  const [menuId, setMenuId] = useState<string | null>(null);
  const menuEmp = menuId ? employees.find((e) => e.id === menuId) : undefined;
  const menuProps = (e: Employee) => ({ emp: e, selected: selected.has(e.id), onOpen: () => void open(e.id), onToggle: () => toggle(e.id), onDelete: () => void removePeople([e]) });

  // Deleting people, one (the row menu) or the selection: says who and what goes with them, backs up first.
  const removePeople = async (people: Employee[]) => {
    const ids = people.map((e) => e.id);
    setBusy(true);
    try {
      // Show exactly what goes with them before asking.
      const [shifts, extras] = await Promise.all([db().listRecordKeys("0001-01-01", "9999-12-31"), db().listAdjustments()]);
      const set = new Set(ids);
      const recs = shifts.filter((s) => set.has(s.employee_id)).length;
      const adj = extras.filter((a) => set.has(a.employee_id)).length;
      const who = ids.length === 1 ? fullName(people[0]!) : `${ids.length} employees`;
      // Records on days locked as paid can't be deleted (the database refuses), so neither can their people: say so
      // before asking, rather than failing after, and offer what keeps their records instead.
      const lockedThrough = settings?.locked_through ?? null;
      const locked = lockedThrough ? (await db().listRecordsMatching({ employeeIds: ids, to: lockedThrough })).filter((r) => !r.unlocked) : [];
      if (locked.length) {
        const blocked = people.filter((e) => locked.some((r) => r.employee_id === e.id));
        const answer = await askChoice({
          title: blocked.length === 1 ? `${fullName(blocked[0]!)} has paid days, so can't be deleted` : `${blocked.length} of them have paid days, so can't be deleted`,
          detail: `Days up to ${lockedThrough} are locked as paid, and their records then are kept as they were paid. Marking them resigned keeps every record and stops them being offered when adding hours.`
            + (blocked.length < people.length ? "\n\nThe others can be deleted: untick these and delete again." : ""),
          items: blocked.map((e) => { const n = locked.filter((r) => r.employee_id === e.id).length; return `${fullName(e)} · ${n} paid record${n === 1 ? "" : "s"}`; }),
          choices: [{ id: "cancel", label: "Cancel" }, { id: "resign", label: blocked.length === 1 ? "Mark resigned instead" : `Mark ${blocked.length} resigned instead`, primary: true }],
        });
        if (answer?.id === "resign") {
          const { error } = await db().updateMany("employees", blocked.map((e) => ({ id: e.id, patch: { active: false } })) as never);
          if (error) throw error;
          toast.success(`Marked ${blocked.length === 1 ? fullName(blocked[0]!) : `${blocked.length} employees`} resigned. Ctrl+Z undoes it.`);
          qc.invalidateQueries({ queryKey: ["employees"] });
        }
        return;
      }
      if (!(await askConfirm({
        title: `Delete ${who}?`,
        detail: `${recs || adj ? `This also deletes their ${recs} time record${recs === 1 ? "" : "s"} and ${adj} extra-pay entr${adj === 1 ? "y" : "ies"}.` : `${ids.length === 1 ? "They have" : "None of them has"} any time records or extra pay.`}\n\nA backup is saved first, so you can restore it from Sync & backup.`,
        ...(ids.length > 1 ? { items: people.map((e) => `${fullName(e)} · ${e.employee_code}`) } : {}),
        confirm: `Delete ${who}`, danger: true,
      }))) return;
      await backupBefore("bulk-delete");
      const { error } = await db().removeMany("employees", ids);
      if (error) throw error;
      toast.success(`Deleted ${who}. A backup was saved in Sync & backup.`);
      setSelected((s) => { const n = new Set(s); for (const id of ids) n.delete(id); return n; });
      qc.invalidateQueries();
    } catch (e) {
      toast.error(`Nothing was deleted: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const field = (k: string, ph: string, type = "text", bad = false) => (
    <input className={`${inputCls} ${bad ? "ring-2 ring-destructive" : ""}`} type={type} step="0.01" placeholder={label(k, ph)} aria-label={label(k, ph)} aria-invalid={bad || undefined} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
  );
  // Say straight away when the ID being typed is someone else's.
  const codeOwner = employeeWithCode(employees, form["employee_code"] ?? "");

  return (
    <AppShell eyebrow="Directory" title={isLoading ? "Employees" : `${employees.length} employees`}>
      <FoldBox id="employees:add" title="Add an employee">
        <form onSubmit={save} className="glass-panel grid gap-3 p-5 md:grid-cols-9">
          <div>
            {field("employee_code", "Employee ID", "text", !!codeOwner)}
            {codeOwner && <div className="mt-1 text-[11px] text-destructive">Already used by {fullName(codeOwner)}</div>}
          </div>
          {field("first_name", "First name")}
          {field("last_name", "Last name")}
          {field("email", "Email", "email")}
          {field("department", "Department")}
          {field("hourly_rate", "Hourly rate", "number")}
          <select className={inputCls} value={form["pay_type"]} onChange={(e) => setForm({ ...form, pay_type: e.target.value })} aria-label="Pay type"
            title="Salary pays a full week (40 h) at the hourly rate for every week worked, with no overtime.">
            {PAY_TYPES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          <select className={inputCls} value={form["shift_id"] || shifts[0]?.id || ""} onChange={(e) => setForm({ ...form, shift_id: e.target.value })} aria-label="Shift">
            {shifts.map((s) => <option key={s.id} value={s.id}>{s.name} shift{Number(s.multiplier) !== 1 ? ` ×${Number(s.multiplier)}` : ""}</option>)}
            {shifts.length === 0 && <option value="">Day shift</option>}
          </select>
          <div className="flex gap-2">
            <button className={`${btnPrimary} flex-1`}>Add</button>
          </div>
        </form>
      </FoldBox>


      {bulkDeduction && picked.length > 0 && <BulkDeductionDialog people={picked} onClose={() => setBulkDeduction(false)} />}
      {bulkEdit && picked.length > 0 && (
        <BulkEditPanel employees={picked} defs={defs} shifts={shifts} onClose={() => setBulkEdit(false)}
          onDone={() => { setBulkEdit(false); qc.invalidateQueries(); }} />
      )}

      <FoldBox id="employees:roster" title="Roster" summary={`${employees.length} people`}>
        <div className="glass-panel overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="font-display font-extrabold tracking-tight">Roster</div>
              <Link to="/employees/template" className={btnGhost} title="The profile every new employee starts with"><IdCard className="mr-1 inline h-4 w-4" />Default profile</Link>
            </div>
            <div className="flex w-full max-w-3xl flex-wrap items-center justify-end gap-3">
              <SearchInput value={q} onChange={setQ} employees={employees} className="min-w-[16rem] flex-1" />
              <SortControl value={sort} onChange={setSort} columns={columns} />
            </div>
          </div>

          {picked.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-accent/60 px-5 py-2.5 text-sm">
              <span>
                <span className="font-semibold">{picked.length} selected</span>
                {hiddenPicked > 0 && <span className="text-muted-foreground"> ({hiddenPicked} hidden by the search)</span>}
              </span>
              <div className="flex gap-2">
                <button onClick={() => setBulkEdit(true)} disabled={busy} className={btnPrimary}><Pencil className="mr-1 inline h-4 w-4" />Edit {picked.length}</button>
                {settings?.deductions_on && <button onClick={() => setBulkDeduction(true)} disabled={busy} className={btnGhost}><MinusCircle className="mr-1 inline h-4 w-4" />Add deduction</button>}
                <button onClick={() => void removePeople(picked)} disabled={busy} className={`${btnGhost} hover:!text-destructive`}><Trash2 className="mr-1 inline h-4 w-4" />Delete {picked.length}</button>
                <button onClick={() => setSelected(new Set())} className={btnGhost} aria-label="Clear selection"><X className="h-4 w-4" /></button>
              </div>
            </div>
          )}

          <DataTable id="employees" className="w-full text-sm">
            <thead>
              <TableSort sort={sort} columns={columns} onSort={setSort}>
              <tr className="border-b border-border font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                <th className="w-10 pl-5"><input type="checkbox" aria-label="Select all shown" checked={allShownPicked} onChange={toggleShown} disabled={!list.length} /></th>
                <SortTh k="employee" className="px-3 py-3 text-left font-medium"><EditableLabel k="employee" name="Employee" /></SortTh>
                <SortTh k="employee_code" className="px-3 py-3 text-left font-medium"><EditableLabel k="employee_code" name="ID" /></SortTh>
                <SortTh k="job_title" className="px-3 py-3 text-left font-medium"><EditableLabel k="job_title" name="Position" /></SortTh>
                <SortTh k="department" className="px-3 py-3 text-left font-medium"><EditableLabel k="department" name="Department" /></SortTh>
                <SortTh k="shift" className="px-3 py-3 text-left font-medium"><EditableLabel k="shift" name="Shift" /></SortTh>
                <SortTh k="email" className="px-3 py-3 text-left font-medium"><EditableLabel k="email" name="Email" /></SortTh>
                <SortTh k="hourly_rate" className="px-3 py-3 text-right font-medium"><EditableLabel k="hourly_rate" name="Rate" /></SortTh>
                <th className="w-20" />
              </tr>
              </TableSort>
            </thead>
            <ContextMenu modal={false} onOpenChange={(o) => { if (!o) setMenuId(null); }}>
            <ContextMenuTrigger asChild>
            <tbody onPointerDown={dragSelect}
              // Which row the right-click menu is for; outside a row (the "no employees" line) there's no menu, and the
              // browser's own isn't wanted either, so the event stops here (Radix skips a prevented event).
              onContextMenu={(ev) => {
                const id = (ev.target as HTMLElement).closest<HTMLElement>("tr[data-employee]")?.dataset["employee"];
                if (id) setMenuId(id); else ev.preventDefault();
              }}>
              {isLoading && <SkeletonRows cols={9} skip={1} />}
              {!isLoading && list.length === 0 && (
                <tr><td colSpan={9} className="px-5 py-10 text-center text-muted-foreground">
                  {employees.length ? `No employee matches ${describeEmployeeFilter(q)}.` : "No employees yet — add one above or import a file."}
                </td></tr>
              )}
              {list.map((e) => (
                <tr key={e.id} data-employee={e.id}
                  // A click on the row (not its tick box, links or buttons, nor the end of a text selection) opens the
                  // profile beside the roster; the name still opens the full page.
                  // (The ⋯ menu is portalled, but React still passes its clicks up through this row: [role=menu] skips them.)
                  onClick={(ev) => { if (!(ev.target as HTMLElement).closest("a, button, input, label, [role=menu]") && !getSelection()?.toString()) void open(e.id); }}
                  className={`cursor-pointer border-b border-border last:border-0 hover:bg-secondary ${selected.has(e.id) ? "bg-accent/40" : ""} ${e.id === openId ? "outline outline-2 -outline-offset-2 outline-primary" : ""}`}>
                  <td className="pl-5"><input type="checkbox" aria-label={`Select ${fullName(e)}`} checked={selected.has(e.id)} onChange={() => toggle(e.id)} /></td>
                  <td className="px-3 py-3 font-medium">
                    <Link to="/employees/$id" params={{ id: e.id }} className="hover:underline">{fullName(e)}</Link>
                    {!e.active && <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground ring-1 ring-border">Resigned</span>}
                  </td>
                  <td className="px-3 py-3 font-mono text-[13px]">{e.employee_code}</td>
                  <td className="px-3 py-3 text-muted-foreground">{e.job_title ?? "—"}</td>
                  <td className="px-3 py-3 text-muted-foreground">{e.department ?? "—"}</td>
                  <td className="px-3 py-3 text-muted-foreground">{shiftFor(e.shift_id, shifts).name}</td>
                  <td className="px-3 py-3 text-muted-foreground">{e.email ? <EmailLink email={e.email} /> : "—"}</td>
                  <td className="px-3 py-3 text-right font-mono text-[13px]">{money(Number(e.hourly_rate))}<div className="font-body text-[10px] text-muted-foreground">{e.pay_type === "salary" ? "salary" : "hourly"}</div></td>
                  <td className="py-3 pl-3 pr-6">
                    <div className="flex items-center justify-end gap-3.5 text-muted-foreground">
                      <Link to="/employees/$id" params={{ id: e.id }} aria-label={`Edit ${fullName(e)}`} title="Edit profile"><Pencil className="h-4 w-4 hover:text-foreground" /></Link>
                      <EmployeeMenuButton {...menuProps(e)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            </ContextMenuTrigger>
            {menuEmp && <EmployeeContextMenu {...menuProps(menuEmp)} />}
            </ContextMenu>
          </DataTable>
          {isFiltering(q) && list.length > 0 && <div className="border-t border-border px-5 py-2 text-xs text-muted-foreground">Showing {list.length} of {employees.length}</div>}
        </div>
      </FoldBox>

      {openEmp && (
        <EmployeePanel emp={openEmp} employees={employees} onMove={move} onClose={() => open(null)} onDirty={onDirty}
          position={openIndex >= 0 ? `${openIndex + 1} of ${list.length}` : "hidden by the search"} />
      )}
    </AppShell>
  );
}

// ---------------------------------------------------------------- bulk edit

type RateMode = "set" | "pct" | "add";
const textFields = [
  { key: "department", label: "Department", max: 80 },
  { key: "job_title", label: "Position / job title", max: 80 },
  { key: "gender", label: "Gender", max: 80 },
  { key: "nationality", label: "Nationality", max: 80 },
  { key: "residential_status", label: "Residential status", max: 80 },
  { key: "city", label: "City", max: 80 },
  { key: "state", label: "State / region", max: 80 },
] as const;

/** Changes only the fields that are ticked, on every selected employee. */
function BulkEditPanel({ employees, defs, shifts, onClose, onDone }: { employees: Employee[]; defs: FieldDef[]; shifts: Shift[]; onClose: () => void; onDone: () => void }) {
  const fields = textFields;
  const editableDefs = defs;
  const [on, setOn] = useState<Record<string, boolean>>({});
  const [vals, setVals] = useState<Record<string, string>>({});
  const [rateMode, setRateMode] = useState<RateMode>("set");
  const { data: rateHistory } = usePayRates();
  const [active, setActive] = useState(true);
  const [shiftId, setShiftId] = useState(shifts[0]?.id ?? "");
  const [payType, setPayType] = useState("hourly");
  const [busy, setBusy] = useState(false);

  const tick = (k: string) => (
    <input type="checkbox" checked={!!on[k]} onChange={(e) => setOn({ ...on, [k]: e.target.checked })} aria-label={`Change ${k}`} />
  );
  const val = (k: string) => vals[k] ?? "";
  const setVal = (k: string, v: string) => { setVals({ ...vals, [k]: v }); setOn((o) => ({ ...o, [k]: true })); };

  const rateNum = Number(val("rate"));
  const newRate = (e: Employee) => {
    const cur = Number(e.hourly_rate);
    const r = rateMode === "set" ? rateNum : rateMode === "pct" ? cur * (1 + rateNum / 100) : cur + rateNum;
    return Math.round(r * 100) / 100;
  };

  const changes: string[] = [];
  for (const f of fields) if (on[f.key]) changes.push(val(f.key).trim() ? `${f.label} → “${val(f.key).trim()}”` : `clear ${f.label}`);
  if (on["rate"]) changes.push(rateMode === "set" ? `rate → ${money(rateNum || 0)}` : rateMode === "pct" ? `rate ${rateNum >= 0 ? "+" : ""}${rateNum || 0}%` : `rate ${rateNum >= 0 ? "+" : "−"}${money(Math.abs(rateNum || 0))}`);
  if (on["active"]) changes.push(active ? "mark active" : "mark resigned");
  if (on["pay_type"]) changes.push(`pay type → ${payType === "salary" ? "salary" : "hourly"}`);
  if (on["shift"]) changes.push(`shift → ${shifts.find((s) => s.id === shiftId)?.name ?? "?"}`);
  for (const d of editableDefs) if (on[`custom:${d.id}`]) changes.push(val(`custom:${d.id}`).trim() ? `${d.label} → “${val(`custom:${d.id}`).trim()}”` : `clear ${d.label}`);

  const apply = async () => {
    if (on["rate"]) {
      if (val("rate").trim() === "" || !Number.isFinite(rateNum)) { toast.error("Enter a number for the hourly rate"); return; }
      const bad = employees.find((e) => newRate(e) < 0 || newRate(e) > 10000);
      if (bad) { toast.error(`That would make ${fullName(bad)}'s rate ${money(newRate(bad))}. Rates must be between $0 and $10,000.`); return; }
    }
    // New rates: ask from which day, and keep everyone's old rate for the days before.
    const ratePlans = new Map<string, RatePlan>();
    if (on["rate"]) {
      const changed = employees.filter((e) => newRate(e) !== Number(e.hourly_rate));
      if (changed.length) {
        if (!(await confirmRates(changed.map((e) => ({ name: fullName(e), oldRate: Number(e.hourly_rate), newRate: newRate(e) }))))) return;
        const when = await askRateDate(`New hourly rate for ${changed.length} employee${changed.length === 1 ? "" : "s"}`, "their current rates", null);
        if (!when) return;
        for (const e of changed) ratePlans.set(e.id, planRateChange(rateHistory?.get(e.id) ?? [], Number(e.hourly_rate), newRate(e), when));
      }
    }
    const rows = employees.map((e) => {
      const patch: Record<string, unknown> = {};
      for (const f of fields) if (on[f.key]) patch[f.key] = val(f.key).trim().slice(0, f.max) || null;
      if (on["rate"]) patch["hourly_rate"] = ratePlans.get(e.id)?.current ?? newRate(e);
      if (on["active"]) patch["active"] = active;
      if (on["shift"]) patch["shift_id"] = shiftId;
      if (on["pay_type"]) patch["pay_type"] = payType;
      const custom = { ...((e.custom_fields ?? {}) as Record<string, string>) };
      let customChanged = false;
      for (const d of editableDefs) {
        const k = `custom:${d.id}`;
        if (!on[k]) continue;
        customChanged = true;
        const v = val(k).trim().slice(0, 1000);
        if (v) custom[d.id] = v; else delete custom[d.id];
      }
      if (customChanged) patch["custom_fields"] = custom;
      return { id: e.id, patch };
    });
    setBusy(true);
    try {
      await backupBefore("bulk-edit");
      // The rates' history and the employees together: one undo step, and all or nothing (a failure throws, and
      // undoable puts back what was already written).
      const updated = await undoable(`edited ${rows.length} employee${rows.length === 1 ? "" : "s"}`, async () => {
        for (const [id, plan] of ratePlans) {
          const err = await writeRateHistory(id, plan);
          if (err) throw new Error(err);
        }
        const r = await db().updateMany("employees", rows as never);
        if (r.error) throw r.error;
        return r.updated;
      });
      toast.success(`Updated ${updated} employee${updated === 1 ? "" : "s"}. A backup was saved in Sync & backup.`);
      onDone();
    } catch (e) {
      toast.error(`Nothing was changed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const row = (k: string, label: string, control: React.ReactNode) => (
    <label key={k} className={`flex items-center gap-3 rounded-xl p-2 ring-1 ${on[k] ? "bg-accent/50 ring-primary/25" : "ring-border"}`}>
      {tick(k)}
      <span className="w-40 shrink-0 text-sm"><EditableLabel k={k === "rate" ? "hourly_rate" : k} name={label} /></span>
      <div className="min-w-0 flex-1">{control}</div>
    </label>
  );

  return (
    <div className="glass-panel space-y-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-display font-extrabold tracking-tight">Edit {employees.length} employees</div>
          <p className="text-xs text-muted-foreground">
            Tick what to change. Unticked fields stay as they are for each person; a ticked field left empty is cleared.
            {" "}{employees.slice(0, 6).map(fullName).join(", ")}{employees.length > 6 ? ` and ${employees.length - 6} more` : ""}.
          </p>
        </div>
        <button onClick={onClose} className={btnGhost} aria-label="Close"><X className="h-4 w-4" /></button>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {fields.map((f) => row(f.key, f.label, <input className={inputCls} value={val(f.key)} onChange={(e) => setVal(f.key, e.target.value)} placeholder="New value" />))}
        {row("rate", "Hourly rate", (
          <div className="flex gap-2">
            <select className={`${inputCls} w-auto`} value={rateMode} onChange={(e) => { setRateMode(e.target.value as RateMode); setOn((o) => ({ ...o, rate: true })); }}>
              <option value="set">Set to $</option>
              <option value="pct">Change by %</option>
              <option value="add">Change by $</option>
            </select>
            <input className={inputCls} type="number" step="0.01" value={val("rate")} onChange={(e) => setVal("rate", e.target.value)} placeholder={rateMode === "set" ? "25.00" : rateMode === "pct" ? "5 or -5" : "1.50 or -1.50"} />
          </div>
        ))}
        {row("active", "Status", (
          <select className={inputCls} value={active ? "1" : "0"} onChange={(e) => { setActive(e.target.value === "1"); setOn((o) => ({ ...o, active: true })); }}>
            <option value="1">Active</option>
            <option value="0">Resigned</option>
          </select>
        ))}
        {row("pay_type", "Pay type", (
          <select className={inputCls} value={payType} onChange={(e) => { setPayType(e.target.value); setOn((o) => ({ ...o, pay_type: true })); }}>
            {PAY_TYPES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        ))}
        {shifts.length > 0 && row("shift", "Shift", (
          <select className={inputCls} value={shiftId} onChange={(e) => { setShiftId(e.target.value); setOn((o) => ({ ...o, shift: true })); }}>
            {shifts.map((s) => <option key={s.id} value={s.id}>{s.name}{Number(s.multiplier) !== 1 ? ` (×${Number(s.multiplier)})` : ""}</option>)}
          </select>
        ))}
        {editableDefs.map((d) => row(`custom:${d.id}`, d.label, <div><CategoryInput type={d.field_type} className={`${inputCls} w-full`} value={val(`custom:${d.id}`)} onChange={(v) => setVal(`custom:${d.id}`, v)} placeholder="New value" /></div>))}
      </div>
      {on["rate"] && val("rate").trim() !== "" && Number.isFinite(rateNum) && (
        <div className="text-xs text-muted-foreground">
          New rates: {employees.slice(0, 5).map((e) => `${fullName(e)} ${money(Number(e.hourly_rate))} → ${money(newRate(e))}`).join(" · ")}{employees.length > 5 ? " · …" : ""}
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">{changes.length ? changes.join(" · ") : "Nothing ticked yet."}</div>
        <button onClick={() => undoable(`edited ${employees.length === 1 ? "an employee" : `${employees.length} employees`}`, apply)} disabled={!changes.length || busy} className={btnPrimary}>{busy ? "Saving…" : `Apply to ${employees.length}`}</button>
      </div>
    </div>
  );
}
