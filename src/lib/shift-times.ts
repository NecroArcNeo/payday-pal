import { shiftFor } from "./pay";

// A shift's usual hours (shifts.default_*), used to fill in new time records.

export type UsualTimes = { clock_in: string; clock_out: string; lunch_minutes: number };
type ShiftLike = { id: string; name: string; multiplier: number | string; default_clock_in: string | null; default_clock_out: string | null; default_lunch_minutes: number | null };

/** The shift's usual start, end and break, or null when it has none. Times as "HH:MM". */
export function usualTimes(shift: ShiftLike | undefined): UsualTimes | null {
  if (!shift?.default_clock_in || !shift.default_clock_out) return null;
  return { clock_in: shift.default_clock_in.slice(0, 5), clock_out: shift.default_clock_out.slice(0, 5), lunch_minutes: shift.default_lunch_minutes ?? 0 };
}

export const describeTimes = (t: UsualTimes) => `${t.clock_in}–${t.clock_out}`;

/**
 * The usual hours a record for this employee would get: those of the shift picked for the record
 * (`recordShiftId`), else of the employee's own shift. Null when that shift has none.
 */
export function usualTimesFor<S extends ShiftLike>(employeeShiftId: string | null | undefined, recordShiftId: string | null | undefined, shifts: S[]) {
  const id = recordShiftId || shiftFor(employeeShiftId, shifts).id;
  const shift = shifts.find((s) => s.id === id);
  return shift ? { shift, times: usualTimes(shift) } : null;
}
