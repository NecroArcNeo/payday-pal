import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { usePayslipData } from "@/lib/payslip";
import { toast } from "sonner";
import { ChevronDown, Download, Eye, FileSpreadsheet, FileText, Pencil, Upload, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { btnGhost, btnPrimary, inputCls } from "@/components/AppShell";
import { downloadBlob } from "@/lib/db/backups";
import {
  colLetters, DEDUCTION_FIELDS, exportFile, fieldLabel, fromBase64, PAY_RUN_FIELDS, ROW_FIELDS, SHEET_FIELDS, templateCells, templateProblems, toBase64,
  WEEKDAY_NAMES, type ExportKind, type RowField, type SheetField, type TemplateCategory, type TimesheetSource, type TimesheetTemplate,
} from "@/lib/export/timesheet-export";
import { deleteTemplate, MAX_TEMPLATE_BYTES, saveTemplate, useTemplates } from "@/lib/export/template-store";
import { fillTemplate, parseAddress, templateSheets, type TemplateSheet } from "@/lib/export/xlsx-template";
import { renderSheet, type RenderedCell, type RenderedSheet } from "@/lib/export/sheet-render";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { askConfirm, keepDialogFocus } from "@/lib/choice-prompt";
import { usePref } from "@/lib/prefs";

/** The Timesheet page's Export menu: a plain Excel, CSV or PDF file, or the period filled into one of the user's templates (as Excel or PDF). */
export function TimesheetExport({ data, fileName, categories }: { data: TimesheetSource; fileName: string; categories: TemplateCategory[] }) {
  const templates = useTemplates();
  const [editing, setEditing] = useState<TimesheetTemplate | "new" | null>(null);

  const save = async (kind: ExportKind) => {
    try {
      const f = await exportFile(kind, data, fileName);
      downloadBlob(new Blob([f.bytes as Uint8Array<ArrayBuffer>], { type: f.type }), f.name);
      if (kind.template) toast.success(`Saved with the "${kind.template.name}" template${kind.format === "pdf" ? " as a PDF" : ""}`);
    } catch (e) { toast.error((e as Error).message, { duration: 15000 }); }
  };

  // The kit's dropdown menu: arrow keys move through the items (each template's PDF and edit buttons too), Escape or
  // a click elsewhere closes it, and it opens upward or leftward when there's no room below. An item closes the menu
  // when picked, so the editor opens after it (outside the menu, so it stays open).
  const item = "gap-2 rounded-lg px-3 py-2";
  return (
    <div className="print:hidden">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger className={btnGhost}>
          <Download className="mr-1 inline h-4 w-4" />Export<ChevronDown className="ml-1 inline h-3.5 w-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72 rounded-xl p-1.5" onCloseAutoFocus={keepDialogFocus}>
          <DropdownMenuItem className={item} onSelect={() => void save({ format: "xlsx" })}><FileSpreadsheet className="h-4 w-4 text-muted-foreground" />Excel file (.xlsx)</DropdownMenuItem>
          <DropdownMenuItem className={item} onSelect={() => void save({ format: "csv" })}><FileSpreadsheet className="h-4 w-4 text-muted-foreground" />CSV file (.csv)</DropdownMenuItem>
          <DropdownMenuItem className={item} onSelect={() => void save({ format: "pdf" })}><FileText className="h-4 w-4 text-muted-foreground" />PDF file (.pdf)</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="px-3 pb-1 pt-1.5 font-mono text-[10px] font-normal uppercase tracking-[0.15em] text-muted-foreground">Your templates</DropdownMenuLabel>
          {templates.map((t) => (
            <div key={t.id} className="flex items-center">
              <DropdownMenuItem className={`${item} flex-1`} onSelect={() => void save({ format: "xlsx", template: t })} title={`Fill ${t.fileName} with this timesheet`}><FileSpreadsheet className="h-4 w-4 text-primary" />{t.name}</DropdownMenuItem>
              <DropdownMenuItem className="rounded-lg px-2 py-1.5 text-xs font-medium text-muted-foreground" onSelect={() => void save({ format: "pdf", template: t })}
                title={`Fill ${t.fileName} with this timesheet and save it as a PDF`} aria-label={`${t.name} as a PDF`}>PDF</DropdownMenuItem>
              <DropdownMenuItem className="rounded-lg p-2 text-muted-foreground" onSelect={() => setEditing(t)} aria-label={`Edit the ${t.name} template`}><Pencil className="h-3.5 w-3.5" /></DropdownMenuItem>
            </div>
          ))}
          <DropdownMenuItem className={`${item} text-primary focus:text-primary`} onSelect={() => setEditing("new")}><Upload className="h-4 w-4" />Add a template…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {editing && <TemplateEditor initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} data={data} categories={categories} />}
    </div>
  );
}

