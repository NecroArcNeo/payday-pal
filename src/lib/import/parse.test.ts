// @vitest-environment node
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import type { Employee } from "@/lib/payroll";
import { guessSetup, parseDate, parseHours, parseMinutes, parsePeople, parseRecords, parseTime, readWorkbook, recordKey, rowNumber } from "./parse";

const emp = (id: string, code: string, first: string, last: string, email: string | null = null) =>
  ({ id, employee_code: code, first_name: first, last_name: last, email, hourly_rate: 20, custom_fields: {} }) as unknown as Employee;
const people = [emp("u1", "E100", "Nadia", "Okafor", "nadia@example.com"), emp("u2", "E200", "Sam", "Lee")];

/** Builds a real .xlsx in memory and reads it back the way the import page does. */
function xlsx(sheets: Record<string, (string | number | null)[][]>, formats: Record<string, Record<string, string>> = {}) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    for (const [addr, z] of Object.entries(formats[name] ?? {})) {
      const c = ws[addr] as XLSX.CellObject;
      c.z = z;
      c.w = XLSX.SSF.format(z, c.v as number);
    }
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return readWorkbook(buf, "timesheet.xlsx");
}
const csv = (text: string) => readWorkbook(new TextEncoder().encode(text).buffer as ArrayBuffer, "hours.csv");
const serial = (iso: string) => (Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86_400_000;
const time = (h: number, m: number) => (h * 60 + m) / 1440;

describe("value parsing", () => {
  it("reads times in common timesheet styles", () => {
    const t = (text: string) => parseTime({ text });
    expect([t("9:00"), t("9:00 AM"), t("5:30pm"), t("12am"), t("12:15 PM"), t("1730"), t("17.30"), t("09:00:00")])
      .toEqual(["09:00", "09:00", "17:30", "00:00", "12:15", "17:30", "17:30", "09:00"]);
    expect([t("25:00"), t("13pm"), t("lunch")]).toEqual([null, null, null]);
    expect(parseTime({ text: "8:45 AM", serial: time(8, 45) })).toBe("08:45");
  });

  it("reads dates in the chosen order, and real Excel dates regardless of how they display", () => {
    expect(parseDate({ text: "03/04/2026" }, "mdy")).toBe("2026-03-04");
    expect(parseDate({ text: "03/04/2026" }, "dmy")).toBe("2026-04-03");
    expect(parseDate({ text: "Mon 10/5/26" }, "mdy")).toBe("2026-10-05");
    expect(parseDate({ text: "2026-10-05" }, "dmy")).toBe("2026-10-05");
    expect(parseDate({ text: "Oct 5, 2026" }, "mdy")).toBe("2026-10-05");
    expect(parseDate({ text: "31/02/2026" }, "dmy")).toBeNull();
    expect(parseDate({ text: "5/10/26", serial: serial("2026-10-05") }, "dmy")).toBe("2026-10-05");
  });

  it("reads hours and breaks written as decimals or h:mm", () => {
    expect([parseHours({ text: "7.5" }), parseHours({ text: "7,5" }), parseHours({ text: "7:30" }), parseHours({ text: "7h 30m" }), parseHours({ text: "8 hrs" })])
      .toEqual([7.5, 7.5, 7.5, 7.5, 8]);
    expect(parseHours({ text: "7:30", serial: time(7, 30) })).toBe(7.5);
    expect([parseMinutes({ text: "30" }), parseMinutes({ text: "0:45" }), parseMinutes({ text: "30 min" }), parseMinutes({ text: "" })]).toEqual([30, 45, 30, 0]);
  });
});

describe("timesheet layouts", () => {
  it("finds the header below title rows, uses Excel's own dates and times, and lets the range exclude a totals row", () => {
    const [sheet] = xlsx({
      Week: [
        ["Acme Warehouse — weekly timesheet"],
        ["Week of", serial("2026-10-05")],
        [],
        ["Employee ID", "Date", "Time in", "Time out", "Break", "Total hours"],
        ["E100", serial("2026-10-05"), time(9, 0), time(17, 30), time(0, 30), null],
        ["E100", serial("2026-10-06"), null, null, null, 6.5],
        ["E200", serial("2026-10-06"), time(22, 0), time(6, 0), null, null],
        ["E200", serial("2026-10-07"), null, null, null, null],
        ["Total", null, null, null, null, 22.5],
      ],
    }, { Week: { B2: "d/m/yy", B5: "d/m/yy", B6: "d/m/yy", B7: "d/m/yy", B8: "d/m/yy", C5: "h:mm AM/PM", D5: "h:mm AM/PM", E5: "h:mm", C7: "h:mm", D7: "h:mm" } });
    const setup = guessSetup(sheet!, []);
    expect(setup.role).toBe("records");
    expect(rowNumber(sheet!, setup.headerRow!)).toBe(4);
    expect(setup.columns).toEqual(["code", "date", "cin", "cout", "lunch", "hours"]);

    const all = parseRecords(sheet!, setup, people);
    expect(all.errs).toEqual(['Week row 9: no employee matches "total"']);
    const trimmed = parseRecords(sheet!, { ...setup, lastRow: setup.lastRow - 1 }, people);
    expect(trimmed.errs).toEqual([]);
    expect(trimmed.blankDays).toBe(1);
    expect(trimmed.ok.map(({ _line, _code, ...r }) => r)).toEqual([
      { employee_id: "u1", work_date: "2026-10-05", entry_mode: "clock", clock_in: "09:00", clock_out: "17:30", lunch_minutes: 30 },
      { employee_id: "u1", work_date: "2026-10-06", entry_mode: "hours", hours: 6.5 },
      { employee_id: "u2", work_date: "2026-10-06", entry_mode: "clock", clock_in: "22:00", clock_out: "06:00", lunch_minutes: 0 },
    ]);
  });

  it("imports a sheet with no employee column for the employee picked for it", () => {
    const [sheet] = xlsx({ "Sam Lee": [["Date", "Hours"], ["10/5/2026", 8], ["10/6/2026", "7:45"]] });
    const setup = guessSetup(sheet!, []);
    expect(parseRecords(sheet!, setup, people).errs[0]).toMatch(/pick one for the whole sheet/);
    const r = parseRecords(sheet!, { ...setup, sheetEmployeeId: "u2" }, people);
    expect(r.ok.map((x) => [x.employee_id, x.work_date, x.entry_mode === "hours" && x.hours])).toEqual([["u2", "2026-10-05", 8], ["u2", "2026-10-06", 7.75]]);
  });

  it("handles a day-first CSV matched by employee name, with h:mm breaks", () => {
    const [sheet] = csv("Name,Day,Start,Finish,Lunch\nNadia Okafor,25/10/2026,9am,5:30pm,0:45\n\"Lee, Sam\",26/10/2026,08:00,16:00,30\n");
    const setup = guessSetup(sheet!, []);
    expect(setup.dateOrder).toBe("dmy");
    expect(setup.columns).toEqual(["name", "date", "cin", "cout", "lunch"]);
    const r = parseRecords(sheet!, setup, people);
    expect(r.errs).toEqual([]);
    expect(r.ok.map((x) => [x.employee_id, x.work_date, x.entry_mode === "clock" && x.lunch_minutes])).toEqual([["u1", "2026-10-25", 45], ["u2", "2026-10-26", 30]]);
  });

  it("only imports the rows in the chosen range, using the user's column choices", () => {
    const [sheet] = csv("a,b,c\nx,y,z\nE100,2026-10-01,8\nE100,2026-10-02,8\nE100,2026-10-03,8\n");
    const r = parseRecords(sheet!, { ...guessSetup(sheet!, []), role: "records", headerRow: null, firstRow: 3, lastRow: 3, columns: ["code", "date", "hours"] }, people);
    expect(r.ok.map((x) => x.work_date)).toEqual(["2026-10-02"]);
  });
});

describe("people sheets", () => {
  it("maps columns to fields and categories, and only updates what was mapped", () => {
    const [sheet] = xlsx({ Staff: [["Emp #", "Full name", "Pay", "Shirt", "Badge"], ["E100", "Nadia Okafor", "$31.50", "M", "B-7"], ["", "Ana Ruiz", "22", "S", ""]] });
    const setup = { ...guessSetup(sheet!, []), role: "people" as const, columns: ["code", "name", "rate", "custom:shirt-id", "new:Badge"] };
    const ids: Record<string, string> = { "custom:shirt-id": "shirt-id", "new:Badge": "badge-id" };
    const r = parsePeople(sheet!, setup, people, new Set(people.map((p) => p.employee_code.toLowerCase())), (t) => ids[t]);
    expect(r.errs).toEqual([]);
    expect(r.ok[0]).toEqual({ employee_code: "E100", first_name: "Nadia", last_name: "Okafor", email: "nadia@example.com", hourly_rate: 31.5, custom_fields: { "shirt-id": "M", "badge-id": "B-7" } });
    expect(r.ok[1]).toMatchObject({ employee_code: "E003", first_name: "Ana", last_name: "Ruiz", hourly_rate: 22, custom_fields: { "shirt-id": "S" } });
  });
});

describe("shifts and manual pay columns", () => {
  it("matches shift names, puts new people on the default shift, and rejects unknown shifts", () => {
    const [sheet] = csv("Employee ID,Full name,Shift\nE100,Nadia Okafor,night\nE900,New Person,\nE901,Other Person,Graveyard\n");
    const shifts = [{ id: "day", name: "Day" }, { id: "night", name: "Night" }];
    const r = parsePeople(sheet!, guessSetup(sheet!, []), people, new Set(["e100", "e200"]), () => undefined, shifts);
    expect(r.ok.map((p) => [p.employee_code, p.shift_id])).toEqual([["E100", "night"], ["E900", "day"]]);
    expect(r.errs).toEqual(['Sheet1 row 4: no "Graveyard" shift — add it under Payroll → Customize, or fix the name']);
  });

  it("reads a manual day pay column on timesheets", () => {
    const [sheet] = csv("Employee ID,Date,Hours,Day pay\nE100,2026-10-05,8,$250.00\nE100,2026-10-06,8,\n");
    const setup = guessSetup(sheet!, []);
    expect(setup.columns).toEqual(["code", "date", "hours", "pay"]);
    expect(parseRecords(sheet!, setup, people).ok.map((x) => x.pay_override)).toEqual([250, undefined]);
  });
});

describe("duplicates", () => {
  it("treats the same employee, date and times as the same shift", () => {
    const saved = { employee_id: "u1", work_date: "2026-10-05", entry_mode: "clock", clock_in: "09:00:00", clock_out: "17:30:00", hours: 8 };
    expect(recordKey(saved)).toBe(recordKey({ employee_id: "u1", work_date: "2026-10-05", entry_mode: "clock", clock_in: "09:00", clock_out: "17:30" }));
    expect(recordKey({ ...saved, entry_mode: "hours", hours: 7.5 })).toBe(recordKey({ employee_id: "u1", work_date: "2026-10-05", entry_mode: "hours", hours: "7.50" }));
  });
});

