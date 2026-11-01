// @vitest-environment node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error: the Electron main process's plain-JS modules
import { DURABLE_START_PARAMS, DurableNodeFS } from "../../../electron/durable-fs.mjs";
import {
  EncryptedFiles, encryptFolder, fileCipher, folderKeyMatches, folderState, HEADER, SecureNodeFS, UNIT, verifyFolder, xtsCipher,
  // @ts-expect-error: the Electron main process's plain-JS modules
} from "../../../electron/secure-fs.mjs";

const dirs: string[] = [];
const tempDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-secure-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Every file under a folder, read as it is on disk. */
function rawFiles(dir: string): Buffer[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => fs.readFileSync(path.join(e.parentPath, e.name)));
}

const SECRET = "SSN-987-65-4321-Zelda-Quixote";
const open = (dir: string, key: Buffer) => new PGlite({ fs: new SecureNodeFS(dir, key), startParams: DURABLE_START_PARAMS });

describe("XTS built from AES-ECB", () => {
  it("matches OpenSSL's aes-256-xts, whole units and shorter ones, unit by unit", () => {
    const key = crypto.randomBytes(64);
    const xts = xtsCipher(key);
    const fileId = crypto.randomBytes(8);
    for (const length of [16, 17, 31, 32, 100, 4095, 4096, 4096 + 16, 4096 + 33, 3 * 4096, 3 * 4096 + 1000]) {
      const plain = crypto.randomBytes(length);
      const first = 7;
      const ours = xts.crypt(fileId, first, Buffer.from(plain), false);
      for (let u = 0; u * UNIT < length; u++) {
        const iv = Buffer.alloc(16);
        fileId.copy(iv);
        iv.writeBigUInt64LE(BigInt(first + u), 8);
        const c = crypto.createCipheriv("aes-256-xts", key, iv);
        const theirs = Buffer.concat([c.update(plain.subarray(u * UNIT, (u + 1) * UNIT)), c.final()]);
        expect(Buffer.from(ours.subarray(u * UNIT, (u + 1) * UNIT)).equals(theirs), `length ${length}, unit ${u}`).toBe(true);
      }
      expect(Buffer.from(xts.crypt(fileId, first, ours, true)).equals(plain)).toBe(true);
    }
  });

  it("encrypts the same data differently in another unit or file, and tiny tails too", () => {
    const cipher = fileCipher(crypto.randomBytes(32));
    const a = crypto.randomBytes(8), b = crypto.randomBytes(8);
    const data = Buffer.alloc(32, 1);
    const one = Buffer.from(cipher.crypt(a, 0, Buffer.from(data), false));
    expect(one.equals(Buffer.from(cipher.crypt(a, 1, Buffer.from(data), false)))).toBe(false);
    expect(one.equals(Buffer.from(cipher.crypt(b, 0, Buffer.from(data), false)))).toBe(false);
    expect(one.subarray(0, 16).equals(one.subarray(16))).toBe(false);
    const tiny = Buffer.from("16\n");
    const sealed = Buffer.from(cipher.crypt(a, 0, Buffer.from(tiny), false));
    expect(sealed.equals(tiny)).toBe(false);
    expect(Buffer.from(cipher.crypt(a, 0, sealed, true)).equals(tiny)).toBe(true);
  });
});

describe("encrypted files", () => {
  it("read back exactly like a plain file through random writes, reads and truncations", () => {
    const dir = tempDir();
    const files = new EncryptedFiles(fileCipher(crypto.randomBytes(32)), () => {});
    const fd = fs.openSync(path.join(dir, "f"), "w+");
    let mirror = Buffer.alloc(0);
    // A fixed seed, so a failure can be replayed.
    let seed = 12345;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    const sizes = [1, 3, 15, 16, 17, 100, 4095, 4096, 4097, 8192, 9000, 20000];
    try {
      for (let step = 0; step < 400; step++) {
        const kind = rand(10);
        if (kind < 6) {
          const len = sizes[rand(sizes.length)]!;
          // Mostly inside or just past the end; sometimes far past it, leaving a gap.
          const pos = rand(4) === 0 ? mirror.length + rand(10000) : rand(mirror.length + 1);
          const data = crypto.randomBytes(len);
          files.write(fd, data, pos);
          const next = Buffer.alloc(Math.max(mirror.length, pos + len));
          mirror.copy(next);
          data.copy(next, pos);
          mirror = next;
        } else if (kind < 8) {
          const len = rand(mirror.length + 9000);
          files.truncate(fd, len);
          const next = Buffer.alloc(len);
          mirror.copy(next, 0, 0, Math.min(len, mirror.length));
          mirror = next;
        } else {
          const pos = rand(mirror.length + 10);
          const len = 1 + rand(9000);
          const target = Buffer.alloc(len);
          const n = files.read(fd, target, pos);
          expect(n).toBe(Math.max(0, Math.min(len, mirror.length - pos)));
          expect(target.subarray(0, n).equals(mirror.subarray(pos, pos + n))).toBe(true);
        }
        expect(files.size(fd)).toBe(mirror.length);
        if (step % 25 === 0) {
          const all = Buffer.alloc(mirror.length);
          files.read(fd, all, 0);
          expect(all.equals(mirror), `step ${step}`).toBe(true);
        }
      }
      // A second descriptor (another reader) sees the same, and the disk holds the header plus the data's size.
      const again = fs.openSync(path.join(dir, "f"), "r");
      const other = new EncryptedFiles(files.cipher);
      const all = Buffer.alloc(mirror.length);
      other.read(again, all, 0);
      fs.closeSync(again);
      expect(all.equals(mirror)).toBe(true);
      expect(fs.fstatSync(fd).size).toBe(HEADER + mirror.length);
    } finally {
      fs.closeSync(fd);
    }
  });

  it("refuses a file encrypted with another key, or one that isn't encrypted", () => {
    const dir = tempDir();
    const file = path.join(dir, "f");
    const fd = fs.openSync(file, "w+");
    new EncryptedFiles(fileCipher(crypto.randomBytes(32))).write(fd, Buffer.from("hello there, a secret"), 0);
    expect(() => new EncryptedFiles(fileCipher(crypto.randomBytes(32))).read(fd, Buffer.alloc(5), 0)).toThrow(/another key/);
    fs.closeSync(fd);
    fs.writeFileSync(file, Buffer.alloc(HEADER + 10, 65));
    const plain = fs.openSync(file, "r");
    expect(() => new EncryptedFiles(fileCipher(crypto.randomBytes(32))).read(plain, Buffer.alloc(5), 0)).toThrow(/Not an encrypted/);
    fs.closeSync(plain);
  });
});

