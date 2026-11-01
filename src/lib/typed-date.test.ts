import { describe, expect, it } from "vitest";
import { readTypedDate, showDate } from "./typed-date";

const TODAY = "2026-10-31";
const us = (t: string, today = TODAY) => readTypedDate(t, today, "mdy");

describe("reading a typed date", () => {
  it("reads 4 digits as month and day, this year, future dates included", () => {
    expect(us("1101")).toBe("2026-11-01");
    expect(us("1225")).toBe("2026-12-25");
    expect(us("0915")).toBe("2026-09-15");
  });

  it("picks the year nearest today when none is typed", () => {
    expect(us("0105", "2026-12-28")).toBe("2027-01-05");
    expect(us("1220", "2027-01-03")).toBe("2026-12-20");
    expect(us("0315")).toBe("2027-03-15"); // 4½ months ahead is nearer than 7½ months back
    expect(us("0601")).toBe("2026-06-01");
  });

  it("reads separators, 2- and 4-digit years, and year-first dates", () => {
    expect(us("11/1")).toBe("2026-11-01");
    expect(us("11-01-26")).toBe("2026-11-01");
    expect(us("11.1.2027")).toBe("2027-11-01");
    expect(us("2026-11-01")).toBe("2026-11-01");
    expect(us("2026/1/5")).toBe("2026-01-05");
    expect(us("3/4/85")).toBe("1985-03-04");
  });

  it("reads 6 and 8 digits", () => {
    expect(us("110126")).toBe("2026-11-01");
    expect(us("11012026")).toBe("2026-11-01");
    expect(us("20261101")).toBe("2026-11-01");
  });

  it("reads a day alone as this month, and 3 digits only when there's one way to read them", () => {
    expect(us("5")).toBe("2026-10-05");
    expect(us("31")).toBe("2026-10-31");
    expect(us("915")).toBe("2026-09-15");
    expect(us("111")).toBeNull();
  });

  it("reads month names and words", () => {
    expect(us("Nov 1")).toBe("2026-11-01");
    expect(us("november 1, 2027")).toBe("2027-11-01");
    expect(us("1st Nov")).toBe("2026-11-01");
    expect(us("Sat 11/1")).toBe("2026-11-01");
    expect(us("today")).toBe(TODAY);
    expect(us("tomorrow")).toBe("2026-11-01");
    expect(us("Yesterday")).toBe("2026-10-30");
  });

  it("reads day first where that's the habit", () => {
    expect(readTypedDate("0111", TODAY, "dmy")).toBe("2026-11-01");
    expect(readTypedDate("25/12/26", TODAY, "dmy")).toBe("2026-12-25");
    expect(showDate("2026-11-01", "dmy")).toBe("01/11/2026");
    expect(showDate("2026-11-01", "mdy")).toBe("11/01/2026");
  });

  it("refuses what isn't a date", () => {
    for (const t of ["1301", "0230", "1132", "abc", "nov", "12345", "11/31", "", "2026-02-30"]) expect(us(t), t).toBeNull();
  });
});
