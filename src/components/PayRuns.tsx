import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileText, Receipt, Trash2, X } from "lucide-react";
import { btnGhost, btnPrimary, inputCls } from "@/components/AppShell";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DateInput } from "@/components/DateInput";
import { DataTable } from "@/components/DataTable";
import { SidePanel } from "@/components/SidePanel";
import { SortTh, TableSort, useTableSort } from "@/components/SortControl";
import { BulkExportDialog } from "@/components/BulkExport";
import { db, undoable } from "@/lib/db/mode";
import { backupBefore } from "@/lib/db/safety";
import { askConfirm, modalOpen } from "@/lib/choice-prompt";
import { lockThrough } from "@/lib/pay-freeze";
import { overlappingRuns, runFor, runTotals, type RunLine } from "@/lib/pay-runs";
import { storedRun } from "@/lib/payslip";
import { isoDate, money, usePayRuns, usePayrollSettings, weekday, type PayRun } from "@/lib/payroll";
import { sortTable, type SortColumns } from "@/lib/table-sort";
import type { Json } from "@/integrations/supabase/types";

// Pay runs on the Payroll page (when Settings → Features has them on): "Record pay run" saves the period as paid
// (src/lib/pay-runs.ts) and locks its days; the list below shows every run, and a run opens in a side panel with
// each person's line and their payslips.

const refreshAll = (qc: ReturnType<typeof useQueryClient>) => {
  for (const key of [["pay-runs"], ["payroll-settings"], ["records"]]) void qc.invalidateQueries({ queryKey: key });
};

/**
 * The button that records the shown period as a pay run, and its dialog. `lines` are the Payroll table's figures for
 * everyone paid in the period; `warnings` the things to check still open (mentioned, never blocking, as PayLock does).
 */
export function RecordPayRun({ from, to, lines, warnings }: { from: string; to: string; lines: RunLine[]; warnings: number }) {
  const { data: runs = [] } = usePayRuns();
  const [open, setOpen] = useState(false);
  const recorded = runFor(runs, from, to);
  if (recorded) {
    return (
      <span className="flex items-center gap-2 rounded-lg bg-primary/10 px-3 py-1.5 text-sm text-primary ring-1 ring-primary/30">
        <Receipt className="h-4 w-4" />Paid on {recorded.paid_on} in a pay run
      </span>
    );
  }
  return (
    <>
      <button type="button" className={btnPrimary} onClick={() => setOpen(true)} disabled={!lines.length} title={lines.length ? "Save this period as paid and lock its days" : "No one is paid in this period"}>
        <Receipt className="mr-1 inline h-4 w-4" />Record pay run…
      </button>
      {open && <RecordDialog from={from} to={to} lines={lines} warnings={warnings} runs={runs} onClose={() => setOpen(false)} />}
    </>
  );
}

