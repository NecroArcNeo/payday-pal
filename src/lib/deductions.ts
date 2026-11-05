import { roundDecimal } from "@/lib/db/codec";
import { weekStart } from "@/lib/pay";

// What's taken from gross pay (schema 13 `deductions`, when Settings → Features has them on). Each deduction is a fixed
// amount or a percent of gross, and says how it repeats: once per pay period (whatever period is being paid: the
// Payroll page's, a pay run's, a timesheet's), once per Mon–Sun week in that period, or once (in the period holding
// its start date). Optional start and end dates limit when it applies. Pure, so the Payroll page, pay runs and
// payslips all work it out the same way.

export type DeductionRule = {
  id: string; name: string; kind: string; amount: number; repeats: string; starts_on: string | null; ends_on: string | null;
};
export type DeductionLine = { id: string; name: string; amount: number; /** How it was worked out ("10% of 812.50", "× 2 weeks"). */ detail: string };
export type Deducted = { lines: DeductionLine[]; total: number; net: number };

export const DEDUCTION_KINDS = { fixed: "Fixed amount", percent: "Percent of gross" } as const;
export const DEDUCTION_REPEATS = { period: "Every pay period", week: "Every week", once: "Once" } as const;

const cents = (n: number) => roundDecimal(n, 2);
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const money = (n: number) => n.toFixed(2);

/** How many Mon–Sun weeks overlap `from`–`to` (a partial week at either end counts as one). */
export function weeksTouching(from: string, to: string) {
  if (to < from) return 0;
  let n = 0;
  for (let w = weekStart(from); w <= to; w = addDays(w, 7)) n++;
  return n;
}

/** The deductions due from `gross` for the period `from`–`to`, in the order given, and what's left. */
export function deductionsFor(rules: readonly DeductionRule[], gross: number, from: string, to: string): Deducted {
  const lines: DeductionLine[] = [];
  for (const d of rules) {
    const start = d.starts_on && d.starts_on > from ? d.starts_on : from;
    const end = d.ends_on && d.ends_on < to ? d.ends_on : to;
    if (start > end) continue; // not active during this period
    const amount = Number(d.amount);
    if (d.repeats === "once" && !(d.starts_on && d.starts_on >= from && d.starts_on <= to)) continue;
    if (d.kind === "percent") {
      lines.push({ id: d.id, name: d.name, amount: cents((gross * amount) / 100), detail: `${amount}% of ${money(gross)}` });
    } else if (d.repeats === "week") {
      const weeks = weeksTouching(start, end);
      lines.push({ id: d.id, name: d.name, amount: cents(amount * weeks), detail: `${money(amount)} × ${weeks} week${weeks === 1 ? "" : "s"}` });
    } else {
      lines.push({ id: d.id, name: d.name, amount: cents(amount), detail: d.repeats === "once" ? "once" : "this pay period" });
    }
  }
  const total = cents(lines.reduce((s, l) => s + l.amount, 0));
  return { lines, total, net: cents(gross - total) };
}

/** A deduction's names in use, in first-seen order: each becomes a Payroll column and a payslip field. */
export const deductionNames = (all: Iterable<readonly DeductionRule[]>) => [...new Set([...all].flatMap((rs) => rs.map((d) => d.name)))];
