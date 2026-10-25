import { useState } from "react";
import { fullName, money, useRecordPay, weekday, type RecordWithEmp } from "@/lib/payroll";
import { RecordPayCells, RecordPayHeaders } from "@/components/RecordPay";
import { Trash2 } from "lucide-react";

export function RecordsTable({ records, title = "Time records", onDelete, showName = true }: { records: RecordWithEmp[]; title?: string; onDelete?: (id: string) => void; showName?: boolean }) {
  const [mode, setMode] = useState<"clock" | "hours">("clock");
  const rows = records.filter((r) => r.entry_mode === mode);
  const pay = useRecordPay(records);

  return (
    <div className="glass-panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div className="font-display font-extrabold tracking-tight">{title}</div>
        <div className="flex rounded-xl bg-secondary p-1 text-xs font-medium ring-1 ring-border">
          {(["clock", "hours"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`rounded-lg px-3 py-1.5 ${mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {m === "clock" ? "Clock in / out" : "Daily hours"}
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
              {showName && <th className="px-5 py-3 text-left font-medium">Employee</th>}
              <th className="px-3 py-3 text-left font-medium">Date</th>
              {mode === "clock" && (
                <>
                  <th className="px-3 py-3 text-left font-medium">Clock in</th>
                  <th className="px-3 py-3 text-left font-medium">Clock out</th>
                  <th className="px-3 py-3 text-right font-medium">Lunch min</th>
                </>
              )}
              <th className="px-3 py-3 text-right font-medium">Hours</th>
              <th className="px-3 py-3 text-right font-medium">Rate</th>
              <RecordPayHeaders />
              {onDelete && <th className="w-10" />}
            </tr>
          </thead>
          <tbody className="font-mono text-[13px]">
            {rows.length === 0 && (
              <tr>
                <td colSpan={14} className="px-5 py-10 text-center font-body text-muted-foreground">
                  No {mode === "clock" ? "clock in/out" : "daily hours"} records yet.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const rate = Number(r.employees?.hourly_rate ?? 0);
              return (
                <tr key={r.id} className="border-b border-border last:border-0 hover:bg-secondary">
                  {showName && <td className="px-5 py-3 font-body">{r.employees ? fullName(r.employees) : "—"}</td>}
                  <td className="whitespace-nowrap px-3 py-3"><span className="inline-block w-9 font-body text-muted-foreground">{weekday(r.work_date)}</span>{r.work_date}</td>
                  {mode === "clock" && (
                    <>
                      <td className="px-3 py-3">{r.clock_in?.slice(0, 5)}</td>
                      <td className="px-3 py-3">{r.clock_out?.slice(0, 5)}</td>
                      <td className="px-3 py-3 text-right">{r.lunch_minutes}</td>
                    </>
                  )}
                  <td className="px-3 py-3 text-right">{Number(r.hours).toFixed(2)}</td>
                  <td className="px-3 py-3 text-right">{money(rate)}</td>
                  <RecordPayCells line={pay?.get(r.id)} />
                  {onDelete && (
                    <td className="pr-4">
                      <button onClick={() => onDelete(r.id)} aria-label="Delete record" className="text-muted-foreground hover:text-destructive">
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
    </div>
  );
}