/** A cell's look on screen: the template's own fill, font, borders and alignment, drawn on white paper as Excel shows it. */
function cellStyle(c: RenderedCell, height: number, gridlines: boolean): CSSProperties {
  const l = c.look;
  const grid = gridlines ? "1px solid #d4d4d4" : "1px solid transparent";
  return {
    height, background: l.background ?? "#ffffff", color: l.color ?? "#000000",
    fontWeight: l.bold ? 700 : 400, fontStyle: l.italic ? "italic" : "normal",
    textDecoration: [l.underline ? "underline" : "", l.strike ? "line-through" : ""].filter(Boolean).join(" ") || "none",
    fontSize: `${((l.fontSize ?? 11) * 4) / 3}px`, fontFamily: `${l.fontFamily ? `"${l.fontFamily}", ` : ""}Calibri, Carlito, Arial, sans-serif`,
    textAlign: l.align ?? (c.numeric ? "right" : "left"), verticalAlign: l.valign ?? "bottom",
    whiteSpace: l.wrap ? "normal" : "nowrap", overflow: "hidden", lineHeight: 1.15, padding: "0 3px", position: "relative",
    borderTop: l.borderTop ?? grid, borderRight: l.borderRight ?? grid, borderBottom: l.borderBottom ?? grid, borderLeft: l.borderLeft ?? grid,
  };
}

