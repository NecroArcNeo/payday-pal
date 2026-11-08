import { describe, expect, it } from "vitest";
import { delimited, isRows, readPasted } from "./paste";
import { guessSetup, parseRecords } from "./parse";

const texts = (text: string, html?: string) => readPasted(text, html)?.grid.map((r) => r.map((c) => c.text));

describe("reading pasted rows", () => {
  it("reads Excel and Google Sheets text: tabs between cells, quoted cells holding tabs or line breaks", () => {
    expect(texts('Employee ID\tDate\tHours\r\nE1\t11/03/2026\t7.5\r\nE2\t"two\nlines"\t8\r\n')).toEqual([
      ["Employee ID", "Date", "Hours"], ["E1", "11/03/2026", "7.5"], ["E2", "two\nlines", "8"],
    ]);
  });

  it("keeps empty cells in their column, and evens out short rows", () => {
    expect(texts("E1\t\t8\nE2\t9:00")).toEqual([["E1", "", "8"], ["E2", "9:00", ""]]);
  });

  it("reads the HTML table first when there is one, as text (no date guessing)", () => {
    const html = "<html><body><!--StartFragment--><table><tr><td>E1</td><td>03/11/2026</td><td>8:00 AM</td></tr></table><!--EndFragment--></body></html>";
    expect(texts("ignored\tif\tthere's a table", html)).toEqual([["E1", "03/11/2026", "8:00 AM"]]);
  });

  it("reads comma, semicolon, pipe and lined-up text, by whichever splits the rows evenly", () => {
    expect(texts('E1,"Nov 3, 2026",8\nE2,"Nov 4, 2026",7')).toEqual([["E1", "Nov 3, 2026", "8"], ["E2", "Nov 4, 2026", "7"]]);
    expect(texts("E1;03.11.2026;8,5\nE2;04.11.2026;7")).toEqual([["E1", "03.11.2026", "8,5"], ["E2", "04.11.2026", "7"]]);
    expect(texts("| ID | Date | Hours |\n|----|------|-------|\n| E1 | 2026-11-03 | 8 |")).toEqual([["ID", "Date", "Hours"], ["E1", "2026-11-03", "8"]]);
    expect(texts("Ann Lee    2026-11-03    8.00\nBo Chen    2026-11-03    6.50")).toEqual([["Ann Lee", "2026-11-03", "8.00"], ["Bo Chen", "2026-11-03", "6.50"]]);
  });

  it("takes plain lines whole when nothing splits them", () => {
    expect(texts("just one line\nand another")).toEqual([["just one line"], ["and another"]]);
  });

  it("refuses an empty paste, and tells a single value from rows", () => {
    expect(readPasted("  \n ")).toBeNull();
    expect(isRows(readPasted("8:00")!)).toBe(false);
    expect(isRows(readPasted("E1\t8")!)).toBe(true);
  });

  it("splits quoted text the way spreadsheets write it", () => {
    expect(delimited('a,"b ""quoted"", c",d', ",")).toEqual([["a", 'b "quoted", c', "d"]]);
  });

  it("goes through the import's own guessing and reading, like a file", () => {
    const sheet = readPasted("Employee ID\tDate\tClock in\tClock out\nE1\t2026-11-03\t9:00\t17:00")!;
    const setup = guessSetup(sheet, []);
    expect(setup.role).toBe("records");
    const { ok } = parseRecords(sheet, setup, [{ id: "p1", employee_code: "E1", first_name: "A", last_name: "B" }]);
    expect(ok).toMatchObject([{ employee_id: "p1", work_date: "2026-11-03", entry_mode: "clock", clock_in: "09:00", clock_out: "17:00" }]);
  });
});
