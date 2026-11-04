// @vitest-environment node
// Deep scan: random sequences of real store operations against the SQLite database, checking the invariants the app
// relies on after every step.
import { describe, expect, it } from "vitest";
import { memoryDb } from "./sqlite-db";
import { createLocalStore, type DataStore } from "@/lib/db/store";
import { UndoHistory, undoableStore } from "@/lib/db/undo";
import { canonical, exportSnapshot, replaceWithSnapshot, type Snapshot } from "@/lib/db/snapshot";
import { lockThrough, setRecordsLocked } from "@/lib/pay-freeze";
import type { LocalDb } from "@/lib/db/local";

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n: number) => String(n).padStart(2, "0");
const day = (r: () => number) => `2026-${pad(9 + Math.floor(r() * 3))}-${pad(1 + Math.floor(r() * 28))}`;
const time = (r: () => number) => `${pad(Math.floor(r() * 24))}:${pad(Math.floor(r() * 60))}`;
const pick = <T,>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)]!;

async function data(db: LocalDb) {
  const s = await exportSnapshot(db);
  return canonical(s.data);
}

async function setup() {
  const db = await memoryDb();
  const history = new UndoHistory(async () => db);
  const store = undoableStore(createLocalStore(async () => db), history);
  return { db, history, store };
}

type Op = { name: string; run: () => Promise<{ error: Error | null } | void> };

async function randomOp(r: () => number, store: DataStore, n: number): Promise<Op> {
  const emps = await store.listEmployees();
  const recs = await store.listRecordsMatching({});
  const shifts = await store.listShifts();
  const k = Math.floor(r() * 14);
  if (k === 0 || emps.length < 2) {
    return { name: "add employee", run: () => store.insert("employees", { employee_code: `E${n}`, first_name: pick(r, ["Ann", "Bo", "Cy", "ann"]), last_name: `L${n}`, hourly_rate: Math.round(r() * 4000) / 100, shift_id: r() < 0.5 ? pick(r, shifts).id : null, pay_type: r() < 0.2 ? "salary" : "hourly" }) };
  }
  const e = pick(r, emps);
  switch (k) {
    case 1: case 2: case 3: {
      const rows = Array.from({ length: 1 + Math.floor(r() * 3) }, () => r() < 0.6
        ? { employee_id: pick(r, emps).id, work_date: day(r), entry_mode: "clock" as const, clock_in: time(r), clock_out: time(r), lunch_minutes: pick(r, [0, 15, 30, 60]), shift_id: r() < 0.3 ? pick(r, shifts).id : null }
        : { employee_id: pick(r, emps).id, work_date: day(r), entry_mode: "hours" as const, hours: Math.round(r() * 1200) / 100, pay_override: r() < 0.1 ? Math.round(r() * 30000) / 100 : null });
      return { name: `add ${rows.length} records`, run: () => store.insert("time_records", rows) };
    }
    case 4: if (recs.length) {
      const x = pick(r, recs);
      const patch = r() < 0.5 ? { note: `n${n}`, lunch_minutes: pick(r, [0, 30, 45]) } : { work_date: day(r), hours: x.entry_mode === "hours" ? Math.round(r() * 1000) / 100 : x.hours };
      return { name: "edit record", run: () => store.update("time_records", x.id, patch) };
    } break;
    case 5: if (recs.length) {
      const sel = recs.filter(() => r() < 0.3).map((x) => x.id);
      return { name: `delete ${sel.length} records`, run: () => store.removeMany("time_records", sel) };
    } break;
    case 6: return { name: "change rate", run: () => store.update("employees", e.id, { hourly_rate: Math.round(r() * 5000) / 100 }) };
    case 7: return { name: "delete employee", run: () => store.remove("employees", e.id) };
    case 8: return { name: "lock", run: () => lockThrough(store, r() < 0.2 ? null : day(r)) };
    case 9: if (recs.length) {
      const sel = recs.filter(() => r() < 0.3);
      return { name: "unlock/relock records", run: () => setRecordsLocked(store, sel, r() < 0.5) };
    } break;
    case 10: return { name: "adjustment", run: () => store.insert("pay_adjustments", { employee_id: e.id, pay_date: day(r), category: "bonus", amount: Math.round(r() * 10000) / 100 - 20 }) };
    case 11: return { name: "settings", run: () => store.saveSettings({ ot_threshold: pick(r, [35, 40, 44]), ot_multiplier: pick(r, [1.5, 2]), weekend_overtime: r() < 0.5, visible_columns: ["a"] }) };
    case 12: return { name: "import upsert", run: () => store.upsertEmployeesByCode([{ employee_code: e.employee_code, first_name: "Up", last_name: e.last_name, hourly_rate: Math.round(r() * 3000) / 100 }, { employee_code: `I${n}`, first_name: "New", last_name: "Imp", hourly_rate: 15 }]) };
    case 13: if (recs.length) {
      const sel = recs.filter(() => r() < 0.4);
      return { name: `bulk edit ${sel.length}`, run: async () => store.updateMany("time_records", sel.map((x) => ({ id: x.id, patch: { note: `bulk${n}` } }))) };
    } break;
  }
  return { name: "add employee", run: () => store.insert("employees", { employee_code: `X${n}`, first_name: "X", last_name: "Y", hourly_rate: 10 }) };
}

