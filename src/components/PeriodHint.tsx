import { Link } from "@tanstack/react-router";
import { CalendarSearch } from "lucide-react";
import { btnGhost } from "@/components/AppShell";
import { useNearestRecords, weekday } from "@/lib/payroll";
import { howFar, periodHint } from "@/lib/period-hint";

/**
 * Shown when the Payroll period has no hours: says why the page is empty and offers the nearest week that has
 * records, so a mistyped date or a period just past the data doesn't read as a payroll of $0.
 */
export function PeriodHint({ from, to, onPick }: { from: string; to: string; onPick: (from: string, to: string) => void }) {
  const backwards = from > to;
  const { data: nearest } = useNearestRecords(from, to, !backwards);
  if (!backwards && !nearest) return null;
  const hint = periodHint(from, to, nearest ?? { before: null, after: null });
  const day = (d: string) => `${weekday(d)} ${d}`;

  return (
    <div role="status" className="flex gap-3 rounded-xl bg-secondary/60 px-4 py-3 text-sm ring-1 ring-border">
      <CalendarSearch className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      {hint.kind === "backwards" ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span>The period ends ({day(to)}) before it starts ({day(from)}), so nothing is in it.</span>
          <button type="button" onClick={() => onPick(to, from)} className={`${btnGhost} !py-1 !text-xs`}>Swap the dates</button>
        </div>
      ) : hint.kind === "no-records" ? (
        <span>There are no time records yet. Add them on <Link to="/records" className="text-primary hover:underline">Time records</Link> or bring them in with <Link to="/import" className="text-primary hover:underline">Import</Link>.</span>
      ) : (
        <div className="space-y-2">
          <div>No hours from {day(from)} to {day(to)}. Is this the period you meant?</div>
          {hint.options.map((o) => (
            <div key={o.side} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
              <span>
                {o.side === "before"
                  ? `${o.count} record${o.count === 1 ? "" : "s"} before it; the latest is on ${day(o.date)}, ${howFar(o.days)} earlier.`
                  : `${o.count} record${o.count === 1 ? "" : "s"} after it; the first is on ${day(o.date)}, ${howFar(o.days)} later.`}
              </span>
              <button type="button" onClick={() => onPick(o.from, o.to)} className={`${btnGhost} !py-1 !text-xs`}>Show the week of {o.from}</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