/** The template's sheet as Excel draws it, with the values placed so far marked on top. */
function SheetView({ sheet, marks, tableCols, inTable, startRow, preview, onCell }: {
  sheet: RenderedSheet; marks: Map<string, string>; tableCols: Map<number, string>; inTable: (row: number) => boolean; startRow: number | null;
  preview: boolean; onCell: (row: number, col: number) => void;
}) {
  const header = "sticky bg-[#f3f3f3] text-[#555] font-normal font-mono text-[11px] border border-[#d4d4d4]";
  return (
    <table style={{ tableLayout: "fixed", borderCollapse: "collapse", width: 40 + sheet.cols.reduce((n, c) => n + c.width, 0) }}>
      <colgroup><col style={{ width: 40 }} />{sheet.cols.map((c) => <col key={c.col} style={{ width: c.width }} />)}</colgroup>
      <thead>
        <tr>
          <th className={`${header} left-0 top-0 z-30`} />
          {sheet.cols.map((c) => <th key={c.col} className={`${header} top-0 z-20 py-0.5 ${tableCols.has(c.col) ? "!bg-[#dbe7fb] !text-[#1a4fa0]" : ""}`}>{colLetters(c.col)}</th>)}
        </tr>
      </thead>
      <tbody>
        {sheet.rows.map((r) => (
          <tr key={r.row}>
            <th className={`${header} left-0 z-10 px-1 ${inTable(r.row) ? "!bg-[#dbe7fb] !text-[#1a4fa0]" : ""}`}>{r.row}</th>
            {r.cells.map((c) => {
              const mark = marks.get(`${c.row}:${c.col}`) ?? (c.row === startRow ? tableCols.get(c.col) : undefined);
              const rowCell = inTable(c.row) && tableCols.has(c.col);
              const style = cellStyle(c, r.height, sheet.gridlines);
              // Marks go on top of the template's own look, never instead of it.
              if (preview) { if (mark || rowCell) style.boxShadow = "inset 0 0 0 2px rgba(16,185,129,0.9)"; }
              else if (mark) style.boxShadow = "inset 0 0 0 2px rgba(37,99,235,0.95)";
              else if (rowCell) style.boxShadow = "inset 0 0 0 9999px rgba(37,99,235,0.12)";
              return (
                <td key={c.col} rowSpan={c.rowSpan} colSpan={c.colSpan} style={style} onClick={() => onCell(c.row, c.col)}
                  title={`${colLetters(c.col)}${c.row}${mark ? ` · ${mark}` : ""}${c.text ? ` · ${c.text}` : ""}`}
                  className={preview ? "" : "cursor-pointer hover:outline hover:outline-2 hover:-outline-offset-2 hover:outline-blue-500"}>
                  {c.text}
                  {mark && !preview && (
                    <span className="pointer-events-none absolute left-0.5 top-0.5 z-[1] max-w-[95%] truncate rounded bg-blue-600 px-1 font-sans text-[10px] font-medium leading-4 text-white shadow">{mark}</span>
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
type Active = { kind: "cell"; key: SheetField } | { kind: "column"; key: RowField } | null;
const emptyTemplate = (): Omit<TimesheetTemplate, "file" | "fileName"> => ({
  id: crypto.randomUUID(), name: "", sheet: null, cells: {}, table: { columns: {}, startRow: null, rows: null, per: "record", weeks: null },
});

/** Upload an Excel file, pick its sheet, then click where each value goes; a preview shows the result with real values. */
function TemplateEditor({ initial, onClose, data, categories }: {
  initial: TimesheetTemplate | null; onClose: () => void; data: TimesheetSource; categories: TemplateCategory[];
}) {
  const payslip = usePayslipData();
  const [t, setT] = useState<Omit<TimesheetTemplate, "file" | "fileName">>(initial ?? emptyTemplate());
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array } | null>(initial ? { name: initial.fileName, bytes: fromBase64(initial.file) } : null);
  const sheets = useMemo<TemplateSheet[]>(() => { try { return file ? templateSheets(file.bytes) : []; } catch { return []; } }, [file]);
  const [active, setActive] = useState<Active>({ kind: "cell", key: "employee_name" });
  const [preview, setPreview] = useState(false);
  // How the editor's width is split between the fields list and the sheet: drag the line between them (double-click
  // resets). Panel id → percent, a per-device pref.
  const [split, setSplit] = usePref<Record<string, number> | undefined>("meridian-template-editor-split", undefined);
  // The sheet being filled: the chosen one, else the first visible worksheet.
  const sheetName = t.sheet ?? (sheets.find((s) => s.fillable && !s.hidden) ?? sheets.find((s) => s.fillable))?.name ?? null;

  const load = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_TEMPLATE_BYTES) { toast.error(`That file is ${(f.size / 1e6).toFixed(1)} MB. Templates can be up to ${MAX_TEMPLATE_BYTES / 1e6} MB; try removing big pictures from it.`); return; }
    const bytes = new Uint8Array(await f.arrayBuffer());
    let list: TemplateSheet[];
    try { list = templateSheets(bytes); } catch (e) { toast.error((e as Error).message); return; }
    if (!list.some((s) => s.fillable)) { toast.error("That workbook has no worksheets to fill (only charts)."); return; }
    setFile({ name: f.name, bytes });
    setT((x) => ({ ...x, name: x.name || f.name.replace(/\.xls[xm]$/i, ""), sheet: null }));
  };

  const full: TimesheetTemplate | null = file && sheetName ? { ...t, sheet: sheetName, fileName: file.name, file: toBase64(file.bytes) } : null;
  const problems = full ? [...templateProblems(full, categories), ...(t.name.trim() ? [] : ["Give the template a name"])] : [];
  const placed = Object.values(t.cells).filter(Boolean).length + Object.values(t.table.columns).filter(Boolean).length;

  // The sheet as Excel shows it, or filled with this timesheet's values exactly as the export will be.
  const shown = useMemo(() => {
    if (!file || !sheetName) return { sheet: null, note: "" };
    const draw = (bytes: Uint8Array) => renderSheet(bytes, sheetName);
    if (preview && placed) {
      try {
        const tpl: TimesheetTemplate = { ...t, sheet: sheetName, fileName: file.name, file: "" };
        return { sheet: draw(fillTemplate(file.bytes, sheetName, templateCells(tpl, data(tpl.table.per, tpl.table.weeks ?? null, tpl.table.weekStart ?? 1)))), note: "" };
      } catch (e) {
        return { sheet: draw(file.bytes), note: (e as Error).message };
      }
    }
    return { sheet: draw(file.bytes), note: preview ? "Nothing is placed yet: pick a value on the left and click its cell, then the preview shows it filled in." : "" };
  }, [file, sheetName, preview, placed, t, data]);

  // The payslip values only while their feature is on (Settings → Features), with one field per deduction in use.
  const hidden = new Set<string>([...(payslip.deductionsOn ? [] : DEDUCTION_FIELDS), ...(payslip.payRunsOn ? [] : PAY_RUN_FIELDS)]);
  const fields = [
    ...(Object.keys(SHEET_FIELDS) as SheetField[]).filter((k) => !hidden.has(k)).map((k) => ({ kind: "cell" as const, key: k })),
    ...payslip.deductionNames.map((n) => ({ kind: "cell" as const, key: `deduction:${n}` as SheetField })),
    ...categories.map((c) => ({ kind: "cell" as const, key: `custom:${c.id}` as SheetField })),
    ...(Object.keys(ROW_FIELDS) as RowField[]).map((k) => ({ kind: "column" as const, key: k })),
  ];
  const labelOf = (f: NonNullable<Active>) => (f.kind === "cell" ? fieldLabel(f.key, categories) : ROW_FIELDS[f.key]);
  const nextAfter = (a: NonNullable<Active>): Active => {
    const group = fields.filter((f) => f.kind === a.kind);
    const i = group.findIndex((f) => f.key === a.key);
    return group.slice(i + 1).find((f) => (f.kind === "cell" ? !t.cells[f.key] : !t.table.columns[f.key])) ?? null;
  };
  /** A click on the sheet places the field being set, then moves on to the next unplaced one. */
  const place = (r: number, c: number) => {
    if (!active || preview) return;
    if (active.kind === "cell") setT((x) => ({ ...x, cells: { ...x.cells, [active.key]: `${colLetters(c + 1)}${r + 1}` } }));
    else setT((x) => ({ ...x, table: { ...x.table, columns: { ...x.table.columns, [active.key]: colLetters(c + 1) }, startRow: x.table.startRow ?? r + 1 } }));
    setActive(nextAfter(active));
  };

  // What each cell of the grid is set to show.
  const marks = new Map<string, string>();
  for (const [k, ref] of Object.entries(t.cells) as [SheetField, string][]) { const a = ref && parseAddress(ref); if (a) marks.set(`${a.row}:${a.col}`, fieldLabel(k, categories)); }
  const tableCols = new Map<number, string>();
  for (const [k, col] of Object.entries(t.table.columns) as [RowField, string][]) if (col) tableCols.set(parseAddress(`${col}1`)?.col ?? 0, ROW_FIELDS[k]);
  const inTable = (row: number) => t.table.startRow !== null && row >= t.table.startRow && row < t.table.startRow + (t.table.rows ?? 1);

  const save = async () => {
    if (!full || problems.length) return;
    const named = { ...full, name: full.name.trim() };
    try { await saveTemplate(named); } catch (e) { toast.error((e as Error).message); return; }
    toast.success(`Template "${named.name}" saved. Use it from Export.`);
    onClose();
  };
  const remove = async () => {
    if (!initial || !(await askConfirm({ title: `Delete the "${initial.name}" template?`, detail: "Your original file isn't affected.", confirm: "Delete template", danger: true }))) return;
    try { await deleteTemplate(initial.id); } catch (e) { toast.error((e as Error).message); return; }
    onClose();
  };

  const fieldRow = (f: NonNullable<Active>) => {
    const value = f.kind === "cell" ? t.cells[f.key] ?? "" : t.table.columns[f.key] ?? "";
    const on = active?.kind === f.kind && active.key === f.key;
    const set = (v: string) => setT((x) => (f.kind === "cell" ? { ...x, cells: { ...x.cells, [f.key]: v.toUpperCase() } } : { ...x, table: { ...x.table, columns: { ...x.table.columns, [f.key]: v.toUpperCase() } } }));
    return (
      <div key={`${f.kind}:${f.key}`} onClick={() => { setActive(f); setPreview(false); }}
        className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm ${on ? "bg-primary/15 ring-1 ring-primary/50" : "hover:bg-secondary"}`}>
        <span className="flex-1 truncate" title={labelOf(f)}>{labelOf(f)}</span>
        {/* Typing an address keeps the preview on, so it shows the change; picking the row (to click a cell) turns it off. */}
        <input value={value} onChange={(e) => set(e.target.value)} onFocus={() => setActive(f)} onClick={(e) => e.stopPropagation()} placeholder={on ? "click a cell" : "—"} aria-label={`${labelOf(f)} ${f.kind === "cell" ? "cell" : "column"}`}
          className={`${inputCls} !w-20 !px-2 !py-1 text-center font-mono text-xs`} />
        <button type="button" onClick={(e) => { e.stopPropagation(); set(""); }} disabled={!value} className="text-muted-foreground hover:text-foreground disabled:invisible" aria-label="Clear"><X className="h-3.5 w-3.5" /></button>
      </div>
    );
  };
  const step = (n: number, text: string) => (
    <div className="label-mono mb-1 mt-2"><span className="mr-1.5 inline-grid h-4 w-4 place-items-center rounded-full bg-primary text-[10px] text-primary-foreground">{n}</span>{text}</div>
  );

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex h-[92vh] max-w-[min(96vw,90rem)] flex-col sm:max-w-[min(96vw,90rem)]">
        <DialogHeader>
          <DialogTitle>{initial ? `Edit template: ${initial.name}` : "Add a timesheet template"}</DialogTitle>
          <DialogDescription>
            Use your own Excel timesheet. Each export is a copy of your file with the values filled in: every sheet, the layout, colours, fonts, borders, merged cells, pictures, formulas and print settings stay exactly as they are.
          </DialogDescription>
        </DialogHeader>
        {!file ? (
          <label className="flex flex-1 cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-border text-muted-foreground hover:border-primary/50 hover:text-foreground">
            <Upload className="h-8 w-8" />
            <span className="text-sm">Choose your Excel template (.xlsx or .xlsm)</span>
            <input type="file" accept=".xlsx,.xlsm" className="hidden" onChange={(e) => void load(e.target.files?.[0])} />
          </label>
        ) : (
          <ResizablePanelGroup id="template-editor" orientation="horizontal" className="min-h-0 flex-1" defaultLayout={split}
            onLayoutChanged={(l, m) => { if (m.isUserInteraction) setSplit(m.requestedLayout ?? l); }}>
            <ResizablePanel id="fields" defaultSize={320} minSize={240} maxSize="60">
            <div className="flex h-full flex-col gap-1 overflow-y-auto pr-3">
              <label className="block text-sm"><span className="label-mono">Template name</span>
                <input className={`${inputCls} mt-1`} value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} /></label>
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="truncate" title={file.name}>{file.name}</span>
                <label className={`${btnGhost} shrink-0 cursor-pointer !py-1.5 text-xs`}>Other file…<input type="file" accept=".xlsx,.xlsm" className="hidden" onChange={(e) => void load(e.target.files?.[0])} /></label>
              </div>
              {step(1, "Pick the sheet: tabs above the grid")}
              {step(2, "Single values: pick one, click its cell")}
              {fields.filter((f) => f.kind === "cell").map(fieldRow)}
              {step(3, "Day-by-day rows: first row's cell")}
              <div className="mb-1 grid grid-cols-2 gap-2 text-xs">
                <label><span className="text-muted-foreground">First row</span>
                  <input type="number" min={1} className={`${inputCls} mt-0.5 !py-1`} value={t.table.startRow ?? ""} onChange={(e) => setT({ ...t, table: { ...t.table, startRow: e.target.value ? Math.max(1, Math.round(+e.target.value)) : null } })} /></label>
                <label title="How many rows the template has for days. Rows a period doesn't use are emptied; a period needing more is refused."><span className="text-muted-foreground">Rows it has room for</span>
                  <input type="number" min={1} className={`${inputCls} mt-0.5 !py-1`} placeholder="no limit" value={t.table.rows ?? ""} onChange={(e) => setT({ ...t, table: { ...t.table, rows: e.target.value ? Math.max(1, Math.round(+e.target.value)) : null } })} /></label>
                <label className="col-span-2"><span className="text-muted-foreground">One row for each</span>
                  <select className={`${inputCls} mt-0.5 !py-1`} value={t.table.per} onChange={(e) => setT({ ...t, table: { ...t.table, per: e.target.value as "record" | "day" } })}>
                    <option value="record">time record</option>
                    <option value="day">day of the period (days off left blank)</option>
                  </select></label>
                <label title="Fill this many whole weeks. Every day gets its date and weekday, with clock times and pay left blank on days without records, so each export is the same length.">
                  <span className="text-muted-foreground">Weeks shown</span>
                  <input type="number" min={1} max={53} className={`${inputCls} mt-0.5 !py-1`} placeholder="just the period" value={t.table.weeks ?? ""}
                    onChange={(e) => setT({ ...t, table: { ...t.table, weeks: e.target.value ? Math.min(53, Math.max(1, Math.round(+e.target.value))) : null } })} /></label>
                <label title="The day the weeks start on. A weekday counts back from the period's start to the last such day; or start on the period's own first day.">
                  <span className="text-muted-foreground">Weeks start on</span>
                  <select className={`${inputCls} mt-0.5 !py-1`} disabled={!t.table.weeks} value={String(t.table.weekStart ?? 1)}
                    onChange={(e) => setT({ ...t, table: { ...t.table, weekStart: e.target.value === "period" ? "period" : Number(e.target.value) } })}>
                    {[1, 2, 3, 4, 5, 6, 0].map((d) => <option key={d} value={d}>{WEEKDAY_NAMES[d]}</option>)}
                    <option value="period">the period's first day</option>
                  </select></label>
              </div>
              {fields.filter((f) => f.kind === "column").map(fieldRow)}
              {step(4, "Tick the preview to check, then save")}
            </div>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel id="sheet" minSize="30">
            <div className="flex h-full min-w-0 flex-col gap-2 pl-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-1" role="tablist" aria-label="Sheets">
                  {sheets.map((s) => (
                    <button key={s.name} type="button" role="tab" aria-selected={s.name === sheetName} disabled={!s.fillable}
                      onClick={() => setT({ ...t, sheet: s.name })} title={s.fillable ? (s.hidden ? "A hidden sheet" : `Fill "${s.name}"`) : "A chart sheet: it can't hold values"}
                      className={`rounded-t-lg border-b-2 px-3 py-1.5 text-xs ${s.name === sheetName ? "border-primary bg-primary/15 font-semibold text-foreground" : "border-transparent bg-secondary text-muted-foreground hover:text-foreground"} disabled:opacity-40`}>
                      {s.name}{s.hidden ? " (hidden)" : ""}{!s.fillable ? " (chart)" : ""}
                    </button>
                  ))}
                </div>
                <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-xs ring-1 ring-border hover:bg-secondary" title="Fills the template with the timesheet open now, exactly as the export will">
                  <input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} />
                  <Eye className="h-3.5 w-3.5" />Preview with this timesheet
                </label>
              </div>
              {shown.note && <div className="rounded-lg bg-secondary px-3 py-1.5 text-xs text-foreground ring-1 ring-border">{shown.note}</div>}
              <div className="min-h-0 flex-1 overflow-auto rounded-xl bg-white ring-1 ring-border">
                {shown.sheet && <SheetView sheet={shown.sheet} marks={marks} tableCols={tableCols} inTable={inTable} startRow={t.table.startRow} preview={preview} onCell={(r, c) => place(r - 1, c - 1)} />}
              </div>
            </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <div className="min-w-0 flex-1 text-xs text-muted-foreground">
            {preview ? <span>Previewing the export with the timesheet open now; filled cells are green. Your template's own formulas (totals) show their old values here; Excel recalculates them when the file opens, and a PDF export works them out itself. Untick the preview to keep placing values. </span>
              : active && file ? <span className="text-foreground">Click the cell for <b>{active.kind === "cell" ? labelOf(active) : `${ROW_FIELDS[active.key]} (first row)`}</b>{sheetName ? ` on "${sheetName}"` : ""}. </span> : null}
            {problems.length > 0 && <span className="text-destructive">{problems[0]}{problems.length > 1 ? ` (+${problems.length - 1} more)` : ""}</span>}
          </div>
          <div className="flex gap-2">
            {initial && <button type="button" onClick={() => void remove()} className={`${btnGhost} hover:!text-destructive`}>Delete template</button>}
            <button type="button" onClick={onClose} className={btnGhost}>Cancel</button>
            <button type="button" onClick={() => void save()} disabled={!full || problems.length > 0} className={`${btnPrimary} disabled:opacity-50`}>Save template</button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
