import { strFromU8, strToU8 as encode, unzipSync, zipSync } from "fflate";

const strToU8 = (text: string) => Uint8Array.from(encode(text));
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { colLetters, colNumber, fillTemplate, type CellValue, formatKind, parseAddress, templateSheets, TemplateError } from "./xlsx-template";

/** A small styled workbook, as Excel writes one: shared strings, a date-formatted cell, a time cell, a formula with a calc chain. */
function template() {
  const ns = `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><workbook ${ns}><sheets><sheet name="Cover" sheetId="1" r:id="rId2"/><sheet name="Timesheet" sheetId="2" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/></Relationships>`),
    "xl/styles.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><styleSheet ${ns}><numFmts count="1"><numFmt numFmtId="164" formatCode="h:mm AM/PM"/></numFmts><fonts count="2"><font><sz val="11"/></font><font><b/><sz val="14"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellXfs count="4"><xf numFmtId="0" fontId="0"/><xf numFmtId="0" fontId="1" applyFont="1"/><xf numFmtId="14" fontId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`),
    "xl/sharedStrings.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><sst ${ns} count="2" uniqueCount="2"><si><t>Name:</t></si><si><t>Total</t></si></sst>`),
    "xl/calcChain.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><calcChain ${ns}><c r="D6" i="1"/></calcChain>`),
    "xl/worksheets/sheet2.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><worksheet ${ns}><sheetData/></worksheet>`),
    // A1 "Name:", B1 bold (empty), B2 date-formatted, A4..A5 date cells, C4 time cell, C6 "Total", D6 =SUM(D4:D5).
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><worksheet ${ns}><sheetData><row r="1" spans="1:2"><c r="A1" t="s"><v>0</v></c><c r="B1" s="1"/></row><row r="2"><c r="B2" s="2"/></row><row r="4"><c r="A4" s="2"/><c r="C4" s="3"/></row><row r="6"><c r="C6" t="s"><v>1</v></c><c r="D6"><f>SUM(D4:D5)</f><v>0</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="B1:C1"/></mergeCells></worksheet>`),
  });
}

describe("filling an Excel template", () => {
  it("writes values into the named sheet, keeping each cell's style, the formulas and everything else", () => {
    const out = fillTemplate(template(), "Timesheet", new Map<string, CellValue>([
      ["B1", "Ada Lovelace"], ["B2", { date: "2026-10-19" }], ["A4", { date: "2026-10-20" }], ["C4", { time: "09:30" }],
      ["D4", 7.5], ["D5", 8], ["A5", { date: "2026-10-21" }], ["F9", "new cell & row"],
    ]));
    const files = unzipSync(out);
    const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]!);
    // Styles kept; the merge and the formula stay; untouched sheets and files are byte for byte the same.
    expect(sheet).toContain(`<c r="B1" s="1" t="inlineStr"><is><t xml:space="preserve">Ada Lovelace</t></is></c>`);
    expect(sheet).toContain(`<c r="B2" s="2"><v>46314</v></c>`);
    expect(sheet).toContain(`<c r="C4" s="3"><v>0.3958333333333333</v></c>`);
    expect(sheet).toContain(`<f>SUM(D4:D5)</f>`);
    expect(sheet).toContain(`<mergeCell ref="B1:C1"/>`);
    expect(files["xl/styles.xml"]).toEqual(unzipSync(template())["xl/styles.xml"]);
    expect(files["xl/worksheets/sheet2.xml"]).toEqual(unzipSync(template())["xl/worksheets/sheet2.xml"]);
    // Excel's formula index goes, and the workbook recalculates on open.
    expect(files["xl/calcChain.xml"]).toBeUndefined();
    expect(strFromU8(files["[Content_Types].xml"]!)).not.toContain("calcChain");
    expect(strFromU8(files["xl/workbook.xml"]!)).toContain(`fullCalcOnLoad="1"`);

    const wb = XLSX.read(out, { type: "array", cellDates: false });
    const ws = wb.Sheets["Timesheet"]!;
    expect(ws["A1"].v).toBe("Name:");
    expect(ws["B1"].v).toBe("Ada Lovelace");
    expect(ws["B2"].v).toBe(46314); // 2026-10-19
    // A date in a cell not formatted as one goes in as text, so it doesn't show as 46316.
    expect(ws["A5"].v).toBe("2026-10-21");
    expect(ws["D4"].v).toBe(7.5);
    expect(ws["F9"].v).toBe("new cell & row");
    // Rows and cells stay in order, as Excel requires.
    expect([...sheet.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1]))).toEqual([1, 2, 4, 5, 6, 9]);
    expect([...sheet.matchAll(/<c r="([A-Z]+)4"/g)].map((m) => m[1])).toEqual(["A", "C", "D"]);
  });

  it("lists sheets, refuses what it can't fill, and reads addresses", () => {
    expect(templateSheets(template())).toEqual(["Cover", "Timesheet"]);
    expect(() => fillTemplate(new Uint8Array([1, 2, 3]), null, new Map())).toThrow(TemplateError);
    expect(() => fillTemplate(template(), "Nope", new Map())).toThrow(/no sheet called "Nope"/);
    expect(parseAddress("$B$12")).toEqual({ col: 2, row: 12 });
    expect(parseAddress("12B")).toBeNull();
    expect(colLetters(28)).toBe("AB");
    expect(colNumber("AB")).toBe(28);
    expect(formatKind("mm/dd/yyyy")).toBe("date");
    expect(formatKind("h:mm AM/PM")).toBe("time");
    expect(formatKind('"$"#,##0.00')).toBe("other");
    expect(formatKind("[$-409]mmmm d, yyyy")).toBe("date");
  });
});
