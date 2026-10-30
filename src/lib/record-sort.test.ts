import { describe, expect, it } from "vitest";
import { directionLabel, sortRecords } from "./record-sort";

const r = (id: string, work_date: string, hours: number, name: string) => ({ id, work_date, hours, name, created_at: `${work_date}T09:00:00Z` });
const rows = [r("a", "2026-10-20", 8, "Bo"), r("b", "2026-10-22", 4, "amy"), r("c", "2026-10-21", 8, "Cy"), r("d", "2026-10-19", 2, "Bo")];
const pay: Record<string, number | undefined> = { a: 160, b: 300, c: 120, d: undefined };
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
const opts = { name: (x: (typeof rows)[number]) => x.name, pay: (x: (typeof rows)[number]) => pay[x.id] };

describe("sorting time records", () => {
  it("goes by date, newest first, or flipped to oldest first", () => {
    expect(ids(sortRecords(rows, { by: "date", desc: true }))).toEqual(["b", "c", "a", "d"]);
    expect(ids(sortRecords(rows, { by: "date", desc: false }))).toEqual(["d", "a", "c", "b"]);
  });

  it("goes by name ignoring case, each person's records newest first", () => {
    expect(ids(sortRecords(rows, { by: "employee", desc: false }, opts))).toEqual(["b", "a", "d", "c"]);
    expect(ids(sortRecords(rows, { by: "employee", desc: true }, opts))).toEqual(["c", "a", "d", "b"]);
  });

  it("goes by hours, equal hours newest first", () => {
    expect(ids(sortRecords(rows, { by: "hours", desc: true }))).toEqual(["c", "a", "b", "d"]);
  });

  it("goes by pay, with pay not worked out yet always last", () => {
    expect(ids(sortRecords(rows, { by: "pay", desc: true }, opts))).toEqual(["b", "a", "c", "d"]);
    expect(ids(sortRecords(rows, { by: "pay", desc: false }, opts))).toEqual(["c", "a", "b", "d"]);
  });

  it("leaves the list it was given alone, and says which way round it is", () => {
    const copy = [...rows];
    sortRecords(rows, { by: "hours", desc: false });
    expect(rows).toEqual(copy);
    expect(directionLabel({ by: "pay", desc: false })).toBe("Lowest pay first");
  });
});
