import { addDays, currentWeek, isoDate } from "@/lib/payroll";

// Ready-made date ranges, worked out from today each time they're used, so a saved choice
// like "Last week" keeps meaning last week.

export const PERIODS = {
  this_week: "This week", last_week: "Last week", last_2_weeks: "Last 2 weeks", this_month: "This month", last_month: "Last month",
} as const;
export type PeriodKey = keyof typeof PERIODS;

export function periodRange(key: PeriodKey, now = new Date()): { from: string; to: string } {
  const week = currentWeek();
  const y = now.getFullYear(), m = now.getMonth();
  switch (key) {
    case "this_week": return week;
    case "last_week": return { from: addDays(week.from, -7), to: addDays(week.to, -7) };
    case "last_2_weeks": return { from: addDays(week.from, -7), to: week.to };
    case "this_month": return { from: isoDate(new Date(y, m, 1)), to: isoDate(new Date(y, m + 1, 0)) };
    case "last_month": return { from: isoDate(new Date(y, m - 1, 1)), to: isoDate(new Date(y, m, 0)) };
  }
}

export const periodPresets = () => (Object.keys(PERIODS) as PeriodKey[]).map((key) => ({ key, label: PERIODS[key], ...periodRange(key) }));