function RecordDialog({ from, to, lines, warnings, runs, onClose }: { from: string; to: string; lines: RunLine[]; warnings: number; runs: PayRun[]; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: settings } = usePayrollSettings();
  const [paidOn, setPaidOn] = useState(isoDate(new Date()));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const totals = runTotals(lines);
  const today = isoDate(new Date());
  const clash = overlappingRuns(runs, from, to);
  const locked = settings?.locked_through ?? null;
  const problem = to > today ? "This period hasn't ended yet: a pay run (and its lock) can only cover days up to today."
    : clash.length ? `Days in this period were already paid in the pay run for ${clash[0]!.period_from} – ${clash[0]!.period_to}. Delete that run first, or pick a period that doesn't overlap it.`
    : !paidOn ? "Enter the day it was paid." : null;

  const record = async () => {
    if (problem) return;
    setBusy(true);
    try {
      // All one undo step, and all or nothing: a failure partway (the lock refusing) puts back what was written.
      await undoable(`recorded the pay run for ${from} – ${to}`, async () => {
        const id = crypto.randomUUID();
        const r = await db().insert("pay_runs", { id, period_from: from, period_to: to, paid_on: paidOn, note: note.trim().slice(0, 300) || null });
        if (r.error) throw r.error;
        const l = await db().insert("pay_run_lines", lines.map((x) => ({ ...x, pay_run_id: id, deductions: x.deductions as unknown as Json })));
        if (l.error) throw l.error;
        if (!locked || locked < to) {
          const k = await lockThrough(db(), to);
          if (k.error) throw k.error;
        }
      });
      toast.success(`Pay run recorded: ${totals.people} ${totals.people === 1 ? "person" : "people"}, ${money(totals.net)} net. Days through ${to} are locked as paid.`);
      refreshAll(qc);
      onClose();
    } catch (e) {
      toast.error(`The pay run wasn't recorded: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Record the pay run for {weekday(from)} {from} – {weekday(to)} {to}?</DialogTitle>
          <DialogDescription>
            Saves what each person is paid exactly as the Payroll table shows it now, and locks every day up to {to} as paid{locked && locked >= to ? " (already locked)" : ""}, so the records can't change by accident. Ctrl+Z undoes it.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-4 gap-2 rounded-xl bg-secondary p-3 text-center text-sm ring-1 ring-border">
          {([["People", String(totals.people)], ["Gross", money(totals.gross)], ["Deductions", money(totals.deductions)], ["Net", money(totals.net)]] as const).map(([k, v]) => (
            <div key={k}><dt className="label-mono">{k}</dt><dd className="font-display text-base font-extrabold">{v}</dd></div>
          ))}
        </dl>
        {warnings > 0 && <p className="text-sm text-amber-700 dark:text-amber-300">{warnings} thing{warnings === 1 ? "" : "s"} to check {warnings === 1 ? "is" : "are"} still open for this period.</p>}
        <div className="flex flex-wrap gap-3">
          <label className="text-sm"><span className="label-mono">Paid on</span><DateInput className={`${inputCls} mt-1 !w-40`} value={paidOn} onChange={setPaidOn} /></label>
          <label className="min-w-[12rem] flex-1 text-sm"><span className="label-mono">Note (optional)</span><input className={`${inputCls} mt-1`} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Bank transfer" /></label>
        </div>
        {problem && <p className="text-sm text-destructive">{problem}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>Cancel</button>
          <button type="button" className={btnPrimary} onClick={() => void record()} disabled={!!problem || busy}>{busy ? "Recording…" : "Record pay run"}</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type RunRow = PayRun & { totals: ReturnType<typeof runTotals> };
const RUN_COLUMNS: SortColumns<RunRow> = {
  period: { label: "Period", kind: "date", value: (r) => r.period_from },
  paid_on: { label: "Paid on", kind: "date", value: (r) => r.paid_on },
  people: { label: "People", kind: "number", value: (r) => r.totals.people },
  gross: { label: "Gross", kind: "number", value: (r) => r.totals.gross },
  deductions: { label: "Deductions", kind: "number", value: (r) => r.totals.deductions },
  net: { label: "Net", kind: "number", value: (r) => r.totals.net },
  note: { label: "Note", kind: "text", value: (r) => r.note },
};

/** Every pay run, newest first; clicking one opens it beside the list. `onShow` puts a run's period on the Payroll page. */
export function PayRunsList({ onShow }: { onShow: (from: string, to: string) => void }) {
  const { data: runs, isSuccess } = usePayRuns();
  const [sort, setSort] = useTableSort("meridian-pay-runs-sort", RUN_COLUMNS, { by: "period", desc: true });
  const [openId, setOpenId] = useState<string | null>(null);
  const rows = sortTable((runs ?? []).map((r) => ({ ...r, totals: runTotals(storedRun(r).lines) })), sort, RUN_COLUMNS);
  const opened = rows.find((r) => r.id === openId) ?? null;
  useEffect(() => {
    if (!openId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !modalOpen()) setOpenId(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId]);
  const th = "px-3 py-2.5 font-medium";
  return (
    <div className="glass-panel overflow-hidden">
      <div className="border-b border-border px-5 py-4">
        <div className="font-display font-extrabold tracking-tight">Pay runs</div>
        <p className="text-xs text-muted-foreground">Each period you've recorded as paid, with what each person was paid then. Click one to see its people and export their payslips.</p>
      </div>
      {isSuccess && rows.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">No pay runs yet. Pick a period above and use Record pay run once it's paid.</p>
      ) : (
        <DataTable id="pay-runs" className="w-full text-sm">
          <thead>
            <TableSort sort={sort} columns={RUN_COLUMNS} onSort={setSort}>
              <tr className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                <SortTh k="period" className={`${th} pl-5 text-left`}>Period</SortTh>
                <SortTh k="paid_on" className={`${th} text-left`}>Paid on</SortTh>
                <SortTh k="people" className={`${th} text-right`}>People</SortTh>
                <SortTh k="gross" className={`${th} text-right`}>Gross</SortTh>
                <SortTh k="deductions" className={`${th} text-right`}>Deductions</SortTh>
                <SortTh k="net" className={`${th} text-right`}>Net</SortTh>
                <SortTh k="note" className={`${th} pr-5 text-left`}>Note</SortTh>
              </tr>
            </TableSort>
          </thead>
          <tbody className="font-mono text-[13px]">
            {rows.map((r) => (
              <tr key={r.id} onClick={() => setOpenId(r.id)} className={`cursor-pointer border-t border-border hover:bg-secondary ${r.id === openId ? "bg-secondary" : ""}`}>
                <td className="px-5 py-2">{r.period_from} – {r.period_to}</td>
                <td className="px-3 py-2">{r.paid_on}</td>
                <td className="px-3 py-2 text-right">{r.totals.people}</td>
                <td className="px-3 py-2 text-right">{money(r.totals.gross)}</td>
                <td className="px-3 py-2 text-right">{money(r.totals.deductions)}</td>
                <td className="px-3 py-2 text-right font-semibold">{money(r.totals.net)}</td>
                <td className="px-3 py-2 pr-5 font-body text-muted-foreground">{r.note ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      {opened && <PayRunPanel run={opened} onClose={() => setOpenId(null)} onShow={onShow} />}
    </div>
  );
}

function PayRunPanel({ run, onClose, onShow }: { run: RunRow; onClose: () => void; onShow: (from: string, to: string) => void }) {
  const qc = useQueryClient();
  const [exporting, setExporting] = useState(false);
  const lines = storedRun(run).lines;
  const remove = async () => {
    if (!(await askConfirm({
      title: `Delete the pay run for ${run.period_from} – ${run.period_to}?`,
      detail: `Its saved figures for ${lines.length} ${lines.length === 1 ? "person" : "people"} go. The days stay locked as paid (unlock them on Payroll if they need to change). A backup is saved first, and Ctrl+Z puts it back.`,
      confirm: "Delete pay run", danger: true,
    }))) return;
    try {
      await backupBefore("pay-run-delete");
      const { error } = await db().remove("pay_runs", run.id);
      if (error) throw error;
      refreshAll(qc);
      onClose();
    } catch (e) {
      toast.error(`Nothing was deleted: ${(e as Error).message}`);
    }
  };
  const ids = lines.map((l) => l.employee_id).filter((x): x is string => !!x);
  return (
    <SidePanel id="pay-run" defaultWidth={560} labelledBy="pay-run-title">
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 id="pay-run-title" className="font-display text-lg font-extrabold tracking-tight">Pay run: {run.period_from} – {run.period_to}</h2>
          <div className="text-xs text-muted-foreground">Paid on {run.paid_on}{run.note ? ` · ${run.note}` : ""} · recorded {new Date(run.created_at).toLocaleString()}</div>
        </div>
        <button type="button" onClick={onClose} className={`${btnGhost} !px-2`} aria-label="Close panel" title="Close (Esc)"><X className="h-4 w-4" /></button>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btnPrimary} onClick={() => setExporting(true)} disabled={!ids.length}><FileText className="mr-1 inline h-4 w-4" />Export payslips…</button>
          <button type="button" className={btnGhost} onClick={() => onShow(run.period_from, run.period_to)}>Show this period</button>
          <button type="button" className={`${btnGhost} ml-auto`} onClick={() => void remove()} aria-label="Delete pay run"><Trash2 className="h-4 w-4" /></button>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
              <th className="py-2 text-left font-medium">Employee</th><th className="py-2 text-right font-medium">Hours</th>
              <th className="py-2 text-right font-medium">Gross</th><th className="py-2 text-right font-medium">Deductions</th><th className="py-2 text-right font-medium">Net</th>
            </tr>
          </thead>
          <tbody className="font-mono text-[13px]">
            {lines.map((l, i) => (
              <tr key={i} className="border-t border-border align-top">
                <td className="py-2 font-body">
                  {l.employee_id
                    ? <Link to="/timesheet" search={{ employee: l.employee_id, from: run.period_from, to: run.period_to }} className="underline-offset-2 hover:underline" title="Open their payslip (timesheet) for this period">{l.employee_name}</Link>
                    : <span title="This employee was deleted">{l.employee_name}</span>}
                  <div className="text-[11px] text-muted-foreground">{l.employee_code}</div>
                  {l.deductions.length > 0 && <div className="text-[11px] text-muted-foreground">{l.deductions.map((d) => `${d.name} ${money(d.amount)}`).join(" · ")}</div>}
                </td>
                <td className="py-2 text-right">{l.hours.toFixed(2)}</td>
                <td className="py-2 text-right">{money(l.gross)}</td>
                <td className="py-2 text-right">{l.deductions_total ? `−${money(l.deductions_total)}` : "—"}</td>
                <td className="py-2 text-right font-semibold">{money(l.net)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {exporting && <BulkExportDialog initialFrom={run.period_from} initialTo={run.period_to} initialPeople={ids} onClose={() => setExporting(false)} />}
    </SidePanel>
  );
}
