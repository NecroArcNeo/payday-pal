import { describe, expect, it } from "vitest";
import { describeTimes, usualTimes, usualTimesFor } from "./shift-times";

const day = { id: "d", name: "Day", multiplier: 1, default_clock_in: "07:00:00", default_clock_out: "15:30:00", default_lunch_minutes: 30 };
const night = { id: "n", name: "Night", multiplier: 1.2, default_clock_in: "22:00:00", default_clock_out: "06:00:00", default_lunch_minutes: null };
const swing = { id: "s", name: "Swing", multiplier: 1, default_clock_in: null, default_clock_out: null, default_lunch_minutes: null };
const shifts = [day, night, swing];

describe("shift usual times", () => {
  it("reads a shift's usual hours as HH:MM, with no break when none is set", () => {
    expect(usualTimes(day)).toEqual({ clock_in: "07:00", clock_out: "15:30", lunch_minutes: 30 });
    expect(usualTimes(night)).toEqual({ clock_in: "22:00", clock_out: "06:00", lunch_minutes: 0 });
    expect(usualTimes(swing)).toBeNull();
    expect(describeTimes(usualTimes(day)!)).toBe("07:00–15:30");
  });

  it("uses the shift picked for the record, else the employee's own, else the first shift", () => {
    expect(usualTimesFor("n", null, shifts)?.times?.clock_in).toBe("22:00");
    expect(usualTimesFor("n", "d", shifts)?.times?.clock_in).toBe("07:00");
    expect(usualTimesFor(null, null, shifts)?.shift.name).toBe("Day");
    expect(usualTimesFor("s", null, shifts)?.times).toBeNull();
  });
});
