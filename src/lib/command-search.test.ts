import { describe, expect, it } from "vitest";
import { editDistance, matchCommands } from "./command-search";

const list = [
  { id: "records", label: "Time records", keywords: "hours shifts clock" },
  { id: "payroll", label: "Payroll", keywords: "pay run" },
  { id: "lock", label: "Lock a paid period", keywords: "payroll close" },
  { id: "export", label: "Export a timesheet", keywords: "excel pdf csv" },
];
const ids = (q: string) => matchCommands(list, q).map((c) => c.id);

describe("Ctrl+K matching", () => {
  it("shows everything, in order, when nothing is typed", () => {
    expect(ids("  ")).toEqual(["records", "payroll", "lock", "export"]);
  });

  it("matches words at their start, in the label or keywords, any case", () => {
    expect(ids("PDF")).toEqual(["export"]);
    expect(ids("ord")).toEqual([]);
    expect(ids("clock hours")).toEqual(["records"]);
  });

  it("puts a label that starts with what's typed first, then labels with the words, then keyword matches", () => {
    expect(ids("pay")).toEqual(["payroll", "lock"]);
    expect(ids("lock")).toEqual(["lock"]);
    expect(ids("period")).toEqual(["lock"]);
  });

  it("needs every word", () => {
    expect(ids("export excel")).toEqual(["export"]);
    expect(ids("export word")).toEqual([]);
  });

  it("forgives a typo or two in longer words, ranking those after exact matches", () => {
    expect(ids("payrol")).toEqual(["payroll", "lock"]);
    expect(ids("tiemsheet")).toEqual(["export"]);
    expect(ids("recrods")).toEqual(["records"]);
    expect(ids("exel")).toEqual(["export"]);
    // Short words must be exact: "pa" or "cvs" could be a typo for too much.
    expect(ids("cvs")).toEqual([]);
    expect(ids("lokc")).toEqual(["lock"]);
  });

  it("puts typo matches after exact ones", () => {
    const more = [...list, { id: "clocks", label: "Clocks" }];
    expect(matchCommands(more, "clock").map((c) => c.id)).toEqual(["clocks", "records"]);
    expect(matchCommands([{ id: "a", label: "Holidya" }, { id: "b", label: "Holiday" }], "holiday").map((c) => c.id)).toEqual(["b", "a"]);
    // With typos, the label before the keywords: "paysilp" is the payslips action before a page about payslips.
    const slips = [{ id: "page", label: "Timesheet", keywords: "payslip" }, { id: "action", label: "Make payslips" }];
    expect(matchCommands(slips, "paysilp").map((c) => c.id)).toEqual(["action", "page"]);
  });
});

describe("editDistance", () => {
  it("counts additions, removals, changes and swaps as one each", () => {
    expect(editDistance("payroll", "payroll")).toBe(0);
    expect(editDistance("payrol", "payroll")).toBe(1);
    expect(editDistance("pyaroll", "payroll")).toBe(1);
    expect(editDistance("paxroll", "payroll")).toBe(1);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("kitten", "sitting")).toBe(3);
  });
});
