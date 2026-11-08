import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type TdHTMLAttributes } from "react";
import { toast } from "sonner";
import { Grid3x3 } from "lucide-react";
import { db } from "@/lib/db/mode";
import { backupBefore } from "@/lib/db/safety";
import { readPasted } from "@/lib/import/paste";
import { usePref } from "@/lib/prefs";
import { cellText, gridColumns, isLocked, planGridPaste, readCell, type GridContext, type GridKey, type GridRecord } from "@/lib/record-grid";
import { localDayOrder } from "@/lib/typed-date";
import { isoDate, fullName, type Employee, type Shift } from "@/lib/payroll";
import { shiftFor } from "@/lib/pay";
import { useBreakUnit } from "@/lib/breaks";
import { askConfirm, modalOpen } from "@/lib/choice-prompt";
import { confirmLongRecords } from "@/lib/typo-prompt";

// "Edit in cells" on Time records: the table works like a spreadsheet. Click a cell (or move with the arrow keys),
// type to replace it, or Enter / F2 / double-click to change it; Enter saves and moves down, Tab moves right, Escape
// cancels. Ctrl+C copies a cell; Ctrl+V pastes a block (from Excel or anywhere) over the cells from the active one,
// as one change (one Ctrl+Z). Rows on days locked as paid can't change. Each saved cell is one undo step; what can be
// typed, and how it's read, is src/lib/record-grid.ts.

export const GRID_PREF = "meridian-records-grid";
export const useGridMode = () => usePref<boolean>(GRID_PREF, false);

export function GridModeToggle() {
  const [on, setOn] = useGridMode();
  return (
    <button type="button" data-find="edit-in-cells" onClick={() => setOn(!on)} aria-pressed={on}
      title={on ? "Back to opening a record in the side panel when its row is clicked" : "Type straight into the table like a spreadsheet; paste blocks from Excel"}
      className={`rounded-xl px-3 py-1.5 text-xs font-medium ring-1 ring-border ${on ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`}>
      <Grid3x3 className="mr-1 inline h-3.5 w-3.5" />Edit in cells
    </button>
  );
}

type Cell = { id: string; key: GridKey };

