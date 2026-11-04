import { describe, expect, it } from "vitest";
import { centsAddingUp, readAmount } from "./amount";

describe("readAmount", () => {
  it("reads amounts written with either decimal mark", () => {
    expect(readAmount("12,50")).toBe(12.5);
    expect(readAmount("$1,234.56")).toBe(1234.56);
    expect(readAmount("1.234,56")).toBe(1234.56);
    expect(readAmount("1,234")).toBe(1234);
    expect(readAmount("€ 7")).toBe(7);
    expect(readAmount("(50)")).toBe(-50);
    expect(readAmount("-3.5")).toBe(-3.5);
    expect(readAmount(".5")).toBe(0.5);
  });
  it("refuses anything that isn't a plain number", () => {
    for (const s of ["", "abc", "0x10", "1e5", "Infinity", "1.2.3", "5-", "--5"]) expect(readAmount(s), s).toBeNaN();
  });
});

describe("centsAddingUp", () => {
  it("rounds to the cent and always adds up to the total", () => {
    expect(centsAddingUp([11312.984, 10747.174, 10272.092], 3233225)).toEqual([11312.99, 10747.17, 10272.09]);
    expect(centsAddingUp([0.333, 0.333, 0.334], 100)).toEqual([0.33, 0.33, 0.34]);
    expect(centsAddingUp([-0.004, 0.006], 0)).toEqual([0, 0]);
    for (let n = 0; n < 500; n++) {
      const xs = Array.from({ length: 1 + (n % 9) }, (_, i) => ((n * 7919 + i * 104729) % 100000) / 997);
      const total = Math.round(xs.reduce((s, x) => s + x, 0) * 100);
      const got = centsAddingUp(xs, total);
      expect(Math.round(got.reduce((s, x) => s + x, 0) * 100)).toBe(total);
      got.forEach((g, i) => expect(Math.abs(g - xs[i]!)).toBeLessThan(0.0101));
    }
  });
});
