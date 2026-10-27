// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite, types } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "./local";
import { LOCAL_MIGRATIONS, SCHEMA_VERSION } from "./schema";
import { countRows, describeDiff, diffCounts, exportSnapshot, replaceWithSnapshot, validateSnapshot, type Snapshot } from "./snapshot";
import { createLocalStore } from "./store";
import { deviceIdentity, maybeAutoBackup, pull, push, restoreSnapshot, setDeviceName, setPrivateFields, SyncConflictError, type CloudSync, type SyncDeps } from "./sync";
import { customKey, getPrivateFields, ID_NUMBERS, privateFieldsConfirmed, redactSnapshot, stripPrivate } from "./privacy";

const parsers = { [types.NUMERIC]: (v: string) => Number(v), [types.DATE]: (v: string) => v, [types.TIMESTAMPTZ]: (v: string) => v };
const migration = (name: string) => readFileSync(path.resolve(__dirname, "../../../drizzle/migrations", name), "utf8");

async function newLocal() {
  const db = new PGlite({ parsers });
  await migrate(db);
  return db;
}

// A stand-in for Supabase: the real cloud migrations, with auth.uid() read from a setting.
async function newCloud() {
  const db = new PGlite({ parsers });
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  `);
  for (const f of ["0000_migration.sql", "0001_employee_profile_fields.sql", "0002_custom_fields_overtime_adjustments.sql"]) await db.exec(migration(f));
  return db;
}
const applySyncMigration = async (cloud: PGlite) => {
  await cloud.exec(migration("0003_local_first_sync.sql"));
  await cloud.exec(migration("0004_shifts_manual_pay.sql"));
  await cloud.exec(migration("0005_pay_type.sql"));
  await cloud.exec(migration("0006_gender_nationality.sql"));
  await cloud.exec(migration("0007_employee_defaults.sql"));
  await cloud.exec(migration("0008_id_documents_category_sections.sql"));
  await cloud.exec(migration("0009_record_shift.sql"));
  await cloud.exec(migration("0010_push_device.sql"));
};

function cloudAs(db: PGlite, uid: string): CloudSync {
  const call = async (sql: string, params: unknown[] = []) => {
    await db.query("select set_config('test.uid', $1, false)", [uid]);
    try {
      return (await db.query<{ r: unknown }>(sql, params)).rows[0]!.r;
    } catch (e) {
      if ((e as Error).message.includes("SYNC_CONFLICT")) throw new SyncConflictError();
      throw e;
    }
  };
  return {
    status: async () => (await call("select public.sync_status() as r")) as never,
    pull: async () => (await call("select public.pull_snapshot() as r")) as never,
    push: async (s, v, d) => Number(await call("select public.push_snapshot($1::jsonb, $2, $3, $4) as r", [JSON.stringify(s), v, d.id, d.name])),
  };
}

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
/** A push made straight through the cloud API, not by one of the test computers. */
const ELSEWHERE = { id: "elsewhere", name: "Elsewhere" };

async function seed(db: PGlite, code: string) {
  const store = createLocalStore(async () => db);
  expect((await store.insert("employees", { employee_code: code, first_name: "Ada", last_name: "Lovelace", hourly_rate: 20 })).error).toBeNull();
  const emp = (await store.listEmployees()).find((e) => e.employee_code === code)!;
  expect((await store.insert("time_records", [
    { employee_id: emp.id, work_date: "2026-10-19", entry_mode: "clock", clock_in: "09:00", clock_out: "17:30", lunch_minutes: 30 },
    { employee_id: emp.id, work_date: "2026-10-20", entry_mode: "hours", hours: 6.5 },
  ])).error).toBeNull();
  return { store, emp };
}

function deps(db: PGlite, cloud: CloudSync, userId: string) {
  const backups: { reason: string; snapshot: Snapshot }[] = [];
  const d: SyncDeps = { db, cloud, userId, backup: async (reason, snapshot) => { backups.push({ reason, snapshot }); } };
  return { d, backups };
}

describe("local store", () => {
  it("computes hours with the same trigger as the cloud and cascades deletes", async () => {
    const db = await newLocal();
    const { store, emp } = await seed(db, "E1");
    const recs = await store.listRecords();
    expect(recs.map((r) => r.hours).sort()).toEqual([6.5, 8]);
    expect(recs[0]!.employees?.employee_code).toBe("E1");
    expect((await store.update("employees", emp.id, { hourly_rate: 25, custom_fields: { a: "b" } })).error).toBeNull();
    expect((await store.listEmployees())[0]).toMatchObject({ hourly_rate: 25, custom_fields: { a: "b" } });
    expect((await store.remove("employees", emp.id)).error).toBeNull();
    expect(await store.listRecords()).toEqual([]);
  });

  it("rolls back a whole bulk insert when one row is invalid", async () => {
    const db = await newLocal();
    const { store, emp } = await seed(db, "E1");
    const { error } = await store.insert("time_records", [
      { employee_id: emp.id, work_date: "2026-10-21", entry_mode: "hours", hours: 4 },
      { employee_id: emp.id, work_date: "2026-10-22", entry_mode: "clock", clock_in: "09:00" },
    ]);
    expect(error?.message).toMatch(/Clock in and clock out/);
    expect(await store.listRecords()).toHaveLength(2);
  });

  it("upserts employees by code and saves the single settings row", async () => {
    const db = await newLocal();
    const { store } = await seed(db, "E1");
    expect((await store.upsertEmployeesByCode([
      { employee_code: "E1", first_name: "Ada", last_name: "King", hourly_rate: 30 },
      { employee_code: "E2", first_name: "Alan", last_name: "Turing", hourly_rate: 22 },
    ])).error).toBeNull();
    const emps = await store.listEmployees();
    expect(emps.map((e) => [e.employee_code, e.last_name, e.hourly_rate])).toEqual([["E1", "King", 30], ["E2", "Turing", 22]]);
    await store.saveSettings({ ot_threshold: 38, ot_multiplier: 2, weekend_overtime: true, visible_columns: ["days"] });
    await store.saveSettings({ ot_threshold: 40, ot_multiplier: 1.5, weekend_overtime: true, visible_columns: ["employee_code"] });
    expect(await store.getSettings()).toMatchObject({ ot_threshold: 40, ot_multiplier: 1.5, visible_columns: ["employee_code"] });
  });
});

describe("shifts and manual pay (schema 2)", () => {
  it("starts with Day and Night shifts, and keeps manual pay on a record", async () => {
    const db = await newLocal();
    const store = createLocalStore(async () => db);
    expect((await store.listShifts()).map((s) => [s.name, s.multiplier])).toEqual([["Day", 1], ["Night", 1]]);
    const { emp } = await seed(db, "E1");
    const [rec] = await store.listRecords();
    expect((await store.update("time_records", rec!.id, { pay_override: 250 })).error).toBeNull();
    expect((await store.listRecords()).find((r) => r.id === rec!.id)?.pay_override).toBe(250);
    expect((await store.update("time_records", rec!.id, { pay_override: -1 })).error).not.toBeNull();
    const night = (await store.listShifts())[1]!;
    await store.update("employees", emp.id, { shift_id: night.id });
    await store.remove("shifts", night.id);
    expect((await store.listEmployees())[0]!.shift_id).toBeNull();
  });

  it("upgrades an existing device database in place, putting everyone on the Day shift", async () => {
    const db = new PGlite({ parsers });
    await db.exec(`set time zone 'UTC'; create table _migrations (version integer primary key, applied_at timestamptz not null default now())`);
    await db.exec(LOCAL_MIGRATIONS[0]!);
    await db.exec(`insert into _migrations (version) values (1);
      insert into employees (employee_code, first_name, last_name, hourly_rate) values ('OLD', 'Old', 'Timer', 21);
      insert into time_records (employee_id, work_date, entry_mode, hours) select id, '2026-10-24', 'hours', 6 from employees;`);
    await migrate(db);
    const store = createLocalStore(async () => db);
    const [day] = await store.listShifts();
    expect((await store.listEmployees()).map((e) => [e.employee_code, e.shift_id])).toEqual([["OLD", day!.id]]);
    expect((await store.listRecords()).map((r) => [r.hours, r.pay_override])).toEqual([[6, null]]);
    expect((await store.getSettings())).toBeNull();
  });

  it("still restores a backup made before shifts existed", async () => {
    const db = await newLocal();
    const { store } = await seed(db, "E1");
    const v1 = structuredClone(await exportSnapshot(db)) as unknown as { schema_version: number; data: Record<string, unknown> };
    v1.schema_version = 1;
    delete v1.data["shifts"];
    for (const e of v1.data["employees"] as Record<string, unknown>[]) delete e["shift_id"];
    for (const r of v1.data["time_records"] as Record<string, unknown>[]) delete r["pay_override"];
    for (const x of v1.data["payroll_settings"] as Record<string, unknown>[]) delete x["weekend_overtime"];
    const fresh = await newLocal();
    await replaceWithSnapshot(fresh, v1 as never);
    const restored = createLocalStore(async () => fresh);
    expect((await restored.listEmployees()).map((e) => e.employee_code)).toEqual(["E1"]);
    expect(await restored.listRecords()).toHaveLength(2);
    expect((await restored.listShifts()).map((s) => s.name)).toEqual(["Day", "Night"]);
    expect((await store.listEmployees()).length).toBe(1);
  });
});

describe("pay type (schema 3)", () => {
  it("defaults to hourly, accepts salary, and rejects anything else", async () => {
    const db = await newLocal();
    const { store, emp } = await seed(db, "E1");
    expect((await store.listEmployees())[0]!.pay_type).toBe("hourly");
    expect((await store.update("employees", emp.id, { pay_type: "salary" })).error).toBeNull();
    expect((await store.listEmployees())[0]!.pay_type).toBe("salary");
    expect((await store.update("employees", emp.id, { pay_type: "weekly" })).error).not.toBeNull();
  });

  it("upgrades a schema 2 device database and restores a schema 2 backup as hourly", async () => {
    const db = new PGlite({ parsers });
    await db.exec(`set time zone 'UTC'; create table _migrations (version integer primary key, applied_at timestamptz not null default now())`);
    await db.exec(LOCAL_MIGRATIONS[0]!);
    await db.exec(LOCAL_MIGRATIONS[1]!);
    await db.exec(`insert into _migrations (version) values (1), (2);
      insert into employees (employee_code, first_name, last_name, hourly_rate) values ('OLD', 'Old', 'Timer', 21);`);
    await migrate(db);
    const store = createLocalStore(async () => db);
    expect((await store.listEmployees()).map((e) => [e.employee_code, e.pay_type])).toEqual([["OLD", "hourly"]]);

    const v2 = structuredClone(await exportSnapshot(db)) as unknown as { schema_version: number; data: Record<string, Record<string, unknown>[]> };
    v2.schema_version = 2;
    for (const e of v2.data["employees"]!) delete e["pay_type"];
    const fresh = await newLocal();
    await replaceWithSnapshot(fresh, v2 as never);
    expect((await createLocalStore(async () => fresh).listEmployees()).map((e) => e.pay_type)).toEqual(["hourly"]);
  });
});

describe("gender and nationality (schema 4)", () => {
  it("stores any value, survives a backup round trip, and restores a schema 3 backup with them empty", async () => {
    const db = await newLocal();
    const { store, emp } = await seed(db, "E1");
    expect((await store.update("employees", emp.id, { gender: "Non-binary", nationality: "Filipino" })).error).toBeNull();
    const snap = await exportSnapshot(db);
    const copy = await newLocal();
    await replaceWithSnapshot(copy, snap);
    expect((await createLocalStore(async () => copy).listEmployees())[0]).toMatchObject({ gender: "Non-binary", nationality: "Filipino" });

    const v3 = structuredClone(snap) as unknown as { schema_version: number; data: Record<string, Record<string, unknown>[]> };
    v3.schema_version = 3;
    for (const e of v3.data["employees"]!) { delete e["gender"]; delete e["nationality"]; }
    const fresh = await newLocal();
    await replaceWithSnapshot(fresh, v3 as never);
    expect((await createLocalStore(async () => fresh).listEmployees())[0]).toMatchObject({ gender: null, nationality: null, employee_code: "E1" });
  });
});

describe("default profile (schema 5)", () => {
  it("saves without touching pay settings, survives a backup round trip, and restores a schema 4 backup empty", async () => {
    const db = await newLocal();
    const { store } = await seed(db, "E1");
    await store.saveSettings({ ot_threshold: 38, ot_multiplier: 2, weekend_overtime: false, visible_columns: ["days"] });
    expect((await store.saveEmployeeDefaults({ department: "Ops", hourly_rate: 18, custom_fields: { x: "1" } })).error).toBeNull();
    expect(await store.getSettings()).toMatchObject({ ot_threshold: 38, weekend_overtime: false, employee_defaults: { department: "Ops", hourly_rate: 18, custom_fields: { x: "1" } } });
    await store.saveSettings({ ot_threshold: 40, ot_multiplier: 1.5, weekend_overtime: true, visible_columns: ["days"] });
    expect((await store.getSettings())!.employee_defaults).toEqual({ department: "Ops", hourly_rate: 18, custom_fields: { x: "1" } });

    const snap = await exportSnapshot(db);
    const copy = await newLocal();
    await replaceWithSnapshot(copy, snap);
    expect((await createLocalStore(async () => copy).getSettings())!.employee_defaults).toEqual({ department: "Ops", hourly_rate: 18, custom_fields: { x: "1" } });

    const v4 = structuredClone(snap) as unknown as { schema_version: number; data: Record<string, Record<string, unknown>[]> };
    v4.schema_version = 4;
    for (const x of v4.data["payroll_settings"]!) delete x["employee_defaults"];
    const fresh = await newLocal();
    await replaceWithSnapshot(fresh, v4 as never);
    expect((await createLocalStore(async () => fresh).getSettings())!.employee_defaults).toEqual({});
  });
});

describe("ID documents and category sections (schema 6)", () => {
  it("stores them, and restores a schema 5 backup with them empty", async () => {
    const db = await newLocal();
    const { store, emp } = await seed(db, "E1");
    expect((await store.update("employees", emp.id, { passport_no: "P1", ssn: "123", residential_status: "Citizen" })).error).toBeNull();
    expect((await store.insert("employee_field_defs", { label: "Boot size", section: "Uniform" })).error).toBeNull();
    const snap = await exportSnapshot(db);
    expect(snap.data.employee_field_defs[0]).toMatchObject({ label: "Boot size", section: "Uniform" });

    const v5 = structuredClone(snap) as unknown as { schema_version: number; data: Record<string, Record<string, unknown>[]> };
    v5.schema_version = 5;
    for (const e of v5.data["employees"]!) { delete e["passport_no"]; delete e["ssn"]; delete e["residential_status"]; }
    for (const d of v5.data["employee_field_defs"]!) delete d["section"];
    const fresh = await newLocal();
    await replaceWithSnapshot(fresh, v5 as never);
    const s = createLocalStore(async () => fresh);
    expect((await s.listEmployees())[0]).toMatchObject({ passport_no: null, ssn: null, residential_status: null });
    expect((await s.listFieldDefs())[0]).toMatchObject({ label: "Boot size", section: null });
  });
});

describe("a record's own shift (schema 7)", () => {
  it("stores it, falls back to the employee's shift when that shift is deleted, and restores a schema 6 backup empty", async () => {
    const db = await newLocal();
    const { store, emp } = await seed(db, "E1");
    const night = (await store.listShifts()).find((s) => s.name === "Night")!;
    const rec = (await store.listRecordsMatching({}))[0]!;
    expect((await store.update("time_records", rec.id, { shift_id: night.id })).error).toBeNull();
    const snap = await exportSnapshot(db);
    expect(snap.data.time_records.find((r) => r["id"] === rec.id)!["shift_id"]).toBe(night.id);

    const v6 = structuredClone(snap) as unknown as { schema_version: number; data: Record<string, Record<string, unknown>[]> };
    v6.schema_version = 6;
    for (const r of v6.data["time_records"]!) delete r["shift_id"];
    const fresh = await newLocal();
    await replaceWithSnapshot(fresh, v6 as never);
    expect((await createLocalStore(async () => fresh).listRecordsMatching({})).every((r) => r.shift_id === null)).toBe(true);

    expect((await store.remove("shifts", night.id)).error).toBeNull();
    expect((await store.listRecordsMatching({ employeeIds: [emp.id] })).every((r) => r.shift_id === null)).toBe(true);
  });
});

describe("record pages", () => {
  it("pages through records newest first, with an exact total, filtered by date, type and employee", async () => {
    const db = await newLocal();
    const store = createLocalStore(async () => db);
    await store.upsertEmployeesByCode([{ employee_code: "A", first_name: "A", last_name: "One" }, { employee_code: "B", first_name: "B", last_name: "Two" }]);
    const [a, b] = await store.listEmployees();
    const days = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);
    await store.insert("time_records", days.map((d, i) => ({ employee_id: i % 2 ? b!.id : a!.id, work_date: d, entry_mode: "hours" as const, hours: 8 })));
    await store.insert("time_records", { employee_id: a!.id, work_date: "2026-09-15", entry_mode: "clock", clock_in: "09:00", clock_out: "17:00" });

    const first = await store.listRecordsPage({ mode: "hours" }, 0, 10);
    expect(first.total).toBe(30);
    expect(first.rows.map((r) => r.work_date)).toEqual(days.slice(20).reverse());
    expect((await store.listRecordsPage({ mode: "hours" }, 10, 10)).rows[0]!.work_date).toBe("2026-09-20");
    expect((await store.listRecordsPage({ mode: "clock" }, 0, 10)).total).toBe(1);
    expect((await store.listRecordsPage({ mode: "hours", from: "2026-09-10", to: "2026-09-19" }, 0, 50)).total).toBe(10);
    expect((await store.listRecordsPage({ mode: "hours", employeeIds: [b!.id] }, 0, 50)).total).toBe(15);
    expect((await store.listRecordsPage({ employeeIds: [] }, 0, 50)).total).toBe(0);
    expect(await store.listRecordsMatching({ mode: "hours", employeeIds: [a!.id] })).toHaveLength(15);
  });
});

describe("bulk employee changes", () => {
  it("edits several employees at once, each with its own patch", async () => {
    const db = await newLocal();
    const store = createLocalStore(async () => db);
    await store.upsertEmployeesByCode([
      { employee_code: "A", first_name: "A", last_name: "One", hourly_rate: 20 },
      { employee_code: "B", first_name: "B", last_name: "Two", hourly_rate: 30 },
    ]);
    const [a, b] = await store.listEmployees();
    const r = await store.updateMany("employees", [
      { id: a!.id, patch: { department: "Ops", hourly_rate: 21 } },
      { id: b!.id, patch: { department: "Ops", hourly_rate: 31.5 } },
    ]);
    expect(r).toEqual({ error: null, updated: 2 });
    expect((await store.listEmployees()).map((e) => [e.department, e.hourly_rate])).toEqual([["Ops", 21], ["Ops", 31.5]]);
  });

  it("changes nobody if one of the edits is invalid", async () => {
    const db = await newLocal();
    const store = createLocalStore(async () => db);
    await store.upsertEmployeesByCode([
      { employee_code: "A", first_name: "A", last_name: "One" },
      { employee_code: "B", first_name: "B", last_name: "Two" },
    ]);
    const [a, b] = await store.listEmployees();
    const r = await store.updateMany("employees", [
      { id: a!.id, patch: { department: "Ops" } },
      { id: b!.id, patch: { employee_code: "A" } },
    ]);
    expect(r.error).not.toBeNull();
    expect(r.updated).toBe(0);
    expect((await store.listEmployees()).map((e) => e.department)).toEqual([null, null]);
  });

  it("deletes several employees together with their records", async () => {
    const db = await newLocal();
    const { store } = await seed(db, "E1");
    await seed(db, "E2");
    await seed(db, "E3");
    const ids = (await store.listEmployees()).filter((e) => e.employee_code !== "E2").map((e) => e.id);
    expect((await store.removeMany("employees", ids)).error).toBeNull();
    expect((await store.listEmployees()).map((e) => e.employee_code)).toEqual(["E2"]);
    expect(await store.listRecords()).toHaveLength(2);
  });
});

describe("snapshots", () => {
  it("round-trips every table exactly", async () => {
    const a = await newLocal();
    const { store } = await seed(a, "E1");
    await store.saveSettings({ ot_threshold: 38, ot_multiplier: 2, weekend_overtime: true, visible_columns: ["days"] });
    await store.insert("employee_field_defs", { label: "Shirt size" });
    const snap = await exportSnapshot(a);
    const b = await newLocal();
    await replaceWithSnapshot(b, JSON.parse(JSON.stringify(snap)));
    expect((await exportSnapshot(b)).data).toEqual(snap.data);
  });

  it("leaves existing data untouched when a restore fails part-way", async () => {
    const db = await newLocal();
    await seed(db, "E1");
    const before = await exportSnapshot(db);
    const bad = structuredClone(before);
    bad.data.time_records.push({ ...bad.data.time_records[0]!, id: crypto.randomUUID(), employee_id: crypto.randomUUID() });
    await expect(replaceWithSnapshot(db, bad)).rejects.toThrow();
    expect((await exportSnapshot(db)).data).toEqual(before.data);
  });

  it("rejects files that aren't complete backups", () => {
    expect(() => validateSnapshot({})).toThrow(/backup header/);
    expect(() => validateSnapshot({ format: "meridian-payroll-backup", schema_version: 99, data: {} })).toThrow(/newer/);
    expect(() => validateSnapshot({ format: "meridian-payroll-backup", schema_version: 1, data: { employees: [] } })).toThrow(/missing/);
  });
});

describe("cloud migration", () => {
  it("keeps existing cloud data, gives it to the admin, and saves a pre-migration copy", async () => {
    const cloud = await newCloud();
    await cloud.exec(`insert into auth.users values ('${A}', 'admin@example.com'), ('${B}', 'emp@example.com')`);
    await cloud.exec(`
      insert into public.employees (id, employee_code, first_name, last_name, hourly_rate) values ('11111111-1111-4111-8111-111111111111', 'OLD1', 'Grace', 'Hopper', 40);
      insert into public.time_records (employee_id, work_date, entry_mode, hours) values ('11111111-1111-4111-8111-111111111111', '2026-10-01', 'hours', 7);
      insert into public.payroll_settings (id, ot_threshold) values (true, 44);
    `);
    await applySyncMigration(cloud);
    const remote = await cloudAs(cloud, A).pull();
    expect(countRows(remote.snapshot)).toMatchObject({ employees: 1, time_records: 1, payroll_settings: 1 });
    expect((await cloudAs(cloud, B).pull()).snapshot.data.employees).toEqual([]);
    const { rows } = await cloud.query<{ reason: string }>("select reason from public.cloud_backups");
    expect(rows).toEqual([{ reason: "before-local-first-migration" }]);
    // 0004: the admin's account gets Day/Night and existing employees go on Day.
    expect(remote.snapshot.schema_version).toBe(7);
    expect(remote.snapshot.data.employees[0]!["pay_type"]).toBe("hourly");
    expect(remote.snapshot.data.shifts.map((x) => x["name"])).toEqual(["Day", "Night"]);
    const day = remote.snapshot.data.shifts.find((x) => x["name"] === "Day")!;
    expect(remote.snapshot.data.employees[0]!["shift_id"]).toBe(day["id"]);
  });

  it("aborts without changing anything if old data has no admin to belong to", async () => {
    const cloud = await newCloud();
    await cloud.exec(`insert into public.employees (employee_code, first_name, last_name) values ('X', 'No', 'Owner')`);
    await expect(applySyncMigration(cloud)).rejects.toThrow(/no admin account/);
    const { rows } = await cloud.query("select column_name from information_schema.columns where table_name = 'employees' and column_name = 'owner_id'");
    expect(rows).toEqual([]);
  });
});

describe("push and pull", () => {
  let cloud: PGlite;
  beforeEach(async () => {
    cloud = await newCloud();
    await applySyncMigration(cloud);
  });

  it("moves a database from one device to another through the account", async () => {
    const laptop = await newLocal();
    const { store } = await seed(laptop, "E1");
    const night = (await store.listShifts())[1]!;
    await store.update("shifts", night.id, { multiplier: 1.25 });
    await store.update("employees", (await store.listEmployees())[0]!.id, { shift_id: night.id });
    await store.update("time_records", (await store.listRecords())[0]!.id, { pay_override: 199.99 });
    expect((await push(deps(laptop, cloudAs(cloud, A), A).d)).kind).toBe("done");

    const desktop = await newLocal();
    expect((await pull(deps(desktop, cloudAs(cloud, A), A).d)).kind).toBe("done");
    expect((await exportSnapshot(desktop)).data).toEqual((await exportSnapshot(laptop)).data);
  });

  it("asks before pulling over unpushed local changes, and backs them up first", async () => {
    const laptop = await newLocal();
    await seed(laptop, "E1");
    await push(deps(laptop, cloudAs(cloud, A), A).d);

    const desktop = await newLocal();
    await seed(desktop, "D1");
    const { d, backups } = deps(desktop, cloudAs(cloud, A), A);
    const first = await pull(d);
    expect(first.kind).toBe("confirm");
    expect((await createLocalStore(async () => desktop).listEmployees())[0]!.employee_code).toBe("D1");

    expect((await pull(d, { confirmed: true })).kind).toBe("done");
    expect(backups.map((b) => b.reason)).toEqual(["before-pull"]);
    expect(backups[0]!.snapshot.data.employees[0]!["employee_code"]).toBe("D1");
  });

  it("asks before pushing over cloud changes made elsewhere, and backs up the cloud copy", async () => {
    const laptop = await newLocal();
    await seed(laptop, "E1");
    await push(deps(laptop, cloudAs(cloud, A), A).d);

    const desktop = await newLocal();
    await pull(deps(desktop, cloudAs(cloud, A), A).d);
    await createLocalStore(async () => desktop).upsertEmployeesByCode([{ employee_code: "D2", first_name: "New", last_name: "Hire" }]);
    await push(deps(desktop, cloudAs(cloud, A), A).d);

    const { d, backups } = deps(laptop, cloudAs(cloud, A), A);
    expect((await push(d)).kind).toBe("confirm");
    expect(countRows((await cloudAs(cloud, A).pull()).snapshot).employees).toBe(2);

    expect((await push(d, { confirmed: true })).kind).toBe("done");
    expect(backups[0]!.reason).toBe("before-push-cloud-copy");
    expect(countRows(backups[0]!.snapshot).employees).toBe(2);
    const { rows } = await cloud.query<{ n: number }>("select count(*)::int as n from public.cloud_backups where reason = 'before-push'");
    expect(rows[0]!.n).toBe(2);
  });

  it("refuses a push when the cloud moved after it was checked", async () => {
    const laptop = await newLocal();
    await seed(laptop, "E1");
    const api = cloudAs(cloud, A);
    await push(deps(laptop, api, A).d);
    const stale = (await api.status()).version;
    await api.push(await exportSnapshot(laptop), stale, ELSEWHERE);
    await expect(api.push(await exportSnapshot(laptop), stale, ELSEWHERE)).rejects.toBeInstanceOf(SyncConflictError);
  });

  it("rolls back a push that fails part-way, keeping the previous cloud copy", async () => {
    const laptop = await newLocal();
    await seed(laptop, "E1");
    const api = cloudAs(cloud, A);
    await push(deps(laptop, api, A).d);
    const before = (await api.pull()).snapshot.data;
    const bad = await exportSnapshot(laptop);
    bad.data.time_records.push({ ...bad.data.time_records[0]!, id: crypto.randomUUID(), employee_id: crypto.randomUUID() });
    await expect(api.push(bad, (await api.status()).version, ELSEWHERE)).rejects.toThrow();
    expect((await api.pull()).snapshot.data).toEqual(before);
  });

  it("keeps each account's data separate, even when both receive the same rows", async () => {
    const laptop = await newLocal();
    await seed(laptop, "E1");
    await push(deps(laptop, cloudAs(cloud, A), A).d);
    expect((await push(deps(laptop, cloudAs(cloud, B), B).d, { confirmed: true })).kind).toBe("done");
    await cloudAs(cloud, B).push({ ...(await exportSnapshot(await newLocal())) }, (await cloudAs(cloud, B).status()).version, ELSEWHERE);
    expect(countRows((await cloudAs(cloud, A).pull()).snapshot).employees).toBe(1);
    expect(countRows((await cloudAs(cloud, B).pull()).snapshot).employees).toBe(0);
  });

  it("treats cloud edits (cloud mode) as changes the next push must confirm", async () => {
    const laptop = await newLocal();
    await seed(laptop, "E1");
    await push(deps(laptop, cloudAs(cloud, A), A).d);
    await cloud.query("select set_config('test.uid', $1, false)", [A]);
    await cloud.query("insert into public.employees (employee_code, first_name, last_name) values ('WEB', 'Edited', 'Online')");
    expect((await push(deps(laptop, cloudAs(cloud, A), A).d)).kind).toBe("confirm");
  });
});

describe("which computer pushed", () => {
  let cloud: PGlite;
  beforeEach(async () => {
    cloud = await newCloud();
    await cloud.exec(`insert into auth.users values ('${A}', 'admin@example.com')`);
    await applySyncMigration(cloud);
  });
  const named = (db: PGlite, name: string) => ({ ...deps(db, cloudAs(cloud, A), A).d, defaultDeviceName: name });

  it("finds no differences between a computer and the copy it just pushed", async () => {
    const laptop = await newLocal();
    await seed(laptop, "E1");
    await setPrivateFields(laptop, ["ssn", "address_line1"]);
    await push(named(laptop, "Laptop"));
    const here = redactSnapshot(await exportSnapshot(laptop), await getPrivateFields(laptop));
    const there = (await cloudAs(cloud, A).pull()).snapshot;
    expect(describeDiff(diffCounts(here, there))).toBeNull();
  });

  it("names the other computer and counts what a push would overwrite", async () => {
    const laptop = await newLocal();
    await seed(laptop, "E1");
    await push(named(laptop, "Laptop"));
    const office = await newLocal();
    await pull(named(office, "Office PC"));

    // The office adds an employee and pushes; the laptop, not knowing, changes a record and pushes too.
    await seed(office, "E2");
    expect((await push(named(office, "Office PC"))).kind).toBe("done");
    expect((await cloudAs(cloud, A).status()).pushed_by_name).toBe("Office PC");
    const laptopStore = createLocalStore(async () => laptop);
    await laptopStore.update("time_records", (await laptopStore.listRecords())[0]!.id, { note: "changed on the laptop" });

    const r = await push(named(laptop, "Laptop"));
    if (r.kind !== "confirm") throw new Error("expected a confirmation");
    expect(r.otherDevice?.name).toBe("Office PC");
    expect(r.editedInCloud).toBe(false);
    // E2 and its two records exist only in the cloud; the laptop's edited record differs.
    expect(r.differ).toMatchObject({ employees: 1, time_records: 3 });
    expect(describeDiff(r.differ)).toBe("1 employee and 3 time records");
  });

  it("tells a direct cloud edit apart from another computer's push", async () => {
    const laptop = await newLocal();
    await seed(laptop, "E1");
    await push(named(laptop, "Laptop"));
    await cloud.query("select set_config('test.uid', $1, false)", [A]);
    await cloud.query("update public.employees set hourly_rate = 99 where owner_id = $1", [A]);
    await seed(laptop, "E9");
    const r = await push(named(laptop, "Laptop"));
    if (r.kind !== "confirm") throw new Error("expected a confirmation");
    expect(r.otherDevice).toBeNull();
    expect(r.editedInCloud).toBe(true);
  });

  it("keeps a computer's name and id on this computer, and a blank name goes back to the default", async () => {
    const db = await newLocal();
    const first = await deviceIdentity(db, "DESKTOP-1");
    expect(first.name).toBe("DESKTOP-1");
    await setDeviceName(db, "  Front office  ");
    expect(await deviceIdentity(db, "DESKTOP-1")).toEqual({ id: first.id, name: "Front office" });
    await setDeviceName(db, " ");
    expect((await deviceIdentity(db, "DESKTOP-1")).name).toBe("DESKTOP-1");
  });
});

describe("private fields", () => {
  let cloud: PGlite;
  beforeEach(async () => {
    cloud = await newCloud();
    await applySyncMigration(cloud);
  });

  async function privateLaptop() {
    const laptop = await newLocal();
    const { store, emp } = await seed(laptop, "E1");
    await store.update("employees", emp.id, {
      ssn: "123-45-6789", email: "ada@example.com", department: "Ops", custom_fields: { secret: "S", shirt: "M" },
    });
    await store.saveEmployeeDefaults({ nationality: "UK", department: "Ops", custom_fields: { secret: "default S" } });
    return { laptop, store, emp };
  }
  const cloudEmployee = async () => (await cloudAs(cloud, A).pull()).snapshot.data.employees[0]!;

  it("keeps every personal detail and every category on the device by default; only work details sync", async () => {
    const { laptop, store, emp } = await privateLaptop();
    // privateLaptop's custom values have no category (as after deleting one): they're private too.
    expect(await getPrivateFields(laptop)).toEqual(expect.arrayContaining([customKey("secret"), customKey("shirt")]));
    await store.insert("employee_field_defs", { label: "Bank account" });
    const bank = (await store.listFieldDefs())[0]!;
    await store.update("employees", emp.id, { custom_fields: { [bank.id]: "GB00 1234" } });
    const keys = await getPrivateFields(laptop);
    expect(keys).toEqual(expect.arrayContaining(["ssn", "passport_no", "date_of_birth", "email", "phone", "address_line1", "emergency_contact_name", "notes", customKey(bank.id)]));
    expect(keys).not.toEqual(expect.arrayContaining(["department"]));
    expect(keys.filter((k) => ["department", "job_title", "hire_date"].includes(k))).toEqual([]);
    await push(deps(laptop, cloudAs(cloud, A), A).d);
    const sent = await cloudEmployee();
    expect(sent).toMatchObject({ ssn: null, email: null, department: "Ops" });
    expect(sent["custom_fields"]).toEqual({});
  });

  it("makes a category added after choosing private until it's chosen to sync", async () => {
    const { laptop, store } = await privateLaptop();
    await setPrivateFields(laptop, ["ssn"]);
    expect(await getPrivateFields(laptop)).toEqual(["ssn"]);
    await store.insert("employee_field_defs", { label: "Medical notes" });
    const medical = (await store.listFieldDefs())[0]!;
    expect(await getPrivateFields(laptop)).toEqual(["ssn", customKey(medical.id)]);
  });

  it("converts a choice saved by an older version exactly, and later categories start private", async () => {
    const { laptop, store } = await privateLaptop();
    await store.insert("employee_field_defs", { label: "Shirt size" });
    const shirt = (await store.listFieldDefs())[0]!;
    // Older versions stored the private list itself, so a category they didn't list was synced.
    await laptop.query("insert into _meta values ('private_fields', $1)", [JSON.stringify(["ssn", "email"])]);
    expect(await getPrivateFields(laptop)).toEqual(["ssn", "email"]);
    await store.insert("employee_field_defs", { label: "Medical notes" });
    const medical = (await store.listFieldDefs()).find((d) => d.label === "Medical notes")!;
    const keys = await getPrivateFields(laptop);
    expect(keys).toContain(customKey(medical.id));
    expect(keys).not.toContain(customKey(shirt.id));
  });

  it("never makes a field less private by restoring a backup, even onto a fresh install", async () => {
    const { laptop } = await privateLaptop();
    await setPrivateFields(laptop, [...ID_NUMBERS, "job_title"]);
    const backup = await exportSnapshot(laptop);
    expect(backup.private_fields).toEqual(expect.arrayContaining(["job_title", "ssn"]));

    const fresh = await newLocal();
    await setPrivateFields(fresh, ["email"]);
    await restoreSnapshot(fresh, backup, async () => {});
    expect(await getPrivateFields(fresh)).toEqual(expect.arrayContaining(["email", "job_title", "ssn", "passport_no"]));

    // A backup from before private fields were recorded: the defaults apply, every category private.
    const old = structuredClone(backup);
    delete old.private_fields;
    const other = await newLocal();
    await setPrivateFields(other, []);
    await restoreSnapshot(other, old, async () => {});
    expect(await getPrivateFields(other)).toEqual(expect.arrayContaining(["ssn", "email", "date_of_birth"]));
    expect(await getPrivateFields(other)).not.toContain("department");
  });

  it("asks before the first push until the private fields are confirmed or saved", async () => {
    const db = await newLocal();
    expect(await privateFieldsConfirmed(db)).toBe(false);
    await setPrivateFields(db, ID_NUMBERS);
    expect(await privateFieldsConfirmed(db)).toBe(true);
    // Restoring a backup doesn't count as looking at them on this device.
    const fresh = await newLocal();
    await restoreSnapshot(fresh, await exportSnapshot(db), async () => {});
    expect(await privateFieldsConfirmed(fresh)).toBe(false);
  });

  it("never pushes chosen fields, and a pull keeps this device's values for them", async () => {
    const { laptop, store, emp } = await privateLaptop();
    await setPrivateFields(laptop, ["ssn", "email", "nationality", customKey("secret")]);
    await push(deps(laptop, cloudAs(cloud, A), A).d);
    const remote = await cloudAs(cloud, A).pull();
    expect(remote.snapshot.data.employees[0]).toMatchObject({ ssn: null, email: null, department: "Ops", custom_fields: { shirt: "M" } });
    expect(remote.snapshot.data.payroll_settings[0]!["employee_defaults"]).toEqual({ department: "Ops", custom_fields: {} });

    // Someone edits the cloud copy; pulling brings that in without losing the private values.
    await cloud.query("select set_config('test.uid', $1, false)", [A]);
    await cloud.query("update public.employees set department = 'Sales'");
    expect((await pull(deps(laptop, cloudAs(cloud, A), A).d)).kind).toBe("done");
    expect((await store.listEmployees()).find((e) => e.id === emp.id)).toMatchObject({
      department: "Sales", ssn: "123-45-6789", email: "ada@example.com", custom_fields: { secret: "S", shirt: "M" },
    });
    expect((await store.getSettings())!.employee_defaults).toEqual({ nationality: "UK", department: "Ops", custom_fields: { secret: "default S" } });

    // Another device only ever sees the blanks.
    const desktop = await newLocal();
    await pull(deps(desktop, cloudAs(cloud, A), A).d);
    expect((await createLocalStore(async () => desktop).listEmployees())[0]).toMatchObject({ ssn: null, email: null, custom_fields: { shirt: "M" } });
  });

  it("marks the device as needing a push when a field becomes private, so the cloud copy gets cleaned", async () => {
    const { laptop } = await privateLaptop();
    await setPrivateFields(laptop, ID_NUMBERS);
    await push(deps(laptop, cloudAs(cloud, A), A).d);
    expect((await cloudEmployee())["email"]).toBe("ada@example.com");
    await setPrivateFields(laptop, ["email"]);
    expect((await pull(deps(laptop, cloudAs(cloud, A), A).d)).kind).toBe("confirm");
    await push(deps(laptop, cloudAs(cloud, A), A).d);
    expect((await cloudEmployee())["email"]).toBeNull();
  });

  it("keeps private values when restoring a cloud backup", async () => {
    const { laptop, store } = await privateLaptop();
    await push(deps(laptop, cloudAs(cloud, A), A).d);
    const saved: string[] = [];
    await restoreSnapshot(laptop, (await cloudAs(cloud, A).pull()).snapshot, async (r) => { saved.push(r); }, { keepPrivateFields: true });
    expect(saved).toEqual(["before-restore"]);
    expect((await store.listEmployees())[0]!.ssn).toBe("123-45-6789");
  });

  it("strips private values from rows and patches", () => {
    const keys = ["ssn", "phone", customKey("secret")];
    expect(stripPrivate({ ssn: "1", city: "X", custom_fields: { secret: "s", other: "o" } }, keys)).toEqual({ ssn: null, city: "X", custom_fields: { other: "o" } });
    expect(stripPrivate({ phone: "5", department: "D" }, keys, "delete")).toEqual({ department: "D" });
    expect(stripPrivate({ department: "D" }, [])).toEqual({ department: "D" });
  });
});

describe("restore and automatic backups", () => {
  it("backs up current data before restoring a file", async () => {
    const db = await newLocal();
    await seed(db, "E1");
    const saved: string[] = [];
    await restoreSnapshot(db, await exportSnapshot(await newLocal()), async (reason) => { saved.push(reason); });
    expect(saved).toEqual(["before-restore"]);
    expect(await createLocalStore(async () => db).listEmployees()).toEqual([]);
  });

  it("takes an automatic backup only when data changed and 30 minutes passed", async () => {
    const db = await newLocal();
    const saved: string[] = [];
    const backup = async (reason: string) => { saved.push(reason); };
    expect(await maybeAutoBackup(db, backup)).toBe(false);
    await seed(db, "E1");
    const t0 = Date.parse("2026-10-24T00:00:00Z");
    expect(await maybeAutoBackup(db, backup, t0)).toBe(true);
    await seed(db, "E2");
    expect(await maybeAutoBackup(db, backup, t0 + 10 * 60_000)).toBe(false);
    expect(await maybeAutoBackup(db, backup, t0 + 31 * 60_000)).toBe(true);
    // Nothing changed since: no backup, however long it's been.
    expect(await maybeAutoBackup(db, backup, t0 + 24 * 3_600_000)).toBe(false);
    // Closing the app backs up any change right away.
    await seed(db, "E3");
    expect(await maybeAutoBackup(db, backup, t0 + 24 * 3_600_000 + 1000, 0)).toBe(true);
    expect(saved).toEqual(["automatic", "automatic", "automatic"]);
  });

  it("backs up an existing database before updating it, stamped with its old version", async () => {
    const db = new PGlite({ parsers });
    await db.exec(`set time zone 'UTC'; create table _migrations (version integer primary key, applied_at timestamptz not null default now())`);
    await db.exec(LOCAL_MIGRATIONS[0]!);
    await db.exec(`insert into _migrations (version) values (1);
      insert into employees (employee_code, first_name, last_name, hourly_rate) values ('OLD', 'Old', 'Timer', 21);`);
    const saved: Snapshot[] = [];
    await migrate(db, async (s) => { saved.push(s); });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.schema_version).toBe(1);
    expect(saved[0]!.data.employees.map((e) => e["employee_code"])).toEqual(["OLD"]);
    expect("shifts" in saved[0]!.data).toBe(false);
    // And that backup still restores into the current version.
    const fresh = await newLocal();
    await replaceWithSnapshot(fresh, validateSnapshot(structuredClone(saved[0])));
    expect((await createLocalStore(async () => fresh).listEmployees()).map((e) => e.employee_code)).toEqual(["OLD"]);
    // Already up to date, or brand new: no backup.
    await migrate(db, async (s) => { saved.push(s); });
    await migrate(new PGlite({ parsers }), async (s) => { saved.push(s); });
    expect(saved).toHaveLength(1);
  });

  it("keeps the schema version equal to the number of local migrations (pre-update backups rely on it)", () => {
    expect(LOCAL_MIGRATIONS.length).toBe(SCHEMA_VERSION);
  });
});