export function useRecordGrid({ on, rows, mode, employees, shifts, lockedThrough, onChanged }: {
  on: boolean; rows: GridRecord[]; mode: "clock" | "hours"; employees: Employee[]; shifts: Shift[]; lockedThrough: string | null; onChanged: () => void;
}) {
  const [unit] = useBreakUnit();
  const [active, setActive] = useState<Cell | null>(null);
  /** The text being typed, while a cell is being edited. */
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // Set while the code moves the focus from a cell's text box back to the table, so that blur doesn't save it again.
  const leaving = useRef(false);
  // Editing begun by typing keeps the caret after what was typed (as in a spreadsheet); begun with Enter, F2 or a
  // double-click, it selects the cell's text, so typing replaces it.
  const typedFirst = useRef(false);
  const focusBox = () => { leaving.current = true; box.current?.focus({ preventScroll: true }); leaving.current = false; };
  const cols = gridColumns(mode);
  const empById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const ctx: GridContext = useMemo(() => ({
    today: isoDate(new Date()), order: localDayOrder(), unit, shifts, lockedThrough,
    usualShift: (id) => shiftFor(empById.get(id)?.shift_id, shifts).id,
  }), [unit, shifts, lockedThrough, empById]);

  // Off, another entry type, or the row gone: nothing is active.
  useEffect(() => { if (!on) { setActive(null); setDraft(null); } }, [on]);
  useEffect(() => { setActive((a) => (a && cols.includes(a.key) && rows.some((r) => r.id === a.id) ? a : null)); }, [rows, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const rowOf = (id: string) => rows.find((r) => r.id === id);
  const nameOf = (id: string) => { const e = empById.get(id); return e ? fullName(e) : "Someone"; };

  const go = (cell: Cell | null) => {
    setActive(cell);
    setDraft(null);
    if (cell) requestAnimationFrame(() => document.querySelector(`[data-cell="${cell.id}|${cell.key}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  };
  const step = (from: Cell, down: number, right: number): Cell | null => {
    const r = rows.findIndex((x) => x.id === from.id) + down;
    const c = cols.indexOf(from.key) + right;
    if (r < 0 || r >= rows.length || c < 0 || c >= cols.length) return from;
    return { id: rows[r]!.id, key: cols[c]! };
  };

  /** Saves the typed text into the active cell; true when it's saved (or nothing changed). */
  const commit = async (cell: Cell, text: string): Promise<boolean> => {
    const r = rowOf(cell.id);
    if (!r) return true;
    if (text === cellText(r, cell.key, ctx)) return true;
    if (isLocked(r, lockedThrough)) { toast.error(`${r.work_date} is locked as paid. Unlock the record (its lock icon) to change it.`); return false; }
    const change = readCell(r, cell.key, text, ctx);
    if ("error" in change) { toast.error(change.error); return false; }
    if (!(await confirmLongRecords([{ ...r, ...change.patch } as GridRecord], nameOf))) return false;
    setSaving(true);
    const { error } = await db().update("time_records", r.id, change.patch);
    setSaving(false);
    if (error) { toast.error(error.message); return false; }
    onChanged();
    return true;
  };

  const startEdit = (cell: Cell, text?: string) => {
    const r = rowOf(cell.id);
    if (!r) return;
    if (isLocked(r, lockedThrough)) { toast.error(`${r.work_date} is locked as paid. Unlock the record (its lock icon) to change it.`); return; }
    setActive(cell);
    typedFirst.current = text !== undefined;
    setDraft(text ?? cellText(r, cell.key, ctx));
  };

  // Keys on the table while a cell is active and not being edited.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!on || !active || draft !== null || modalOpen() || (e.target as HTMLElement).closest("input, select, textarea, button, a")) return;
    const k = e.key;
    const move = (down: number, right: number) => { e.preventDefault(); go(step(active, down, right)); };
    if (k === "ArrowDown") return move(1, 0);
    if (k === "ArrowUp") return move(-1, 0);
    if (k === "ArrowRight") return move(0, 1);
    if (k === "ArrowLeft") return move(0, -1);
    if (k === "Tab") return move(0, e.shiftKey ? -1 : 1);
    if (k === "Escape") { e.preventDefault(); go(null); return; }
    if (k === "Enter" || k === "F2") { e.preventDefault(); startEdit(active); return; }
    if ((k === "Delete" || k === "Backspace") && active.key === "note") { e.preventDefault(); void commit(active, ""); return; }
    if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); startEdit(active, k); }
  };

  // Keys in the cell's text box.
  const onEditorKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!active) return;
    const k = e.key;
    const finish = async (down: number, right: number) => {
      e.preventDefault();
      e.stopPropagation();
      const cell = active;
      if (await commit(cell, draft ?? "")) { go(step(cell, down, right)); focusBox(); }
    };
    if (k === "Enter") void finish(e.shiftKey ? -1 : 1, 0);
    else if (k === "Tab") void finish(0, e.shiftKey ? -1 : 1);
    else if (k === "Escape") { e.preventDefault(); e.stopPropagation(); setDraft(null); focusBox(); }
  };

  const onCopy = (e: ClipboardEvent<HTMLDivElement>) => {
    if (!on || !active || draft !== null) return;
    const r = rowOf(active.id);
    if (!r) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", cellText(r, active.key, ctx));
  };

  const onPaste = async (e: ClipboardEvent<HTMLDivElement>) => {
    if (!on || !active || draft !== null) return;
    e.preventDefault();
    const sheet = readPasted(e.clipboardData.getData("text/plain"), e.clipboardData.getData("text/html"));
    if (!sheet) return;
    const block = sheet.grid.map((line) => line.map((c) => c.text));
    // One value pasted into one cell is just typing it.
    if (block.length === 1 && block[0]!.length === 1) { await commit(active, block[0]![0]!); return; }
    const plan = planGridPaste(rows, active.id, active.key, block, mode, ctx);
    if (!plan.updates.length) { toast.error(plan.errors[0] ?? "Nothing in the paste could go into those cells"); return; }
    const after = plan.updates.map((u) => ({ ...rowOf(u.id)!, ...u.patch }) as GridRecord);
    if (!(await confirmLongRecords(after, nameOf))) return;
    const skipped = [
      plan.errors.length && `${plan.errors.length} cell${plan.errors.length === 1 ? "" : "s"} that didn't read`,
      plan.locked && `${plan.locked} row${plan.locked === 1 ? "" : "s"} on locked days`,
      plan.outside && `${plan.outside} cell${plan.outside === 1 ? "" : "s"} past the table's edge`,
    ].filter(Boolean) as string[];
    if (!(await askConfirm({
      title: `Paste into ${plan.cells} cell${plan.cells === 1 ? "" : "s"} of ${plan.updates.length} record${plan.updates.length === 1 ? "" : "s"}?`,
      detail: `${skipped.length ? `Left out: ${skipped.join(", ")}. ` : ""}A backup is saved first, and Ctrl+Z takes the whole paste back.`,
      ...(plan.errors.length ? { items: plan.errors.slice(0, 15) } : {}),
      confirm: "Paste",
    }))) return;
    setSaving(true);
    try {
      await backupBefore("record-edit");
      const { error, updated } = await db().updateMany("time_records", plan.updates as never);
      if (error) throw error;
      toast.success(`Pasted into ${updated} record${updated === 1 ? "" : "s"}`);
      onChanged();
    } catch (err) {
      toast.error(`Nothing was pasted: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  /** Props for the table's box: it holds the keyboard focus while a cell is active, and handles copy and paste. */
  const boxProps = on ? {
    ref: box, tabIndex: -1, onKeyDown, onCopy, onPaste: (e: ClipboardEvent<HTMLDivElement>) => void onPaste(e),
    // Ctrl+V here goes into the cells, not to the Import page (usePasteRows skips it).
    "data-own-paste": "",
  } : {};

  /** Props for an editable cell (none when the mode is off). */
  const cell = (r: GridRecord, key: GridKey): TdHTMLAttributes<HTMLTableCellElement> & { "data-cell"?: string } => {
    if (!on) return {};
    const isActive = active?.id === r.id && active.key === key;
    const locked = isLocked(r, lockedThrough);
    return {
      "data-cell": `${r.id}|${key}`,
      className: `grid-cell ${isActive ? "grid-cell-active" : ""} ${locked ? "cursor-not-allowed" : "cursor-cell"}`,
      onMouseDown: (e) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest("input, a, button")) return;
        e.preventDefault(); // no text selection; the box keeps the focus
        const was = draft !== null && active ? active : null;
        const next = { id: r.id, key };
        // Clicking another cell while typing saves what was typed first.
        void (async () => {
          if (was && !(was.id === r.id && was.key === key) && !(await commit(was, draft ?? ""))) return;
          if (!(was && was.id === r.id && was.key === key)) go(next);
          focusBox();
        })();
      },
      onDoubleClick: () => startEdit({ id: r.id, key }),
    };
  };

  /** The text box in the cell being edited, or null to show the cell as usual. */
  const editor = (r: GridRecord, key: GridKey) => {
    if (!on || draft === null || active?.id !== r.id || active.key !== key) return null;
    return (
      <input autoFocus value={draft} disabled={saving} onChange={(e) => setDraft(e.target.value)} onKeyDown={onEditorKey}
        onBlur={() => { if (!leaving.current && draft !== null && active) void commit(active, draft).then((ok) => { if (ok) setDraft(null); }); }}
        onFocus={(e) => { const el = e.currentTarget; if (typedFirst.current) el.setSelectionRange(el.value.length, el.value.length); else el.select(); }}
        className="w-full min-w-[5rem] rounded-md bg-background px-1.5 py-0.5 font-mono text-[13px] outline-none ring-2 ring-primary"
        aria-label={`Edit ${key.replace("_", " ")}`} />
    );
  };

  return { on, active, boxProps, cell, editor };
}
