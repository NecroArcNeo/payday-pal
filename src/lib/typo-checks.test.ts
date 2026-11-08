import { describe, expect, it } from "vitest";
import { longRecordHint, longRecords, rateLooksWrong, recordHours, sameNamePeople } from "./typo-checks";

describe("catching likely typos", () => {
  it("asks about a rate many times higher or lower, or nothing at all", () => {
    expect(rateLooksWrong(25, 250)).toBe("That's 10× their current rate.");
    expect(rateLooksWrong(25, 2.5)).toBe("That's 10× less than their current rate.");
    expect(rateLooksWrong(25, 0)).toBe("That pays them nothing.");
    expect(rateLooksWrong(20, 30)).toBeNull(); // a real raise
    expect(rateLooksWrong(20, 99)).toBeNull(); // under 5×
    expect(rateLooksWrong(0, 25)).toBeNull(); // a first rate
    expect(rateLooksWrong(20, 20)).toBeNull();
  });

  it("works out a record's hours the way the database does, overnight included", () => {
    expect(recordHours({ entry_mode: "clock", clock_in: "09:00", clock_out: "17:00", lunch_minutes: 30 })).toBe(7.5);
    expect(recordHours({ entry_mode: "clock", clock_in: "09:00", clock_out: "05:00", lunch_minutes: 0 })).toBe(20);
    expect(recordHours({ entry_mode: "hours", hours: "8" })).toBe(8);
  });

  it("finds records longer than a real day, and says why they might be a slip", () => {
    const am = { entry_mode: "clock", clock_in: "09:00", clock_out: "05:00", lunch_minutes: 30 };
    const fine = { entry_mode: "hours", hours: 10 };
    const long = { entry_mode: "hours", hours: 18 };
    expect(longRecords([am, fine, long])).toEqual([am, long]);
    expect(longRecordHint([am])).toMatch(/AM instead of PM/);
    expect(longRecordHint([long])).toMatch(/more than 16 hours/);
  });

  it("finds people with the same name, ignoring case and spacing", () => {
    const people = [{ id: "1", first_name: "Ann", last_name: "Lee" }, { id: "2", first_name: "Bo", last_name: "Chen" }];
    expect(sameNamePeople(" ann ", "LEE", people).map((e) => e.id)).toEqual(["1"]);
    expect(sameNamePeople("Ann", "Lee", people, "1")).toEqual([]); // themselves
    expect(sameNamePeople("Ann", "Leigh", people)).toEqual([]);
    expect(sameNamePeople("", "", people)).toEqual([]);
  });
});
