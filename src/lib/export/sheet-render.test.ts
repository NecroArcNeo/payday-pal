import { strToU8 as encode, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { renderSheet } from "./sheet-render";
import { fillTemplate } from "./xlsx-template";

const u8 = (text: string) => Uint8Array.from(encode(text));
const ns = `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;

/** A sheet with a theme-coloured title merged across A1:C1, a bordered header row, a wide column, and a hidden row and column. */
function workbook(over: { sheet?: string; names?: string } = {}) {
  return zipSync({
    "[Content_Types].xml": u8(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`),
    "_rels/.rels": u8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": u8(`<workbook ${ns}><sheets><sheet name="Week" sheetId="1" r:id="rId1"/></sheets>${over.names ?? ""}</workbook>`),
    "xl/_rels/workbook.xml.rels": u8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    "xl/theme/theme1.xml": u8(`<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="T"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme></a:themeElements></a:theme>`),
    "xl/styles.xml": u8(`<styleSheet ${ns}><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><i/><sz val="16"/><color theme="0"/><name val="Cambria"/></font></fonts>
      <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor theme="4" tint="0.39997558519241921"/></patternFill></fill></fills>
      <borders count="2"><border/><border><left style="thin"><color rgb="FF000000"/></left><bottom style="medium"><color indexed="10"/></bottom></border></borders>
      <cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1"><alignment wrapText="1"/></xf></cellXfs></styleSheet>`),
    "xl/worksheets/sheet1.xml": u8(over.sheet ?? `<worksheet ${ns}><sheetViews><sheetView showGridLines="0" workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="1" width="20" customWidth="1"/><col min="4" max="4" width="9" hidden="1"/></cols>
      <sheetData><row r="1" ht="30" customHeight="1"><c r="A1" s="1" t="inlineStr"><is><t>Timesheet</t></is></c><c r="B1" s="1"/><c r="C1" s="1"/></row><row r="2" hidden="1"><c r="A2" t="inlineStr"><is><t>secret</t></is></c></row>
      <row r="3"><c r="A3" s="2" t="inlineStr"><is><t>Date</t></is></c><c r="B3"><v>7.5</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells></worksheet>`),
  });
}

describe("drawing a template's sheet", () => {
  it("shows its colours, fonts, borders, merges, sizes, and leaves out hidden rows and columns", () => {
    const s = renderSheet(workbook(), "Week", { minRows: 4, minCols: 5 });
    expect(s.gridlines).toBe(false);
    // Column A is 20 characters wide; D is hidden.
    expect(s.cols.map((c) => c.col)).toEqual([1, 2, 3, 5]);
    expect(s.cols[0]!.width).toBe(145);
    // Row 2 is hidden; row 1 is 30 pt tall.
    expect(s.rows.map((r) => r.row)).toEqual([1, 3, 4, 5, 6]);
    expect(s.rows[0]!.height).toBe(40);

    const title = s.rows[0]!.cells[0]!;
    expect(title).toMatchObject({ text: "Timesheet", colSpan: 3, rowSpan: 1 });
    // The merge covers B1 and C1, so the row's next cell is E1.
    expect(s.rows[0]!.cells.map((c) => c.col)).toEqual([1, 5]);
    // Accent 1 lightened by 40%, white bold italic 16 pt Cambria, centred.
    expect(title.look).toMatchObject({ background: "#8FAADC", color: "#FFFFFF", bold: true, italic: true, fontSize: 16, fontFamily: "Cambria", align: "center", valign: "middle" });

    const header = s.rows[1]!.cells[0]!;
    expect(header.look).toMatchObject({ borderLeft: "1px solid #000000", borderBottom: "2px solid #FF0000", wrap: true });
    expect(s.rows[1]!.cells[1]).toMatchObject({ text: "7.5", numeric: true });
  });

  it("for a PDF, works the formulas out again with the filled values, and keeps to the print area", () => {
    // C2 doubles B2 and C3 adds them up; their saved results (999) are from before the template was filled.
    const sheet = `<worksheet ${ns}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Title</t></is></c></row>
      <row r="2"><c r="A2" t="inlineStr"><is><t>Hours</t></is></c><c r="B2"><v>1</v></c><c r="C2"><f>B2*2</f><v>999</v></c></row>
      <row r="3"><c r="C3"><f>SUM(B2:C2)</f><v>999</v></c><c r="E3" t="inlineStr"><is><t>outside</t></is></c></row></sheetData>
      <printOptions gridLines="1"/></worksheet>`;
    const file = fillTemplate(workbook({ sheet, names: `<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">Week!$A$2:$C$3</definedName></definedNames>` }), "Week", new Map([["B2", 7.5]]));
    const text = (s: ReturnType<typeof renderSheet>) => s.rows.map((r) => r.cells.map((c) => c.text));
    // On screen (the editor), the saved results show, as Excel's would until it recalculates.
    expect(text(renderSheet(file, "Week", { minRows: 1, minCols: 1 }))[1]!.slice(0, 3)).toEqual(["Hours", "7.5", "999"]);
    const pdf = renderSheet(file, "Week", { minRows: 1, minCols: 1, recalculate: new Date(), printArea: true });
    expect(text(pdf)).toEqual([["Hours", "7.5", "15"], ["", "", "22.5"]]);
    expect(pdf.printGridlines).toBe(true);
  });

  it("refuses a PDF whose formulas can't be worked out", () => {
    const sheet = `<worksheet ${ns}><sheetData><row r="1"><c r="A1"><f>XLOOKUP(1,B1:B2,C1:C2)</f><v>5</v></c></row></sheetData></worksheet>`;
    expect(() => renderSheet(workbook({ sheet }), "Week", { recalculate: new Date() })).toThrow(/Cell A1 on "Week".*XLOOKUP/);
  });

  it("returns nothing to draw for a sheet that isn't there", () => {
    expect(renderSheet(workbook(), "Nope")).toEqual({ cols: [], rows: [], gridlines: true });
  });
});
