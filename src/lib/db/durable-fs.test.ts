// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
// @ts-expect-error: the Electron main process's plain-JS module
import { DURABLE_START_PARAMS, DurableNodeFS } from "../../../electron/durable-fs.mjs";

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
});
