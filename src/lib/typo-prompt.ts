// The questions asked before saving a value that's likely a slip (src/lib/typo-checks.ts). Each focuses "Go back",
// since the likely answer is to fix it; true means save anyway.
import { askChoice } from "@/lib/choice-prompt";
import { money, weekday } from "@/lib/payroll";
import { longRecordHint, longRecords, rateLooksWrong, recordHours, sameNamePeople } from "@/lib/typo-checks";

async function askAnyway(title: string, detail: string, items: string[] | undefined, save: string): Promise<boolean> {
  const answer = await askChoice({
    title, detail, ...(items?.length ? { items } : {}),
    choices: [{ id: "back", label: "Go back" }, { id: "save", label: save }],
    focus: "back",
  });
  return answer?.id === "save";
}

type LongRecord = Parameters<typeof longRecords>[0][number] & { employee_id: string; work_date: string };

/** Asks about records longer than a real day; true when there are none or the user saves anyway. */
export async function confirmLongRecords(rows: LongRecord[], nameOf: (employeeId: string) => string): Promise<boolean> {
  const long = longRecords(rows);
  if (!long.length) return true;
  return askAnyway(
    long.length === 1 ? `${recordHours(long[0]!).toFixed(2)} hours in one record?` : `${long.length} records are over 16 hours`,
    `${longRecordHint(long)} Check the times before saving.`,
    long.slice(0, 20).map((r) => `${nameOf(r.employee_id)} · ${weekday(r.work_date)} ${r.work_date} · ${recordHours(r).toFixed(2)} h${r.entry_mode === "clock" ? ` (${r.clock_in?.slice(0, 5)}–${r.clock_out?.slice(0, 5)})` : ""}`).concat(long.length > 20 ? [`…and ${long.length - 20} more`] : []),
    long.length === 1 ? "Save anyway" : `Save all ${rows.length} anyway`,
  );
}

/** Asks about rate changes that look like a typo; true when none do or the user goes on. */
export async function confirmRates(changes: { name: string; oldRate: number; newRate: number }[]): Promise<boolean> {
  const odd = changes.flatMap((c) => { const why = rateLooksWrong(c.oldRate, c.newRate); return why ? [{ ...c, why }] : []; });
  if (!odd.length) return true;
  const one = odd.length === 1 ? odd[0]! : null;
  return askAnyway(
    one ? `Hourly rate ${money(one.oldRate)} → ${money(one.newRate)}?` : `${odd.length} rates change a lot`,
    one ? `${one.why} Check for a misplaced decimal point or an extra digit.` : "Check for a misplaced decimal point or an extra digit.",
    one && changes.length === 1 ? undefined : odd.slice(0, 20).map((c) => `${c.name}: ${money(c.oldRate)} → ${money(c.newRate)} · ${c.why}`),
    "It's right, go on",
  );
}

/** Asks before adding someone with the same name as an employee already there. */
export async function confirmNewName<E extends { id: string; first_name: string; last_name: string; employee_code: string; active?: boolean | null }>(first: string, last: string, employees: E[]): Promise<boolean> {
  const same = sameNamePeople(first, last, employees);
  if (!same.length) return true;
  return askAnyway(
    `There's already a ${first.trim()} ${last.trim()}`,
    "Adding them again makes a second employee, with their own hours and pay. If it's the same person, go back and use their profile.",
    same.map((e) => `${e.first_name} ${e.last_name} · ID ${e.employee_code}${e.active === false ? " · resigned" : ""}`),
    "Add a second one",
  );
}