describe("deep scan: random store operations", () => {
  for (const seed of Array.from({ length: Number(process.env["DEEP_SEEDS"] ?? 8) }, (_, i) => i + 1)) {
    it(`seed ${seed}: failed writes change nothing; undo all and redo all retrace every state; a backup restores exactly`, async () => {
      const r = rng(seed);
      const { db, history, store } = await setup();
      const states = [await data(db)];
      const labels: string[] = [];
      let failures = 0;
      for (let n = 0; n < Number(process.env["DEEP_OPS"] ?? 60); n++) {
        const op = await randomOp(r, store, n);
        const before = await data(db);
        const undoBefore = history.nextUndo;
        const top = (history as unknown as { undoStack: unknown[] }).undoStack.at(-1);
        let error: Error | null = null;
        try { error = (await op.run())?.error ?? null; } catch (e) { error = e as Error; }
        const after = await data(db);
        if (error) {
          failures++;
          // All or nothing: a refused write leaves no trace, and no undo step.
          expect(after, `${op.name} failed (${error.message}) but changed data`).toBe(before);
          expect(history.nextUndo).toBe(undoBefore);
          expect(error.message).toMatch(/locked|required|Lunch break|UNIQUE|FOREIGN|longer|isn't/i);
          continue;
        }
        const steps = (history as unknown as { undoStack: unknown[] }).undoStack.at(-1) === top ? 0 : 1;
        if (steps === 0) expect(after, `${op.name} changed data without an undo step`).toBe(before);
        else { states.push(after); labels.push(op.name); }
      }
      // The history keeps the latest 100 steps.
      const kept = Math.min(states.length - 1, 100);
      states.splice(0, states.length - 1 - kept); labels.splice(0, labels.length - kept);
      const steps = states.length - 1;
      // Undo everything, checking each intermediate state.
      for (let i = steps; i > 0; i--) {
        let label: string | null;
        try { label = await history.undo(); } catch (e) { throw new Error(`undoing step ${i} "${labels[i - 1]}" (steps: ${labels.join(" | ")}): ${(e as Error).message}`); }
        expect(label, `undo step ${i} (${labels[i - 1]})`).not.toBeNull();
        const got = await data(db);
        if (got !== states[i - 1]) {
          const a = JSON.parse(got) as Record<string, unknown[]>, b = JSON.parse(states[i - 1]!) as Record<string, unknown[]>;
          for (const t of Object.keys(b)) {
            const sa = new Set(a[t]!.map((x) => JSON.stringify(x))), sb = new Set(b[t]!.map((x) => JSON.stringify(x)));
            for (const x of sa) if (!sb.has(x)) console.log("HAVE", t, x);
            for (const x of sb) if (!sa.has(x)) console.log("WANT", t, x);
          }
        }
        expect(got, `after undoing "${labels[i - 1]}"`).toBe(states[i - 1]);
      }
      expect(await history.undo()).toBeNull();
      for (let i = 1; i <= steps; i++) {
        await history.redo();
        expect(await data(db), `after redoing "${labels[i - 1]}"`).toBe(states[i]);
      }
      // A backup (through JSON, as files do) restores into a new database exactly.
      const snap = JSON.parse(JSON.stringify(await exportSnapshot(db))) as Snapshot;
      const fresh = await memoryDb();
      await replaceWithSnapshot(fresh, snap);
      expect(await data(fresh)).toBe(states[steps]);
      void failures;
    }, 120_000);
  }
});

describe("deep scan: paging", () => {
  it("pages cover every matching record once, for every sort and filter", async () => {
    const r = rng(42);
    const { db, store } = await setup();
    for (let i = 0; i < 6; i++) await store.insert("employees", { employee_code: `P${i}`, first_name: pick(r, ["ann", "Ann", "Bo", null as never]) ?? "Z", last_name: `L${i}`, hourly_rate: 10 });
    const emps = await store.listEmployees();
    const shifts = await store.listShifts();
    const rows = Array.from({ length: 130 }, () => ({ employee_id: pick(r, emps).id, work_date: day(r), entry_mode: "hours" as const, hours: pick(r, [1, 2, 8, 8, 8]), shift_id: r() < 0.5 ? pick(r, shifts).id : null }));
    expect((await store.insert("time_records", rows)).error).toBeNull();
    await store.remove("employees", emps[0]!.id);
    for (const sort of [undefined, { by: "date", desc: false }, { by: "employee", desc: true }, { by: "employee", desc: false }, { by: "hours", desc: true }, { by: "hours", desc: false }] as const) {
      for (const filter of [{}, { from: "2026-10-01", to: "2026-10-31" }, { employeeIds: [emps[1]!.id, emps[2]!.id] }, { employeeIds: [] }, { mode: "clock" as const }, { shifts: { ids: [shifts[0]!.id], employeeIds: [emps[3]!.id] } }]) {
        const all = await store.listRecordsMatching(filter);
        const seen: string[] = [];
        let total = -1;
        for (let off = 0; ; off += 7) {
          const page = await store.listRecordsPage({ ...filter, sort: sort as never }, off, 7);
          total = page.total;
          if (!page.rows.length) break;
          seen.push(...page.rows.map((x) => x.id));
        }
        expect(new Set(seen).size, JSON.stringify({ sort, filter })).toBe(seen.length);
        expect([...seen].sort()).toEqual(all.map((x) => x.id).sort());
        expect(total).toBe(all.length);
      }
    }
    void db;
  }, 60_000);
});

describe("deep scan: one transaction at a time", () => {
  it("never runs a query inside another's transaction, and queues any number of transactions", async () => {
    const db = await memoryDb();
    await db.exec("create table t (x text)");
    for (let round = 0; round < 50; round++) {
      await db.query("delete from t");
      const jobs: Promise<unknown>[] = [];
      const want: string[] = [];
      for (let i = 0; i < 12; i++) {
        if (i % 3 === 0) {
          // A transaction that fails after writing: its rows must vanish, and only its rows.
          jobs.push(db.transaction(async (tx) => { await tx.query("insert into t values ($1)", [`rolled back ${i}`]); await new Promise((r) => setTimeout(r, i % 2)); throw new Error("no"); }).catch(() => {}));
        } else if (i % 3 === 1) {
          jobs.push(db.transaction(async (tx) => { await tx.query("insert into t values ($1)", [`tx ${i}`]); await new Promise((r) => setTimeout(r, 1)); }));
          want.push(`tx ${i}`);
        } else {
          jobs.push(db.query("insert into t values ($1)", [`alone ${i}`]));
          want.push(`alone ${i}`);
        }
      }
      await Promise.all(jobs);
      const rows = (await db.query<{ x: string }>("select x from t")).rows.map((r) => r.x).sort();
      expect(rows).toEqual(want.sort());
    }
  }, 60_000);
});
