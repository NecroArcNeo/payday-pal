// @vitest-environment node
import { describe, expect, it } from "vitest";
import { labelOf, setAlias } from "./labels";

describe("label aliases", () => {
  it("covers the real name, and an empty alias brings it back", () => {
    expect(labelOf("department", "Department")).toBe("Department");
    setAlias("department", "  Team  ", "Department");
    expect(labelOf("department", "Department")).toBe("Team");
    expect(labelOf("department", "Dept")).toBe("Team");
    setAlias("department", "   ", "Department");
    expect(labelOf("department", "Department")).toBe("Department");
  });

  it("drops an alias that's just the real name, and keeps aliases apart", () => {
    setAlias("hours", "Hours", "Hours");
    setAlias("custom:abc", "Shirt", "T-shirt size");
    expect(labelOf("hours", "Hours")).toBe("Hours");
    expect(labelOf("custom:abc", "T-shirt size")).toBe("Shirt");
    expect(labelOf("custom:def", "Badge")).toBe("Badge");
  });
});
