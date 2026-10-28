import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { toast } from "sonner";
import { ChevronDown, Download, FileSpreadsheet, Pencil, Upload, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { btnGhost, btnPrimary, inputCls } from "@/components/AppShell";
import { downloadBlob } from "@/lib/db/backups";
import {
  colLetters, fromBase64, getTemplates, MAX_TEMPLATE_BYTES, plainCsv, plainXlsx, ROW_FIELDS, saveTemplates, SHEET_FIELDS, templateCells, templateProblems, toBase64, useTemplates,
  type RowField, type SheetField, type TimesheetData, type TimesheetTemplate,
} from "@/lib/export/timesheet-export";
import { fillTemplate, parseAddress, templateSheets } from "@/lib/export/xlsx-template";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "-").trim() || "timesheet";

/** The Timesheet page's Export menu: a plain Excel or CSV file, or the period filled into one of the user's templates. */
export function TimesheetExport({ data, fileName }: { data: (per: "record" | "day") => TimesheetData; fileName: string }) {
  const templates = useTemplates();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<TimesheetTemplate | "new" | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const run = (fn: () => void) => { setOpen(false); try { fn(); } catch (e) { toast.error((e as Error).message); } };
  const plain = (kind: "xlsx" | "csv") => run(() => {
    const d = data("record");
    if (kind === "xlsx") downloadBlob(new Blob([plainXlsx(d) as Uint8Array<ArrayBuffer>], { type: XLSX_TYPE }), `${safeName(fileName)}.xlsx`);
    else downloadBlob(new Blob(["﻿" + plainCsv(d)], { type: "text/csv" }), `${safeName(fileName)}.csv`);
  });
  const filled = (t: TimesheetTemplate) => run(() => {
    const out = fillTemplate(fromBase64(t.file), t.sheet, templateCells(t, data(t.table.per)));
    const ext = /\.xlsm$/i.test(t.fileName) ? "xlsm" : "xlsx";
    downloadBlob(new Blob([out as Uint8Array<ArrayBuffer>], { type: ext === "xlsm" ? "application/vnd.ms-excel.sheet.macroEnabled.12" : XLSX_TYPE }), `${safeName(`${t.name} ${fileName}`)}.${ext}`);
    toast.success(`Saved with the "${t.name}" template`);
  });

  const item = "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-secondary";
  return (
    <div ref={box} className="relative print:hidden">
      <button type="button" onClick={() => setOpen(!open)} className={btnGhost} aria-haspopup="menu" aria-expanded={open}>
        <Download className="mr-1 inline h-4 w-4" />Export<ChevronDown className="ml-1 inline h-3.5 w-3.5" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-20 mt-1 w-72 rounded-xl border border-border bg-background p-1.5 shadow-xl">
          <button role="menuitem" className={item} onClick={() => plain("xlsx")}><FileSpreadsheet className="h-4 w-4 text-muted-foreground" />Excel file (.xlsx)</button>
          <button role="menuitem" className={item} onClick={() => plain("csv")}><FileSpreadsheet className="h-4 w-4 text-muted-foreground" />CSV file (.csv)</button>
          <div className="my-1 border-t border-border" />
          <div className="px-3 pb-1 pt-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Your templates</div>
          {templates.map((t) => (
            <div key={t.id} className="flex items-center">
              <button role="menuitem" className={`${item} flex-1`} onClick={() => filled(t)} title={`Fill ${t.fileName} with this timesheet`}><FileSpreadsheet className="h-4 w-4 text-primary" />{t.name}</button>
              <button className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground" onClick={() => { setOpen(false); setEditing(t); }} aria-label={`Edit the ${t.name} template`}><Pencil className="h-3.5 w-3.5" /></button>
            </div>
          ))}
          <button role="menuitem" className={`${item} text-primary`} onClick={() => { setOpen(false); setEditing("new"); }}><Upload className="h-4 w-4" />Add a template…</button>
        </div>
      )}
      {editing && <TemplateEditor initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

type Grid = { rows: string[][]; merges: XLSX.Range[]; cols: number };
const PREVIEW_ROWS = 80, PREVIEW_COLS = 26;

/** The sheet's visible text, for clicking cells. */
function readGrid(bytes: Uint8Array, sheet: string | null): Grid {
  const wb = XLSX.read(bytes, { type: "array", sheetRows: PREVIEW_ROWS });
  const ws = wb.Sheets[sheet ?? wb.SheetNames[0]!];
  if (!ws?.["!ref"]) return { rows: [], merges: [], cols: 8 };
  const range = XLSX.utils.decode_range(ws["!ref"]);
  const cols = Math.min(PREVIEW_COLS, Math.max(8, range.e.c + 2));
  const rows: string[][] = [];
  for (let r = 0; r < Math.min(PREVIEW_ROWS, Math.max(20, range.e.r + 6)); r++) {
    const row: string[] = [];
    for (let c = 0; c < cols; c++) { const cell = ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined; row.push(cell ? String(cell.w ?? cell.v ?? "") : ""); }
    rows.push(row);
  }
  return { rows, merges: ws["!merges"] ?? [], cols };
}

type Active = { kind: "cell"; key: SheetField } | { kind: "column"; key: RowField } | null;
const emptyTemplate = (): Omit<TimesheetTemplate, "file" | "fileName"> => ({
  id: crypto.randomUUID(), name: "", sheet: null, cells: {}, table: { columns: {}, startRow: null, rows: null, per: "record" },
});

/** Upload an Excel file, then click where each value goes. */
function TemplateEditor({ initial, onClose }: { initial: TimesheetTemplate | null; onClose: () => void }) {
  const [t, setT] = useState<Omit<TimesheetTemplate, "file" | "fileName">>(initial ?? emptyTemplate());
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array } | null>(initial ? { name: initial.fileName, bytes: fromBase64(initial.file) } : null);
  const [sheets, setSheets] = useState<string[]>([]);
  const [active, setActive] = useState<Active>({ kind: "cell", key: "employee_name" });
  useEffect(() => { if (file) try { setSheets(templateSheets(file.bytes)); } catch { setSheets([]); } }, [file]);
  const grid = useMemo(() => (file ? readGrid(file.bytes, t.sheet) : null), [file, t.sheet]);

  const load = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_TEMPLATE_BYTES) { toast.error(`That file is ${(f.size / 1e6).toFixed(1)} MB. Templates can be up to ${MAX_TEMPLATE_BYTES / 1e6} MB; try removing big pictures from it.`); return; }
    const bytes = new Uint8Array(await f.arrayBuffer());
    try { setSheets(templateSheets(bytes)); } catch (e) { toast.error((e as Error).message); return; }
    setFile({ name: f.name, bytes });
    setT((x) => ({ ...x, name: x.name || f.name.replace(/\.xls[xm]$/i, ""), sheet: null }));
  };

  const fields = [...(Object.keys(SHEET_FIELDS) as SheetField[]).map((k) => ({ kind: "cell" as const, key: k })), ...(Object.keys(ROW_FIELDS) as RowField[]).map((k) => ({ kind: "column" as const, key: k }))];
  const nextAfter = (a: NonNullable<Active>): Active => {
    const group = fields.filter((f) => f.kind === a.kind);
    const i = group.findIndex((f) => f.key === a.key);
    return group.slice(i + 1).find((f) => (f.kind === "cell" ? !t.cells[f.key] : !t.table.columns[f.key])) ?? null;
  };
  /** A click on the sheet places the field being set, then moves on to the next unplaced one. */
  const place = (r: number, c: number) => {
    // A merged block's value lives in its top-left cell.
    const m = grid?.merges.find((x) => r >= x.s.r && r <= x.e.r && c >= x.s.c && c <= x.e.c);
    if (m) { r = m.s.r; c = m.s.c; }
    if (!active) return;
    if (active.kind === "cell") setT((x) => ({ ...x, cells: { ...x.cells, [active.key]: `${colLetters(c + 1)}${r + 1}` } }));
    else setT((x) => ({ ...x, table: { ...x.table, columns: { ...x.table.columns, [active.key]: colLetters(c + 1) }, startRow: x.table.startRow ?? r + 1 } }));
    setActive(nextAfter(active));
  };

  // What each cell of the preview is set to show.
  const marks = new Map<string, string>();
  for (const [k, ref] of Object.entries(t.cells) as [SheetField, string][]) { const a = ref && parseAddress(ref); if (a) marks.set(`${a.row}:${a.col}`, SHEET_FIELDS[k]); }
  const tableCols = new Map<number, string>();
  for (const [k, col] of Object.entries(t.table.columns) as [RowField, string][]) if (col) tableCols.set(parseAddress(`${col}1`)?.col ?? 0, ROW_FIELDS[k]);
  const inTable = (row: number) => t.table.startRow !== null && row >= t.table.startRow && row < t.table.startRow + (t.table.rows ?? 1);

  const full: TimesheetTemplate | null = file ? { ...t, fileName: file.name, file: toBase64(file.bytes) } : null;
  const problems = full ? [...templateProblems(full), ...(t.name.trim() ? [] : ["Give the template a name"])] : [];
  const save = () => {
    if (!full || problems.length) return;
    const list = getTemplates();
    try {
      saveTemplates(list.some((x) => x.id === full.id) ? list.map((x) => (x.id === full.id ? { ...full, name: full.name.trim() } : x)) : [...list, { ...full, name: full.name.trim() }]);
    } catch (e) { toast.error((e as Error).message); return; }
    toast.success(`Template "${full.name.trim()}" saved. Use it from Export.`);
    onClose();
  };
  const remove = () => {
    if (!initial || !confirm(`Delete the "${initial.name}" template? Your original file isn't affected.`)) return;
    saveTemplates(getTemplates().filter((x) => x.id !== initial.id));
    onClose();
  };

  const fieldRow = (f: NonNullable<Active>) => {
    const value = f.kind === "cell" ? t.cells[f.key] ?? "" : t.table.columns[f.key] ?? "";
    const on = active?.kind === f.kind && active.key === f.key;
    const set = (v: string) => setT((x) => (f.kind === "cell" ? { ...x, cells: { ...x.cells, [f.key]: v.toUpperCase() } } : { ...x, table: { ...x.table, columns: { ...x.table.columns, [f.key]: v.toUpperCase() } } }));
    return (
      <div key={`${f.kind}:${f.key}`} onClick={() => setActive(f)}
        className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm ${on ? "bg-primary/15 ring-1 ring-primary/50" : "hover:bg-secondary"}`}>
        <span className="flex-1 truncate">{f.kind === "cell" ? SHEET_FIELDS[f.key] : ROW_FIELDS[f.key]}</span>
        <input value={value} onChange={(e) => set(e.target.value)} onFocus={() => setActive(f)} placeholder={on ? "click a cell" : "—"} aria-label={`${f.kind === "cell" ? SHEET_FIELDS[f.key] : ROW_FIELDS[f.key]} ${f.kind === "cell" ? "cell" : "column"}`}
          className={`${inputCls} !w-20 !px-2 !py-1 text-center font-mono text-xs`} />
        <button type="button" onClick={(e) => { e.stopPropagation(); set(""); }} disabled={!value} className="text-muted-foreground hover:text-foreground disabled:invisible" aria-label="Clear"><X className="h-3.5 w-3.5" /></button>
      </div>
    );
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex h-[92vh] max-w-[min(96vw,90rem)] flex-col sm:max-w-[min(96vw,90rem)]">
        <DialogHeader>
          <DialogTitle>{initial ? `Edit template: ${initial.name}` : "Add a timesheet template"}</DialogTitle>
          <DialogDescription>
            Use your own Excel timesheet: its look stays exactly as it is, and the app fills in the values. Pick a value on the left, then click the cell it goes in. For the day-by-day rows, click the first row's cell in each column.
          </DialogDescription>
        </DialogHeader>
        {!file ? (
          <label className="flex flex-1 cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-border text-muted-foreground hover:border-primary/50 hover:text-foreground">
            <Upload className="h-8 w-8" />
            <span className="text-sm">Choose your Excel template (.xlsx or .xlsm)</span>
            <input type="file" accept=".xlsx,.xlsm" className="hidden" onChange={(e) => void load(e.target.files?.[0])} />
          </label>
        ) : (
          <div className="flex min-h-0 flex-1 gap-4">
            <div className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto pr-1">
              <label className="block text-sm"><span className="label-mono">Template name</span>
                <input className={`${inputCls} mt-1`} value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} /></label>
              <div className="flex items-end gap-2 text-sm">
                {sheets.length > 1 && (
                  <label className="flex-1"><span className="label-mono">Sheet</span>
                    <select className={`${inputCls} mt-1`} value={t.sheet ?? sheets[0]} onChange={(e) => setT({ ...t, sheet: e.target.value })}>{sheets.map((s) => <option key={s}>{s}</option>)}</select></label>
                )}
                <label className={`${btnGhost} cursor-pointer !py-2 text-xs`} title={file.name}>Other file…<input type="file" accept=".xlsx,.xlsm" className="hidden" onChange={(e) => void load(e.target.files?.[0])} /></label>
              </div>
              <div>
                <div className="label-mono mb-1">Single values</div>
                {fields.filter((f) => f.kind === "cell").map(fieldRow)}
              </div>
              <div>
                <div className="label-mono mb-1">Day-by-day rows</div>
                <div className="mb-2 grid grid-cols-2 gap-2 text-xs">
                  <label><span className="text-muted-foreground">First row</span>
                    <input type="number" min={1} className={`${inputCls} mt-0.5 !py-1`} value={t.table.startRow ?? ""} onChange={(e) => setT({ ...t, table: { ...t.table, startRow: e.target.value ? Math.max(1, Math.round(+e.target.value)) : null } })} /></label>
                  <label title="How many rows the template has for days. Leave empty if nothing is below them."><span className="text-muted-foreground">Rows it has room for</span>
                    <input type="number" min={1} className={`${inputCls} mt-0.5 !py-1`} placeholder="no limit" value={t.table.rows ?? ""} onChange={(e) => setT({ ...t, table: { ...t.table, rows: e.target.value ? Math.max(1, Math.round(+e.target.value)) : null } })} /></label>
                  <label className="col-span-2"><span className="text-muted-foreground">One row for each</span>
                    <select className={`${inputCls} mt-0.5 !py-1`} value={t.table.per} onChange={(e) => setT({ ...t, table: { ...t.table, per: e.target.value as "record" | "day" } })}>
                      <option value="record">time record</option>
                      <option value="day">day of the period (days off left blank)</option>
                    </select></label>
                </div>
                {fields.filter((f) => f.kind === "column").map(fieldRow)}
              </div>
            </div>
            <div className="min-w-0 flex-1 overflow-auto rounded-xl ring-1 ring-border">
              <table className="border-collapse text-xs">
                <thead className="sticky top-0 z-10">
                  <tr><th className="sticky left-0 z-10 w-10 bg-secondary" />{Array.from({ length: grid?.cols ?? 0 }, (_, c) => (
                    <th key={c} className={`min-w-[5.5rem] border border-border bg-secondary px-1 py-0.5 font-mono font-normal text-muted-foreground ${tableCols.has(c + 1) ? "!bg-primary/20 !text-foreground" : ""}`}>{colLetters(c + 1)}</th>
                  ))}</tr>
                </thead>
                <tbody>
                  {grid?.rows.map((row, r) => (
                    <tr key={r}>
                      <th className={`sticky left-0 border border-border bg-secondary px-1 font-mono font-normal text-muted-foreground ${inTable(r + 1) ? "!bg-primary/20 !text-foreground" : ""}`}>{r + 1}</th>
                      {row.map((v, c) => {
                        const mark = marks.get(`${r + 1}:${c + 1}`) ?? (inTable(r + 1) && r + 1 === t.table.startRow ? tableCols.get(c + 1) : undefined);
                        const rowCell = inTable(r + 1) && tableCols.has(c + 1);
                        return (
                          <td key={c} onClick={() => place(r, c)} title={`${colLetters(c + 1)}${r + 1}${mark ? ` · ${mark}` : ""}${v ? ` · ${v}` : ""}`}
                            className={`max-w-[11rem] cursor-pointer truncate border border-border px-1.5 py-1 ${mark ? "bg-primary/25 font-medium text-foreground" : rowCell ? "bg-primary/10" : "hover:bg-accent"}`}>
                            {mark ? <span className="rounded bg-primary px-1 text-[10px] text-primary-foreground">{mark}</span> : v}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <div className="min-w-0 flex-1 text-xs text-muted-foreground">
            {active && file && <span className="text-foreground">Click the cell for <b>{active.kind === "cell" ? SHEET_FIELDS[active.key] : `${ROW_FIELDS[active.key]} (first row)`}</b>. </span>}
            {problems.length > 0 && <span className="text-destructive">{problems[0]}{problems.length > 1 ? ` (+${problems.length - 1} more)` : ""}</span>}
          </div>
          <div className="flex gap-2">
            {initial && <button type="button" onClick={remove} className={`${btnGhost} hover:!text-destructive`}>Delete template</button>}
            <button type="button" onClick={onClose} className={btnGhost}>Cancel</button>
            <button type="button" onClick={save} disabled={!file || problems.length > 0} className={`${btnPrimary} disabled:opacity-50`}>Save template</button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
