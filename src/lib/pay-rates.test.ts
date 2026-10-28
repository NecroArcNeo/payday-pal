import { describe, expect, it } from "vitest";
import { currentAfterDelete, planRateChange, rateOn, ratesBetween, SINCE_START } from "./pay-rates";

const history = [
  { effective_from: "2026-11-01", hourly_rate: "22.00" },
  { effective_from: SINCE_START, hourly_rate: "20.00" },
  { effective_from: "2026-12-01", hourly_rate: 25 },
];

describe("pay rate history", () => {
  it("pays each day the latest rate starting on or before it", () => {
    expect(rateOn(history, 25, "2026-10-31")).toBe(20);
    expect(rateOn(history, 25, "2026-11-01")).toBe(22);
    expect(rateOn(history, 25, "2026-11-30")).toBe(22);
    expect(rateOn(history, 25, "2027-01-01")).toBe(25);
  });

  it("uses the current rate with no history, and the first entry for days before it", () => {
    expect(rateOn([], "18.5", "2026-01-01")).toBe(18.5);
    expect(rateOn(undefined, 18, "2026-01-01")).toBe(18);
    expect(rateOn([{ effective_from: "2026-11-01", hourly_rate: 22 }], 22, "2026-10-01")).toBe(22);
  });

  it("lists the rates paid over a period", () => {
    expect(ratesBetween(history, 25, "2026-10-26", "2026-11-08")).toEqual([20, 22]);
    expect(ratesBetween(history, 25, "2026-11-02", "2026-11-08")).toEqual([22]);
    expect(ratesBetween([], 18, "2026-11-02", "2026-11-08")).toEqual([18]);
  });
});

describe("changing a rate", () => {
  const h = [{ id: "s", effective_from: SINCE_START, hourly_rate: 20 }, { id: "n", effective_from: "2026-11-01", hourly_rate: 22 }];

  it("keeps the old rate before a dated change, the first time", () => {
    expect(planRateChange([], 20, 23, { from: "2026-10-20" })).toEqual({
      insert: [{ effective_from: SINCE_START, hourly_rate: 20 }, { effective_from: "2026-10-20", hourly_rate: 23 }], update: [], current: 23,
    });
  });

  it("adds a change, re-rates one on the same day, and keeps a later change current", () => {
    expect(planRateChange(h, 22, 24, { from: "2026-12-01" })).toEqual({ insert: [{ effective_from: "2026-12-01", hourly_rate: 24 }], update: [], current: 24 });
    expect(planRateChange(h, 22, 23, { from: "2026-11-01" })).toEqual({ insert: [], update: [{ id: "n", hourly_rate: 23 }], current: 23 });
    // A raise backdated before the Nov 1 one: October pays 21, but the current rate stays 22.
    expect(planRateChange(h, 22, 21, { from: "2026-10-01" })).toEqual({ insert: [{ effective_from: "2026-10-01", hourly_rate: 21 }], update: [], current: 22 });
  });

  it("fixes the current rate where it applies, for a typo", () => {
    expect(planRateChange(h, 22, 21, "correct")).toEqual({ insert: [], update: [{ id: "n", hourly_rate: 21 }], current: 21 });
    expect(planRateChange([], 20, 21, "correct")).toEqual({ insert: [{ effective_from: SINCE_START, hourly_rate: 21 }], update: [], current: 21 });
  });

  it("works out the current rate after deleting an entry", () => {
    expect(currentAfterDelete(h, "n", 99)).toBe(20);
    expect(currentAfterDelete(h, "s", 99)).toBe(22);
    expect(currentAfterDelete([], "x", 99)).toBe(99);
  });
});
