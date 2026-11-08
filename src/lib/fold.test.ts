import { describe, expect, it } from "vitest";
import { isFolded, withFold } from "./fold";

describe("folded boxes", () => {
  it("adds and removes a box once", () => {
    expect(withFold([], "a", true)).toEqual(["a"]);
    expect(withFold(["a"], "a", true)).toEqual(["a"]);
    expect(withFold(["a", "b"], "a", false)).toEqual(["b"]);
    expect(isFolded(["a"], "a")).toBe(true);
    expect(isFolded(["a"], "b")).toBe(false);
  });

  it("starts again from a bad saved value", () => {
    expect(isFolded("a", "a")).toBe(false);
    expect(withFold({ a: 1 }, "x", true)).toEqual(["x"]);
    expect(withFold(["a", 3, null], "b", true)).toEqual(["a", "b"]);
  });
});
