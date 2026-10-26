import { usePref } from "@/lib/prefs";

// Breaks are stored as whole minutes (time_records.lunch_minutes); the user
// picks whether they're shown and typed in minutes or hours.

export type BreakUnit = "min" | "h";
export const MAX_BREAK_MINUTES = 600;

export function useBreakUnit() {
  return usePref<BreakUnit>("meridian-break-unit", "min");
}

export const breakLabel = (unit: BreakUnit) => (unit === "h" ? "Break (h)" : "Break (min)");

/** For showing or pre-filling: 30 → "30" in minutes, "0.50" in hours. */
export function formatBreak(minutes: number | string | null | undefined, unit: BreakUnit) {
  const m = Number(minutes) || 0;
  return unit === "h" ? (m / 60).toFixed(2) : String(m);
}

/** What was typed, as whole minutes. Empty means no break; NaN when it isn't a number. */
export function breakToMinutes(text: string, unit: BreakUnit) {
  if (text.trim() === "") return 0;
  const n = Number(text.trim().replace(",", "."));
  if (!Number.isFinite(n)) return NaN;
  return Math.round(unit === "h" ? n * 60 : n);
}

export const validBreak = (minutes: number) => Number.isFinite(minutes) && minutes >= 0 && minutes <= MAX_BREAK_MINUTES;
export const breakRangeText = (unit: BreakUnit) => (unit === "h" ? "Break must be 0–10 hours" : "Break must be 0–600 minutes");
