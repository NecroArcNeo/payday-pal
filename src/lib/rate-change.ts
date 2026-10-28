import { db } from "@/lib/db/mode";
import { askChoice } from "@/lib/choice-prompt";
import { isoDate, money } from "@/lib/payroll";
import { describeFrom, planRateChange, type RatePlan, type StoredRate } from "@/lib/pay-rates";

/**
 * Asks from which day a new rate applies (or whether it fixes a typo in the current one), for one or more employees
 * (`history` null: several). Null when cancelled. Rates can't start after today: the current rate is always the latest one.
 */
export async function askRateDate(summary: string, oldRates: string, history: StoredRate[] | null): Promise<{ from: string } | "correct" | null> {
  const latest = history?.length ? [...history].sort((a, b) => a.effective_from.localeCompare(b.effective_from)).at(-1)! : null;
  const today = isoDate(new Date());
  const answer = await askChoice({
    title: summary,
    detail: `From which day? Days before it keep being paid ${oldRates}, so payroll you've already run doesn't change.`,
    date: { label: "New rate from", value: today, max: today },
    choices: [
      { id: "cancel", label: "Cancel" },
      { id: "correct", label: history === null ? "Fix a typo in their current rates" : latest ? `Fix a typo in the current rate (${describeFrom(latest.effective_from)})` : "Fix a typo (every day)" },
      { id: "from", label: "Use from this day", primary: true, needsDate: true },
    ],
  });
  if (!answer || answer.id === "cancel") return null;
  return answer.id === "correct" ? "correct" : { from: answer.date };
}

/** Writes a plan's history entries for one employee. Set the employee's rate to `plan.current` afterwards. */
export async function writeRateHistory(employeeId: string, plan: RatePlan): Promise<string | null> {
  if (plan.insert.length) {
    const { error } = await db().insert("pay_rates", plan.insert.map((r) => ({ employee_id: employeeId, ...r })));
    if (error) return error.message;
  }
  for (const u of plan.update) {
    const { error } = await db().update("pay_rates", u.id, { hourly_rate: u.hourly_rate });
    if (error) return error.message;
  }
  return null;
}

/** The profile's rate change: asks when it applies, writes the history, and gives the rate to save on the employee (null when cancelled or failed). */
export async function changeEmployeeRate(employeeId: string, history: StoredRate[], oldRate: number, newRate: number): Promise<number | null> {
  const when = await askRateDate(`Hourly rate ${money(oldRate)} → ${money(newRate)}`, money(oldRate), history);
  if (!when) return null;
  const plan = planRateChange(history, oldRate, newRate, when);
  const error = await writeRateHistory(employeeId, plan);
  if (error) throw new Error(error);
  return plan.current;
}
