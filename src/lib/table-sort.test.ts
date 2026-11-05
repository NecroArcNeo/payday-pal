import { describe, expect, it } from "vitest";
import { directionLabel, nextSort, sortTable, validTableSort, type SortColumns } from "./table-sort";
import { newestFirst, recordColumns } from "./record-columns";
import type { PayLine } from "./pay";

const r = (id: string, work_date: string, hours: number, name: string, more: { clock_in?: string; note?: string } = {}) =>
  ({ id, work_date, hours, name, created_at: `${work_date}T09:00:00Z`, ...more });
type R = ReturnType<typeof r>;
const rows = [r("a", "2026-10-20", 8, "Bo", { clock_in: "09:00:00" }), r("b", "2026-10-22", 4, "amy", { note: "late" }), r("c", "2026-10-21", 8, "Cy", { clock_in: "07:30:00" }), r("d", "2026-10-19", 2, "Bo")];
const pay: Record<string, number | undefined> = { a: 160, b: 300, c: 120, d: undefined };
const line = (id: string) => (pay[id] === undefined ? undefined : ({ pay: pay[id], regular: 0, overtime: 0, regPay: 0, otPay: 0, manual: false } as PayLine));
const cols = recordColumns<R>({ name: (x) => x.name, shift: () => "Day", rate: () => 20, pay: (x) => line(x.id) });
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
const sorted = (by: string, desc: boolean) => ids(sortTable(rows, { by, desc }, cols, newestFirst));

describe("sorting time records by any column", () => {
  it("goes by date, newest first, or flipped to oldest first", () => {
    expect(sorted("date", true)).toEqual(["b", "c", "a", "d"]);
    expect(sorted("date", false)).toEqual(["d", "a", "c", "b"]);
  });

  it("goes by name ignoring case, each person's records newest first", () => {
    expect(sorted("employee", false)).toEqual(["b", "a", "d", "c"]);
    expect(sorted("employee", true)).toEqual(["c", "a", "d", "b"]);
  });

  it("goes by hours, equal hours newest first", () => {
    expect(sorted("hours", true)).toEqual(["c", "a", "b", "d"]);
  });

  it("goes by pay, with pay not worked out yet always last", () => {
    expect(sorted("total_pay", true)).toEqual(["b", "a", "c", "d"]);
    expect(sorted("total_pay", false)).toEqual(["c", "a", "b", "d"]);
  });

  it("puts empty cells last whichever way round (no clock-in, no note)", () => {
    expect(sorted("clock_in", false)).toEqual(["c", "a", "b", "d"]);
    expect(sorted("clock_in", true)).toEqual(["a", "c", "b", "d"]);
    expect(sorted("note", false)).toEqual(["b", "c", "a", "d"]);
  });

  it("leaves the list it was given alone", () => {
    const copy = [...rows];
    sortTable(rows, { by: "hours", desc: false }, cols);
    expect(rows).toEqual(copy);
  });
});

describe("sorting any table", () => {
  type E = { code: string; dept: string | null; rate: number };
  const people: E[] = [{ code: "E10", dept: "Ops", rate: 20 }, { code: "E2", dept: null, rate: 25 }, { code: "e1", dept: "front", rate: 20 }];
  const columns: SortColumns<E> = {
    code: { label: "ID", kind: "text", value: (e) => e.code },
    dept: { label: "Department", kind: "text", value: (e) => e.dept },
    rate: { label: "Rate", kind: "number", value: (e) => e.rate },
  };

  it("reads numbers inside text as numbers, ignoring case (E2 before E10)", () => {
    expect(sortTable(people, { by: "code", desc: false }, columns).map((e) => e.code)).toEqual(["e1", "E2", "E10"]);
  });

  it("is stable: equal values keep the order they came in", () => {
    expect(sortTable(people, { by: "rate", desc: false }, columns).map((e) => e.code)).toEqual(["E10", "e1", "E2"]);
    expect(sortTable(people, { by: "dept", desc: true }, columns).map((e) => e.code)).toEqual(["E10", "e1", "E2"]);
  });

  it("starts a column its usual way round, and flips it when picked again", () => {
    expect(nextSort({ by: "code", desc: false }, "rate", columns["rate"] as never)).toEqual({ by: "rate", desc: true });
    expect(nextSort({ by: "rate", desc: true }, "rate", columns["rate"] as never)).toEqual({ by: "rate", desc: false });
    expect(nextSort({ by: "rate", desc: true }, "code", columns["code"] as never)).toEqual({ by: "code", desc: false });
  });

  it("keeps a remembered sort only while the table has that column, and knows old names", () => {
    expect(validTableSort({ by: "rate", desc: false }, columns as never, { by: "code", desc: false })).toEqual({ by: "rate", desc: false });
    expect(validTableSort({ by: "gone", desc: true }, columns as never, { by: "code", desc: false })).toEqual({ by: "code", desc: false });
    expect(validTableSort({ by: "pay", desc: true }, cols as never, { by: "date", desc: true })).toEqual({ by: "total_pay", desc: true });
    expect(validTableSort("junk", columns as never, { by: "code", desc: false })).toEqual({ by: "code", desc: false });
  });

  it("says which way round it is, by the column's kind", () => {
    expect(directionLabel({ by: "rate", desc: false }, columns["rate"] as never)).toBe("Lowest first");
    expect(directionLabel({ by: "code", desc: true }, columns["code"] as never)).toBe("Z → A");
    expect(directionLabel({ by: "date", desc: true }, cols["date"] as never)).toBe("Newest first");
  });
});
