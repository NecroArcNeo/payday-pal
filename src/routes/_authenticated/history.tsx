import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AppShell, btnGhost, inputCls } from "@/components/AppShell";
import { EmployeePicker } from "@/components/EmployeeSearch";
import { DateInput } from "@/components/DateInput";
import { HistoryList } from "@/components/HistoryView";
import { useEmployees } from "@/lib/payroll";
import { openSettings } from "@/lib/settings-window";
import type { HistoryKind } from "@/lib/db/history";

export const Route = createFileRoute("/_authenticated/history")({
  head: () => ({ meta: [{ title: "Edit history — KoPayroll" }] }),
  component: HistoryPage,
});

const KINDS: { value: "" | HistoryKind; label: string }[] = [
  { value: "", label: "Every kind" }, { value: "edit", label: "Changes" }, { value: "undo", label: "Undone" },
  { value: "redo", label: "Redone" }, { value: "restore", label: "Restores and pulls" },
];

/** Every change made on this computer, newest first: who it touched, when, and each field before and after. */
function HistoryPage() {
  const { data: employees = [] } = useEmployees();
  const [employeeId, setEmployeeId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [kind, setKind] = useState<"" | HistoryKind>("");
  const [text, setText] = useState("");
  const filtering = !!(employeeId || from || to || kind || text.trim());
  const filter = { employeeId: employeeId || undefined, from: from || undefined, to: to || undefined, kinds: kind ? [kind] : undefined, text: text.trim() || undefined };

  return (
    <AppShell eyebrow="Your data" title="Edit history" actions={<button onClick={() => openSettings("history")} className={btnGhost}>How long it's kept</button>}>
      <p className="text-sm text-muted-foreground">
        Every change made in the app on this computer, kept after the app closes. Click an entry to see each field before and after. Ctrl+Z undoes this session's changes; to go back further, restore a backup on Sync & backup.
      </p>
      <div className="glass-panel overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
          <div className="w-72"><EmployeePicker employees={employees} value={employeeId} onChange={setEmployeeId} emptyLabel="Everyone" placeholder="Everyone" /></div>
          <span className="flex items-center gap-2 text-sm">
            <DateInput className={`${inputCls} !w-40`} value={from} onChange={setFrom} placeholder="From" aria-label="From" />
            <span className="text-muted-foreground">→</span>
            <DateInput className={`${inputCls} !w-40`} value={to} onChange={setTo} placeholder="To" aria-label="To" />
          </span>
          <select className={`${inputCls} !w-48`} value={kind} onChange={(e) => setKind(e.target.value as "" | HistoryKind)} aria-label="Kind">
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
          <input className={`${inputCls} min-w-[12rem] flex-1`} placeholder="Search names, amounts, notes…" value={text} onChange={(e) => setText(e.target.value)} />
          {filtering && <button type="button" className={btnGhost} onClick={() => { setEmployeeId(""); setFrom(""); setTo(""); setKind(""); setText(""); }}>Clear</button>}
        </div>
        <HistoryList filter={filter} empty={filtering ? "No changes match." : "No changes recorded yet. Every change from now on is listed here."} />
      </div>
    </AppShell>
  );
}
