import { describe, expect, it } from "vitest";
import { rangeSelection, sameSelection } from "./drag-select";

const order = ["a", "b", "c", "d", "e"];
const ids = (s: Set<string>) => [...s].sort().join("");

describe("selecting rows by dragging", () => {
  it("ticks every row from where the drag started to where it is, either way round", () => {
    expect(ids(rangeSelection(new Set(), order, "b", "d", true))).toBe("bcd");
    expect(ids(rangeSelection(new Set(), order, "d", "b", true))).toBe("bcd");
    expect(ids(rangeSelection(new Set(), order, "c", "c", true))).toBe("c");
  });

  it("adds to what was selected before, and dragging back gives rows back as they were", () => {
    const base = new Set(["a", "e"]);
    expect(ids(rangeSelection(base, order, "b", "d", true))).toBe("abcde");
    // Back up to c: d returns to unselected (as before the drag), e stays selected.
    expect(ids(rangeSelection(base, order, "b", "c", true))).toBe("abce");
  });

  it("unticks the range when the drag started by unticking", () => {
    expect(ids(rangeSelection(new Set(order), order, "b", "d", false))).toBe("ae");
  });

  it("leaves the selection alone for rows no longer in the table", () => {
    expect(ids(rangeSelection(new Set(["a"]), order, "gone", "c", true))).toBe("a");
  });

  it("compares selections by their rows", () => {
    expect(sameSelection(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true);
    expect(sameSelection(new Set(["a"]), new Set(["a", "b"]))).toBe(false);
  });
});