describe("the encrypted desktop database", () => {
  it("keeps its data unreadable on disk, reopens with the key and refuses another", async () => {
    const dir = tempDir();
    const key = crypto.randomBytes(32);
    const db = open(dir, key);
    await db.exec("create table people (name text, ssn text)");
    await db.query("insert into people values ($1, $2)", ["Zelda", SECRET]);
    // Enough rows to spill over many pages and a checkpoint's worth of log.
    await db.query("insert into people select 'p' || g, $1 || g from generate_series(1, 20000) g", [SECRET]);
    await db.exec("update people set name = name || '!' where name like 'p1%'");
    await db.exec("delete from people where name like 'p2%'");
    await db.exec("checkpoint");
    await db.close();

    for (const file of rawFiles(dir)) expect(file.includes(SECRET)).toBe(false);
    expect(folderState(dir)).toBe("encrypted");
    expect(folderKeyMatches(dir, key)).toBe(true);
    expect(folderKeyMatches(dir, crypto.randomBytes(32))).toBe(false);

    const again = open(dir, key);
    expect((await again.query<{ ssn: string }>("select ssn from people where name = 'Zelda'")).rows).toEqual([{ ssn: SECRET }]);
    expect((await again.query<{ n: number }>("select count(*)::int n from people")).rows[0]!.n).toBe(20001 - 1112);
    await again.close();

    const wrong = open(dir, crypto.randomBytes(32));
    await expect(wrong.waitReady).rejects.toThrow();
    await wrong.close().catch(() => {});
  }, 120_000);

  it("gives the same answers as an unencrypted database for the same work", async () => {
    const plainDir = tempDir(), secureDir = tempDir();
    const plain = new PGlite({ fs: new DurableNodeFS(plainDir), startParams: DURABLE_START_PARAMS });
    const secure = open(secureDir, crypto.randomBytes(32));
    const work = [
      "create table t (id int primary key, v text, n numeric)",
      "insert into t select g, repeat(md5(g::text), 1 + g % 7), g * 1.5 from generate_series(1, 5000) g",
      "create index on t (v)",
      "update t set v = upper(v) where id % 3 = 0",
      "delete from t where id % 11 = 0",
      "vacuum full t",
      "insert into t select g, 'later ' || g, g from generate_series(6000, 6500) g",
      "checkpoint",
    ];
    for (const sql of work) {
      await plain.exec(sql);
      await secure.exec(sql);
    }
    const dump = "select md5(string_agg(id || ':' || v || ':' || n, ',' order by id)) h, count(*)::int c from t";
    const a = (await plain.query(dump)).rows[0];
    const b = (await secure.query(dump)).rows[0];
    expect(b).toEqual(a);
    await plain.close();
    await secure.close();
  }, 120_000);

  it("encrypts an existing unencrypted database folder, checks it, and leaves the original alone", async () => {
    const plainDir = path.join(tempDir(), "database");
    const plain = new PGlite({ fs: new DurableNodeFS(plainDir), startParams: DURABLE_START_PARAMS });
    await plain.exec("create table people (name text, ssn text)");
    await plain.query("insert into people values ('Zelda', $1)", [SECRET]);
    await plain.close();
    expect(folderState(plainDir)).toBe("plain");
    // The check below would see the secret if it were there: here it is, unencrypted.
    expect(rawFiles(plainDir).some((file) => file.includes(SECRET))).toBe(true);

    const key = crypto.randomBytes(32);
    const encDir = `${plainDir}.encrypting`;
    encryptFolder(plainDir, encDir, key);
    expect(folderState(plainDir)).toBe("plain");
    expect(folderState(encDir)).toBe("encrypted");
    for (const file of rawFiles(encDir)) expect(file.includes(SECRET)).toBe(false);

    const db = open(encDir, key);
    expect((await db.query<{ ssn: string }>("select ssn from people")).rows).toEqual([{ ssn: SECRET }]);
    await db.close();

    // A changed file is caught by the check.
    expect(() => verifyFolder(plainDir, encDir, key)).toThrow(); // the database has moved on since it was opened
    expect(() => encryptFolder(plainDir, encDir, key)).toThrow(/already exists/);
  }, 120_000);
});
