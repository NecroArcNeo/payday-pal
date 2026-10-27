// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fieldType, fitsType, formatValue, toType } from "./field-types";
import { categoryValue } from "./import/parse";

describe("fieldType", () => {
  it("treats unknown or missing types as text", () => {
    expect(fieldType("date")).toBe("date");
    expect(fieldType("checkbox")).toBe("text");
    expect(fieldType(null)).toBe("text");
  });
});

describe("fitsType", () => {
  it("accepts empty values for every type", () => expect(fitsType("date", "")).toBe(true));
  it.each([
    ["number", "12.5", "twelve"], ["money", "-3", "$"], ["date", "2026-02-28", "2026-02-30"], ["time", "09:30", "9:30"],
    ["yesno", "yes", "maybe"], ["email", "a@b.co", "a@b"], ["tel", "+1 (555) 010-2000", "call me"], ["url", "https://acme.com/x", "acme.com"],
  ])("%s: %s fits, %s doesn't", (type, good, bad) => {
    expect(fitsType(type, good)).toBe(true);
    expect(fitsType(type, bad)).toBe(false);
  });
  it("accepts anything as text", () => expect(fitsType("text", "anything at all")).toBe(true));
});

describe("toType", () => {
  it("converts what it can and leaves the rest", () => {
    expect(toType("money", "$1,234.50")).toBe("1234.5");
    expect(toType("number", "n/a")).toBe("n/a");
    expect(toType("yesno", "Y")).toBe("yes");
    expect(toType("yesno", "FALSE")).toBe("no");
    expect(toType("url", "acme.com/team")).toBe("https://acme.com/team");
    expect(toType("text", "  padded ")).toBe("padded");
  });
});

describe("formatValue", () => {
  it("formats money and yes/no, leaves bad values alone", () => {
    expect(formatValue("money", "12")).toBe("$12.00");
    expect(formatValue("yesno", "no")).toBe("No");
    expect(formatValue("money", "lots")).toBe("lots");
  });
});

describe("categoryValue (import)", () => {
  it("reads dates and times from Excel serials, and converts text", () => {
    expect(categoryValue("date", { text: "3/1/26", serial: 46082 }, "mdy")).toBe("2026-03-01");
    expect(categoryValue("date", { text: "05/04/2026" }, "dmy")).toBe("2026-04-05");
    expect(categoryValue("time", { text: "7:30 PM" }, "mdy")).toBe("19:30");
    expect(categoryValue("yesno", { text: "x" }, "mdy")).toBe("yes");
    expect(categoryValue("date", { text: "soon" }, "mdy")).toBe("soon");
  });
});
