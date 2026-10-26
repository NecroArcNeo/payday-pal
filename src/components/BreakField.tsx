import { useState } from "react";
import { breakToMinutes, formatBreak, useBreakUnit, type BreakUnit } from "@/lib/breaks";

/** Minutes / hours switch for how breaks are shown and typed everywhere. */
export function BreakUnitToggle({ className = "" }: { className?: string }) {
  const [unit, setUnit] = useBreakUnit();
  return (
    <div className={`inline-flex rounded-lg bg-secondary p-0.5 text-[11px] font-medium ring-1 ring-border ${className}`} role="group" aria-label="Show breaks in">
      {(["min", "h"] as const).map((u) => (
        <button type="button" key={u} onClick={() => setUnit(u)} aria-pressed={unit === u}
          className={`rounded-md px-2 py-0.5 ${unit === u ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
          {u === "min" ? "Minutes" : "Hours"}
        </button>
      ))}
    </div>
  );
}

/**
 * A break typed in the chosen unit. `minutes` is the stored value as text;
 * onChange gets whole minutes as text ("NaN" when what's typed isn't a number).
 */
export function BreakInput({ minutes, onChange, className, label = "Break" }: {
  minutes: string; onChange: (minutes: string) => void; className?: string; label?: string;
}) {
  const [unit] = useBreakUnit();
  // What's being typed, kept as typed (so "0." or "1.2" don't get reformatted mid-entry).
  const [draft, setDraft] = useState<{ unit: BreakUnit; text: string } | null>(null);
  const text = draft && draft.unit === unit ? draft.text : minutes === "" || Number.isNaN(Number(minutes)) ? minutes.replace("NaN", "") : formatBreak(minutes, unit);
  return (
    <input type="number" inputMode="decimal" min={0} step={unit === "h" ? "0.25" : "1"} className={className} value={text}
      aria-label={`${label} in ${unit === "h" ? "hours" : "minutes"}`} title={unit === "h" ? "Hours, e.g. 0.5 for 30 minutes" : "Minutes"}
      onChange={(e) => { setDraft({ unit, text: e.target.value }); onChange(String(breakToMinutes(e.target.value, unit))); }}
      onBlur={() => { if (!Number.isNaN(Number(minutes))) setDraft(null); }} />
  );
}
