import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronUp, Maximize2, X } from "lucide-react";
import { btnGhost } from "@/components/AppShell";
import { SidePanel } from "@/components/SidePanel";
import { EmployeeProfile, type ProfileTab } from "@/components/EmployeeProfile";
import { fullName, type Employee } from "@/lib/payroll";

// The Employees page's side panel: the clicked employee's whole profile (the same tabs as the profile page) beside the
// roster, so you can go down the list editing people without leaving it. The page owns which employee is open, as
// RecordsLedger does for records.

export function EmployeePanel({ emp, employees, position, onMove, onClose, onDirty }: {
  emp: Employee; employees: Employee[]; position: string;
  onMove: (step: -1 | 1) => void; onClose: () => void; onDirty: (dirty: boolean) => void;
}) {
  // The tab stays as you move from person to person (comparing pay rates down the list, say).
  const [tab, setTab] = useState<ProfileTab>("details");
  const head = useRef<HTMLHeadingElement>(null);
  // Focus moves into the panel when it opens (not on every move, so ↑/↓ keeps working from the list).
  useEffect(() => { head.current?.focus(); }, []);
  return (
    <SidePanel id="employee" defaultWidth={560} labelledBy="employee-panel-title">
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 id="employee-panel-title" ref={head} tabIndex={-1} className="truncate font-display text-lg font-extrabold tracking-tight outline-none">{fullName(emp)}</h2>
          <div className="font-mono text-xs text-muted-foreground">{emp.employee_code} · {position}</div>
        </div>
        <div className="flex shrink-0 gap-1">
          <Link to="/employees/$id" params={{ id: emp.id }} search={tab === "details" ? {} : { tab }} className={`${btnGhost} !px-2`} aria-label="Open the full profile page" title="Open the full page"><Maximize2 className="h-4 w-4" /></Link>
          <button type="button" onClick={() => onMove(-1)} className={`${btnGhost} !px-2`} aria-label="Previous employee" title="Previous employee (↑)"><ChevronUp className="h-4 w-4" /></button>
          <button type="button" onClick={() => onMove(1)} className={`${btnGhost} !px-2`} aria-label="Next employee" title="Next employee (↓)"><ChevronDown className="h-4 w-4" /></button>
          <button type="button" onClick={onClose} className={`${btnGhost} !px-2`} aria-label="Close panel" title="Close (Esc)"><X className="h-4 w-4" /></button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {/* Keyed by the employee, so moving to someone else starts their form afresh. */}
        <EmployeeProfile key={emp.id} emp={emp} employees={employees} tab={tab} onTab={setTab} onDirty={onDirty} />
      </div>
    </SidePanel>
  );
}
