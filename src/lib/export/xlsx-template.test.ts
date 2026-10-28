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
    // No formula was overwritten, so Excel's formula index stays; the workbook recalculates on open.
    expect(files["xl/calcChain.xml"]).toBeDefined();
    expect(strFromU8(files["xl/workbook.xml"]!)).toContain(`<calcPr fullCalcOnLoad="1"/></workbook>`);
    // Every other file in the workbook is byte for byte the same.
    const before = unzipSync(template());
    for (const name of Object.keys(before)) if (name !== "xl/worksheets/sheet1.xml" && name !== "xl/workbook.xml") expect(files[name], name).toEqual(before[name]);
    // And in the sheet, only the filled cells changed: the text up to the first one and after the last one is untouched.
    const original = strFromU8(before["xl/worksheets/sheet1.xml"]!);
    expect(sheet.slice(0, original.indexOf(`<c r="B1"`))).toBe(original.slice(0, original.indexOf(`<c r="B1"`)));
    expect(sheet.slice(sheet.indexOf("</sheetData>"))).toBe(original.slice(original.indexOf("</sheetData>")));

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
    expect(templateSheets(template())).toEqual([{ name: "Cover", hidden: false, fillable: true }, { name: "Timesheet", hidden: false, fillable: true }]);
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

  it("drops Excel's formula index only when a formula is overwritten, and won't break a formula other cells copy", () => {
    const files = unzipSync(fillTemplate(template(), "Timesheet", new Map<string, CellValue>([["D6", 99]])));
    expect(files["xl/calcChain.xml"]).toBeUndefined();
    expect(strFromU8(files["[Content_Types].xml"]!)).not.toContain("calcChain");
    expect(strFromU8(files["xl/_rels/workbook.xml.rels"]!)).not.toContain("calcChain");
    const shared = edit(template(), "xl/worksheets/sheet1.xml", (x) => x.replace(`<c r="C4" s="3"/>`, `<c r="C4" s="3"><f t="shared" ref="C4:C5" si="0">A4+1</f><v>0</v></c>`));
    expect(() => fillTemplate(shared, "Timesheet", new Map<string, CellValue>([["C4", 1]]))).toThrow(/C4 holds a formula that other cells copy/);
  });

  it("puts a value aimed inside a merged block into its top-left cell", () => {
    const sheet = strFromU8(unzipSync(fillTemplate(template(), "Timesheet", new Map<string, CellValue>([["C1", "Ada"]])))["xl/worksheets/sheet1.xml"]!);
    expect(sheet).toContain(`<c r="B1" s="1" t="inlineStr"><is><t xml:space="preserve">Ada</t></is></c>`);
    expect(sheet).not.toContain(`r="C1"`);
  });

  it("reads files whose XML uses a prefix or the strict namespace, and lists hidden and chart sheets", () => {
    const strict = edit(template(), "xl/workbook.xml", (x) => x
      .replace(/http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main/, "http://purl.oclc.org/ooxml/spreadsheetml/main")
      .replace(/http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships/, "http://purl.oclc.org/ooxml/officeDocument/relationships")
      .replace(`<sheet name="Cover" sheetId="1" r:id="rId2"/>`, `<sheet name="Cover" sheetId="1" state="hidden" r:id="rId2"/><sheet name="Chart" sheetId="3" r:id="rId9"/>`));
    const withChart = edit(strict, "xl/_rels/workbook.xml.rels", (x) => x.replace("</Relationships>", `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet" Target="chartsheets/sheet1.xml"/></Relationships>`));
    expect(templateSheets(withChart)).toEqual([{ name: "Cover", hidden: true, fillable: true }, { name: "Chart", hidden: false, fillable: false }, { name: "Timesheet", hidden: false, fillable: true }]);
    expect(() => fillTemplate(withChart, "Chart", new Map())).toThrow(/chart sheet/);

    const prefixed = edit(template(), "xl/worksheets/sheet1.xml", (x) => x
      .replace(`xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"`, `xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"`)
      .replace(/<(\/?)(worksheet|sheetData|row|c|v|f|mergeCells|mergeCell)\b/g, "<$1x:$2"));
    const sheet = strFromU8(unzipSync(fillTemplate(prefixed, "Timesheet", new Map<string, CellValue>([["B1", "Ada"], ["D4", 2]])))["xl/worksheets/sheet1.xml"]!);
    expect(sheet).toContain(`<x:c r="B1" s="1" t="inlineStr"><x:is><x:t xml:space="preserve">Ada</x:t></x:is></x:c>`);
    expect(sheet).toContain(`<x:c r="D4"><x:v>2</x:v></x:c>`);
    expect(XLSX.read(fillTemplate(prefixed, "Timesheet", new Map<string, CellValue>([["B1", "Ada"]])), { type: "array" }).Sheets["Timesheet"]!["B1"].v).toBe("Ada");
  });
});

/** The template with one of its files changed. */
function edit(file: Uint8Array, name: string, fn: (text: string) => string) {
  const files = unzipSync(file);
  return zipSync({ ...files, [name]: strToU8(fn(strFromU8(files[name]!))) });
}
