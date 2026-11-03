import { describe, expect, it } from "vitest";
import { matchCommands } from "./command-search";

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
    expect(ids("ecords")).toEqual([]);
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
});
