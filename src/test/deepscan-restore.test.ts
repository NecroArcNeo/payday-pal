// @vitest-environment node
// Deep scan: damaged backups and private fields.
import { describe, expect, it } from "vitest";
import { memoryDb } from "./sqlite-db";
import { createLocalStore } from "@/lib/db/store";
import { canonical, exportSnapshot, replaceWithSnapshot, type Snapshot } from "@/lib/db/snapshot";
import { keepPrivate, redactSnapshot, PRIVATE_COLUMNS, customKey } from "@/lib/db/privacy";

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;

async function sample() {
  const db = await memoryDb();
  const store = createLocalStore(async () => db);
  await store.insert("employee_field_defs", { label: "Locker", field_type: "text" });
  const def = (await store.listFieldDefs())[0]!;
  await store.insert("employees", [
    { employee_code: "A1", first_name: "Ann", last_name: "Lee", hourly_rate: 21.5, ssn: "123", date_of_birth: "1990-02-03", department: "Ops", custom_fields: { [def.id]: "L7" } },
    { employee_code: "B2", first_name: "Bo", last_name: "Ng", hourly_rate: 18, phone: "555" },
  ]);
  const [a, b] = await store.listEmployees();
  await store.update("employees", a!.id, { hourly_rate: 23 });
  await store.insert("time_records", [
    { employee_id: a!.id, work_date: "2026-10-05", entry_mode: "clock", clock_in: "22:00", clock_out: "06:30", lunch_minutes: 30 },
    { employee_id: b!.id, work_date: "2026-10-06", entry_mode: "hours", hours: 7.25, pay_override: 99.99 },
  ]);
  await store.insert("pay_adjustments", { employee_id: b!.id, pay_date: "2026-10-07", category: "bonus", amount: 50 });
  await store.saveSettings({ ot_threshold: 40, ot_multiplier: 1.5, weekend_overtime: true, visible_columns: ["x"] });
  await store.saveEmployeeDefaults({ city: "Here", department: "Ops" });
  return { db, def, snap: JSON.parse(JSON.stringify(await exportSnapshot(db))) as Snapshot };
}

const DAMAGE: ((s: Snapshot, r: () => number) => string)[] = [
  (s) => { (s.data.time_records[0] as Record<string, unknown>)["hours"] = "lots"; return "hours text"; },
  (s) => { (s.data.time_records[0] as Record<string, unknown>)["work_date"] = "2026-02-30"; return "Feb 30"; },
  (s) => { (s.data.time_records[0] as Record<string, unknown>)["clock_in"] = "25:00:00"; return "25:00"; },
  (s) => { (s.data.time_records[0] as Record<string, unknown>)["employee_id"] = "nobody"; return "orphan record"; },
  (s) => { (s.data.employees[1] as Record<string, unknown>)["id"] = s.data.employees[0]!["id"]; return "duplicate id"; },
  (s) => { (s.data.employees[1] as Record<string, unknown>)["employee_code"] = s.data.employees[0]!["employee_code"]; return "duplicate code"; },
  (s) => { (s.data.employees[0] as Record<string, unknown>)["active"] = "maybe"; return "bool text"; },
  (s) => { (s.data.time_records[1] as Record<string, unknown>)["lunch_minutes"] = -5; return "negative break"; },
  (s) => { (s.data.time_records[1] as Record<string, unknown>)["lunch_minutes"] = 2.5; return "fractional break"; },
  (s) => { (s.data.shifts[0] as Record<string, unknown>)["multiplier"] = 0; return "zero multiplier"; },
  (s) => { (s.data.employees[0] as Record<string, unknown>)["created_at"] = "yesterday"; return "bad timestamp"; },
  (s) => { delete (s.data.time_records[0] as Record<string, unknown>)["id"]; return "row without id"; },
  (s) => { (s.data.time_records[0] as Record<string, unknown>)["entry_mode"] = "guess"; return "bad entry mode"; },
  (s) => { (s.data as Record<string, unknown>)["pay_rates"] = "none"; return "table not a list"; },
  (s) => { s.data.payroll_settings.push({ ...s.data.payroll_settings[0]! }); return "two settings rows"; },
  (s, r) => { const t = pick(r, ["employees", "time_records", "pay_rates"] as const); const row = s.data[t][0] as Record<string, unknown>; delete row[pick(r, Object.keys(row))]; return `${t} row missing a column`; },
];

