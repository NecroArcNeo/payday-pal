import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { recalculate } from "./formula";

/** A workbook from rows of values; strings starting with "=" are formulas, with an old cached result of 999. */
function book(rows: unknown[][], other?: Record<string, unknown[][]>) {
  const sheet = (rs: unknown[][]) => {
    const ws: XLSX.WorkSheet = {};
    rs.forEach((r, ri) => r.forEach((v, ci) => {
      if (v === undefined) return;
      const addr = XLSX.utils.encode_cell({ r: ri, c: ci });
      ws[addr] = typeof v === "string" && v.startsWith("=") ? { t: "n", v: 999, f: v.slice(1) }
        : typeof v === "number" ? { t: "n", v } : typeof v === "boolean" ? { t: "b", v } : v === null ? { t: "z" } : { t: "s", v };
    }));
    ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rs.length - 1, c: Math.max(...rs.map((r) => r.length)) - 1 } });
    return ws;
  };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet(rows), "Sheet1");
  for (const [name, rs] of Object.entries(other ?? {})) XLSX.utils.book_append_sheet(wb, sheet(rs), name);
  return wb;
}
const value = (f: string, rows: unknown[][] = [[]], other?: Record<string, unknown[][]>) => {
  const wb = book([...rows, [f]], other);
  recalculate(wb, "Sheet1", new Date(2026, 9, 29, 14, 30));
  const c = wb.Sheets["Sheet1"]![XLSX.utils.encode_cell({ r: rows.length, c: 0 })] as XLSX.CellObject;
  return c.t === "e" ? c.w : c.v;
};

describe("working out a template's formulas", () => {
  it("does arithmetic in Excel's order", () => {
    expect(value("=1+2*3")).toBe(7);
    expect(value("=-2^2")).toBe(4);
    expect(value("=2^3^2")).toBe(64);
    expect(value("=50%*10")).toBe(5);
    expect(value("=(1+2)*3")).toBe(9);
    expect(value("=1/0")).toBe("#DIV/0!");
    expect(value('="a"&1&TRUE')).toBe("a1TRUE");
  });

  it("reads cells, ranges and other sheets, treating blanks as Excel does", () => {
    const rows = [[8, 7.5, null, "note"], [1, 2, 3, 4]];
    expect(value("=SUM(A1:D2)", rows)).toBe(25.5);
    expect(value("=$A$1*B1", rows)).toBe(60);
    expect(value("=C1+1", rows)).toBe(1);
    expect(value("=D1+1", rows)).toBe("#VALUE!");
    expect(value("=COUNT(A1:D2)", rows)).toBe(6);
    expect(value("=COUNTA(A1:D2)", rows)).toBe(7);
    expect(value("=SUM(B:B)", rows)).toBe(9.5);
    expect(value("='Rates sheet'!B1*2", rows, { "Rates sheet": [[0, 21]] })).toBe(42);
  });

  it("follows formulas that depend on other formulas, and replaces old cached results", () => {
    const wb = book([[2, "=A1*10", "=B1+1"]]);
    recalculate(wb, "Sheet1");
    expect(wb.Sheets["Sheet1"]!["C1"].v).toBe(21);
    expect(wb.Sheets["Sheet1"]!["B1"].v).toBe(20);
  });

  it("shows results in the cell's number format", () => {
    const wb = book([[3.14159, "=A1*2"]]);
    (wb.Sheets["Sheet1"]!["B1"] as XLSX.CellObject).z = "0.00";
    recalculate(wb, "Sheet1");
    expect(wb.Sheets["Sheet1"]!["B1"].w).toBe("6.28");
  });

  it("knows the usual functions", () => {
    const rows = [[8, 9, 10], ["Mon", "Sat", "Sun"]];
    expect(value("=ROUND(1.005,2)")).toBe(1.01);
    expect(value("=ROUND(-2.5,0)")).toBe(-3);
    expect(value("=ROUNDDOWN(2.79,1)")).toBe(2.7);
    expect(value('=IF(A1>8,"OT","")', rows)).toBe("");
    expect(value('=IF(B1>8,"OT","")', rows)).toBe("OT");
    expect(value("=IFERROR(1/0,0)")).toBe(0);
    expect(value("=MAX(A1:C1)-MIN(A1:C1)", rows)).toBe(2);
    expect(value('=SUMIF(A2:C2,"S*",A1:C1)', rows)).toBe(19);
    expect(value('=COUNTIF(A1:C1,">8")', rows)).toBe(2);
    expect(value("=SUMPRODUCT(A1:C1,A1:C1)", rows)).toBe(245);
    expect(value("=AND(A1>1,B1>1)", rows)).toBe(true);
    expect(value('=TEXT(0.5,"h:mm")')).toBe("12:00");
  });

  it("handles dates and times as serial numbers", () => {
    expect(value("=DATE(2026,10,29)")).toBe(46324);
    expect(value("=TODAY()")).toBe(46324);
    expect(value("=WEEKDAY(DATE(2026,10,29))")).toBe(5);
    expect(value("=WEEKDAY(DATE(2026,10,29),2)")).toBe(4);
    expect(value("=YEAR(46324)&\"-\"&MONTH(46324)&\"-\"&DAY(46324)")).toBe("2026-10-29");
    expect(value("=DATE(1900,3,1)")).toBe(61);
    expect(value("=(B1-A1)*24", [[0.375, 0.71875]])).toBeCloseTo(8.25);
    expect(value("=HOUR(0.71875)")).toBe(17);
  });

  it("refuses what it can't work out, naming the cell", () => {
    expect(() => value("=XLOOKUP(1,A1:A2,B1:B2)")).toThrow(/Cell A2 on "Sheet1" \(=XLOOKUP\(1,A1:A2,B1:B2\)\) uses the function XLOOKUP/);
    expect(() => value("=Rate*2")).toThrow(/uses the name "Rate"/);
    expect(() => value("=Missing!A1")).toThrow(/a sheet "Missing"/);
    expect(() => recalculate(book([["=B1", "=A1"]]), "Sheet1")).toThrow(/circular reference/);
  });
});
