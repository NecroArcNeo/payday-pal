// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptBackup, isEncryptedBackup, WrongPasswordError } from "../backup-crypto";
import {
  checkFolder, copyBackup, copyError, copyName, copyText, deriveCopyKey, ownCopies, readCopy, rewriteCopies,
  // @ts-expect-error: the Electron main process's plain-JS module
} from "../../../electron/backup-copy.mjs";

const snapshot = { format: "meridian-payroll-backup", schema_version: 12, tables: { employees: [{ id: "e1", first_name: "Ann", ssn: "123-45-6789" }] } };
// Few PBKDF2 rounds keep the tests quick; the files say how many they used, so opening them works the same.
const key = (password: string) => deriveCopyKey(password, undefined, 1000);
const record = (created_at: string, reason = "automatic", snap: object = snapshot) => ({ created_at, reason, snapshot: snap });

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-copy-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("a copy's file", () => {
  it("is a protected backup file that the app's Restore from file opens with the password", async () => {
    const text = copyText(snapshot, await key("correct horse"));
    expect(text).not.toContain("123-45-6789");
    const raw = JSON.parse(text);
    expect(isEncryptedBackup(raw)).toBe(true);
    expect(JSON.parse(await decryptBackup(raw, "correct horse"))).toEqual(snapshot);
    await expect(decryptBackup(raw, "wrong horse")).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("is the plain backup file without a password", () => {
    expect(JSON.parse(copyText(snapshot, null))).toEqual(snapshot);
    expect(readCopy(copyText(snapshot, null), null)).toEqual(snapshot);
  });

  it("can't be read with another password's key", async () => {
    const text = copyText(snapshot, await key("one password"));
    const other = await key("one password"); // the same password with a new salt is another key
    expect(() => readCopy(text, null)).toThrow();
    expect(() => readCopy(text, other)).toThrow(/another password/);
  });

  it("is named by computer and local time, with backups the user saved marked as kept", () => {
    const at = new Date(2026, 10, 4, 15, 30, 5).toISOString();
    expect(copyName("DESKTOP 1", at)).toBe("KoPayroll backup - DESKTOP-1 - 2026-11-04 15-30-05.json");
    expect(copyName("DESKTOP 1", at, true)).toBe("KoPayroll backup - DESKTOP-1 - 2026-11-04 15-30-05 - saved by you.json");
  });
});

describe("copying into the folder", () => {
  const at = (minute: number) => new Date(2026, 10, 4, 9, minute).toISOString();

  it("writes each backup, keeps only the newest few, and never touches anything else", async () => {
    const protection = await key("pass phrase");
    await fs.writeFile(path.join(dir, "my notes.txt"), "mine");
    await fs.writeFile(path.join(dir, copyName("OTHER-PC", at(0))), "theirs");
    await copyBackup({ folder: dir, computer: "PC", keep: 2, protection, record: record(at(1), "manual") });
    for (const m of [2, 3, 4]) await copyBackup({ folder: dir, computer: "PC", keep: 2, protection, record: record(at(m)) });
    expect(await ownCopies(dir, "PC")).toEqual([copyName("PC", at(1), true), copyName("PC", at(3)), copyName("PC", at(4))]);
    expect((await fs.readdir(dir)).sort()).toEqual([...(await ownCopies(dir, "PC")), copyName("OTHER-PC", at(0)), "my notes.txt"].sort());
    expect(readCopy(await fs.readFile(path.join(dir, copyName("PC", at(4))), "utf8"), protection)).toEqual(snapshot);
    expect((await fs.readdir(dir)).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("counts copies named before the app was renamed, oldest first by their time", async () => {
    const old = (minute: number) => copyName("PC", at(minute)).replace("KoPayroll backup", "Meridian backup");
    await fs.writeFile(path.join(dir, old(1)), "a");
    await fs.writeFile(path.join(dir, old(3)), "b");
    await fs.writeFile(path.join(dir, "Meridian notes - PC - 2026-11-04 09-02-00.json"), "mine");
    await copyBackup({ folder: dir, computer: "PC", keep: 2, protection: null, record: record(at(2)) });
    await copyBackup({ folder: dir, computer: "PC", keep: 2, protection: null, record: record(at(4)) });
    expect(await ownCopies(dir, "PC")).toEqual([old(3), copyName("PC", at(4))]);
    expect(await fs.readdir(dir)).toContain("Meridian notes - PC - 2026-11-04 09-02-00.json");
  });

  it("re-encrypts the copies already there when the password changes", async () => {
    const before = await key("first password");
    const after = await key("second password");
    await copyBackup({ folder: dir, computer: "PC", keep: 5, protection: before, record: record(at(1)) });
    await fs.writeFile(path.join(dir, copyName("PC", at(2))), copyText(snapshot, await key("forgotten one")));
    expect(await rewriteCopies(dir, "PC", before, after)).toBe(1); // the one made with another password stays as it was
    const file = JSON.parse(await fs.readFile(path.join(dir, copyName("PC", at(1))), "utf8"));
    expect(JSON.parse(await decryptBackup(file, "second password"))).toEqual(snapshot);
    await expect(decryptBackup(file, "first password")).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("fails with the reason when the drive is gone", async () => {
    const gone = path.join(dir, "unplugged");
    const e = await copyBackup({ folder: gone, computer: "PC", keep: 5, protection: null, record: record(at(1)) }).catch((x: unknown) => x);
    expect(copyError(e)).toMatch(/isn't there/);
  });
});

describe("checking the folder", () => {
  it("refuses the app's own folder and folders that don't exist", async () => {
    const app = path.join(dir, "app");
    await fs.mkdir(path.join(app, "Backups"), { recursive: true });
    await expect(checkFolder(app, app, {})).rejects.toThrow(/app's own folder/);
    await expect(checkFolder(path.join(app, "Backups"), app, {})).rejects.toThrow(/app's own folder/);
    await expect(checkFolder(path.join(dir, "nope"), app, {})).rejects.toThrow(/doesn't exist/);
  });

  it("says when it's on the app's drive or in a folder OneDrive uploads, and leaves no test file", async () => {
    const usb = path.join(dir, "usb");
    await fs.mkdir(usb);
    const r = await checkFolder(usb, path.join(dir, "app"), { OneDrive: dir });
    expect(r).toEqual({ folder: usb, sameDrive: true, cloudFolder: true });
    expect((await checkFolder(usb, path.join(dir, "app"), {})).cloudFolder).toBe(false);
    expect(await fs.readdir(usb)).toEqual([]);
  });
});