describe("deep scan: restoring damaged backups", () => {
  it("each damage either restores whole or changes nothing", async () => {
    const r = rng(5);
    const { db, snap } = await sample();
    const before = canonical((await exportSnapshot(db)).data);
    const outcomes: string[] = [];
    for (let n = 0; n < 160; n++) {
      const s = JSON.parse(JSON.stringify(snap)) as Snapshot;
      const what = DAMAGE[n % DAMAGE.length]!(s, r);
      const target = await memoryDb();
      await replaceWithSnapshot(target, JSON.parse(JSON.stringify(snap)));
      const was = canonical((await exportSnapshot(target)).data);
      expect(was).toBe(before);
      try {
        await replaceWithSnapshot(target, s);
        // Accepted: it must be a sound database (keys, checks), with hours worked out by the database's rule.
        const fk = await target.query("pragma foreign_key_check");
        expect(fk.rows, what).toEqual([]);
        const ic = await target.query<{ integrity_check: string }>("pragma integrity_check");
        expect(ic.rows[0]!.integrity_check, what).toBe("ok");
        outcomes.push(`ok: ${what}`);
      } catch (e) {
        expect(canonical((await exportSnapshot(target)).data), `${what} failed (${(e as Error).message}) but changed data`).toBe(was);
        outcomes.push(`refused: ${what}: ${(e as Error).message.slice(0, 80)}`);
      }
    }
    console.log([...new Set(outcomes)].sort().join("\n"));
  }, 120_000);
});

describe("deep scan: private fields", () => {
  it("redacted snapshots hold no private value, and pulling them back keeps this device's", async () => {
    const r = rng(3);
    const { snap, def } = await sample();
    const all = [...PRIVATE_COLUMNS, customKey(def.id)];
    for (let n = 0; n < 500; n++) {
      const keys = all.filter(() => r() < 0.5);
      const s = JSON.parse(JSON.stringify(snap)) as Snapshot;
      const red = redactSnapshot(s, keys);
      const text = JSON.stringify(red);
      for (const e of red.data.employees) {
        for (const k of keys) {
          if (k.startsWith("custom:")) expect((e["custom_fields"] as Record<string, unknown> | null)?.[k.slice(7)], k).toBeUndefined();
          else expect(e[k] ?? null, k).toBeNull();
        }
      }
      const d = red.data.payroll_settings[0]!["employee_defaults"] as Record<string, unknown>;
      for (const k of keys) if (!k.startsWith("custom:")) expect(d[k], `defaults ${k}`).toBeUndefined();
      if (keys.includes("ssn")) expect(text).not.toContain('"123"');
      if (keys.includes(customKey(def.id))) expect(text).not.toContain("L7");
      // Redacting never touches the input, and pulling the redacted copy back restores every private value here.
      expect(canonical(s)).toBe(canonical(snap));
      expect(canonical(keepPrivate(red, s, keys).data)).toBe(canonical(s.data));
    }
  });
});

describe("deep scan: a row missing a column", () => {
  it("keeps that column for the other rows", async () => {
    const { snap } = await sample();
    const s = JSON.parse(JSON.stringify(snap)) as Snapshot;
    delete (s.data.employees[1] as Record<string, unknown>)["hourly_rate"];
    const target = await memoryDb();
    await replaceWithSnapshot(target, s);
    const rates = (await exportSnapshot(target)).data.employees.map((e) => [e["employee_code"], e["hourly_rate"]]);
    expect(rates).toEqual(snap.data.employees.map((e) => [e["employee_code"], e["employee_code"] === s.data.employees[1]!["employee_code"] ? 0 : e["hourly_rate"]]));
  });
});
