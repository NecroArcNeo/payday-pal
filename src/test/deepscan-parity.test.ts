// @vitest-environment node
// Deep scan: the desktop database (SQLite) and the cloud (Postgres, here PGlite) must agree on stored values.
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { memoryDb } from "./sqlite-db";
import { roundDecimal } from "@/lib/db/codec";

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pad = (n: number) => String(n).padStart(2, "0");

describe("deep scan: SQLite and Postgres agree", () => {
  it("worked hours for 3,000 random clock times (seconds, past midnight, breaks)", async () => {
    const r = rng(7);
    const pg = new PGlite();
    const db = await memoryDb();
    await db.query("insert into employees (id, employee_code, first_name, last_name) values ('e', 'E', 'A', 'B')");
    const cases = Array.from({ length: 3000 }, () => {
      const t = () => `${pad(Math.floor(r() * 24))}:${pad(Math.floor(r() * 60))}:${pad(r() < 0.5 ? 0 : Math.floor(r() * 60))}`;
      return { cin: t(), cout: t(), lunch: Math.floor(r() * 90) };
    });
    let mismatches = 0;
    const rows = await pg.query<{ h: string | null }>(
      `select case when m < 0 then null else round(m / 60.0, 2) end as h from (
         select (case when e < 0 then e + 1440 else e end) - l as m from (
           select extract(epoch from (o::time - i::time)) / 60 as e, l
           from unnest($1::text[], $2::text[], $3::int[]) as x(i, o, l)) a) b`,
      [cases.map((c) => c.cin), cases.map((c) => c.cout), cases.map((c) => c.lunch)],
    );
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i]!;
      const want = rows.rows[i]!.h;
      const id = `r${i}`;
      try {
        await db.query("insert into time_records (id, employee_id, work_date, entry_mode, clock_in, clock_out, lunch_minutes) values ($1, 'e', '2026-10-01', 'clock', $2, $3, $4)", [id, c.cin, c.cout, c.lunch]);
        const got = (await db.query<{ hours: number }>("select hours from time_records where id = $1", [id])).rows[0]!.hours;
        if (want === null || got !== Number(want)) { mismatches++; if (mismatches < 5) console.log("MISMATCH", c, got, want); }
      } catch (e) {
        if (want !== null) { mismatches++; if (mismatches < 5) console.log("REFUSED", c, want, (e as Error).message); }
      }
    }
    expect(mismatches).toBe(0);
    await pg.close();
  }, 120_000);

  it("money rounds like numeric(10,2) for 20,000 random amounts", async () => {
    const r = rng(9);
    const pg = new PGlite();
    const xs = Array.from({ length: 20000 }, (_, i) => {
      const k = i % 4;
      if (k === 0) return Math.floor(r() * 100000) / 1000; // exact thousandths: the half-way cases
      if (k === 1) return -Math.floor(r() * 100000) / 1000;
      if (k === 2) return r() * 10000;
      return Math.floor(r() * 1e6) / 1e4 + 0.005;
    });
    const { rows } = await pg.query<{ v: string }>("select (x::numeric)::numeric(10,2)::text as v from unnest($1::text[]) x", [xs.map(String)]);
    let bad = 0;
    xs.forEach((x, i) => {
      // The app sends numbers as text (JS shortest form), which numeric reads digit for digit.
      if (roundDecimal(x, 2) !== Number(rows[i]!.v)) { bad++; if (bad < 5) console.log("ROUND", x, roundDecimal(x, 2), rows[i]!.v); }
    });
    expect(bad).toBe(0);
    await pg.close();
  }, 120_000);
});
