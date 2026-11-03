// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
// @ts-expect-error: the Electron main process's plain-JS module
import { DURABLE_START_PARAMS, DurableNodeFS, repairFileDates } from "../../../electron/durable-fs.mjs";

describe("the desktop database's file layer", () => {
  it("flushes to disk when Postgres commits, and the data reopens", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-durable-"));
    try {
      let syncs = 0;
      const db = new PGlite({ fs: new DurableNodeFS(dir, (fd: number) => { syncs++; fs.fsyncSync(fd); }), startParams: DURABLE_START_PARAMS });
      await db.waitReady;
      expect((await db.query<{ fsync: string }>("show fsync")).rows[0]!.fsync).toBe("on");
      expect((await db.query<{ wal_sync_method: string }>("show wal_sync_method")).rows[0]!.wal_sync_method).toBe("fsync");
      await db.exec("create table t (n int)");
      const before = syncs;
      await db.query("insert into t values (1)");
      // The commit flushed its log.
      expect(syncs).toBeGreaterThan(before);
      await db.close();

      const again = new PGlite({ fs: new DurableNodeFS(dir), startParams: DURABLE_START_PARAMS });
      expect((await again.query<{ n: number }>("select n from t")).rows).toEqual([{ n: 1 }]);
      await again.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops with an error instead of pretending a failed flush worked", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-durable-"));
    let fail = false;
    const db = new PGlite({ fs: new DurableNodeFS(dir, (fd: number) => { if (fail) throw new Error("disk gone"); fs.fsyncSync(fd); }), startParams: DURABLE_START_PARAMS });
    try {
      await db.waitReady;
      await db.exec("create table t (n int)");
      fail = true;
      await expect(db.query("insert into t values (1)")).rejects.toThrow();
    } finally {
      await db.close().catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dates a new database's files now, not in 1970", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-durable-"));
    const yearAgo = Date.now() - 365 * 86_400_000;
    try {
      const db = new PGlite({ fs: new DurableNodeFS(dir), startParams: DURABLE_START_PARAMS });
      await db.waitReady;
      await db.close();
      const dates = filesIn(dir).map((f) => fs.statSync(f).mtimeMs);
      expect(dates.length).toBeGreaterThan(500);
      expect(dates.filter((d) => d < yearAgo)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repairs files an older version dated 1970, and opens them as before", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-durable-"));
    try {
      const db = new PGlite({ fs: new DurableNodeFS(dir), startParams: DURABLE_START_PARAMS });
      await db.exec("create table t (n int); insert into t values (7)");
      await db.close();
      const old = new Date(1_793_668_000); // what PGlite wrote: January 1970
      for (const f of filesIn(dir)) fs.utimesSync(f, old, old);
      expect(repairFileDates(dir)).toBe(filesIn(dir).length);
      expect(repairFileDates(dir)).toBe(0);
      const again = new PGlite({ fs: new DurableNodeFS(dir), startParams: DURABLE_START_PARAMS });
      expect((await again.query<{ n: number }>("select n from t")).rows).toEqual([{ n: 7 }]);
      await again.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

const filesIn = (dir: string) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
