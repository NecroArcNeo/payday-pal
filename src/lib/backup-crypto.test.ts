// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decryptBackup, encryptBackup, isEncryptedBackup, WrongPasswordError } from "./backup-crypto";

const backup = JSON.stringify({ format: "meridian-payroll-backup", data: { employees: [{ ssn: "123-45-6789", first_name: "Ada" }] } });

describe("backup file encryption", () => {
  it("round-trips with the right password and hides the contents", async () => {
    const file = await encryptBackup(backup, "correct horse battery");
    expect(isEncryptedBackup(file)).toBe(true);
    const written = JSON.stringify(file);
    expect(written).not.toContain("123-45-6789");
    expect(written).not.toContain("Ada");
    expect(await decryptBackup(JSON.parse(written), "correct horse battery")).toBe(backup);
  });

  it("refuses a wrong password", async () => {
    const file = await encryptBackup(backup, "correct horse battery");
    await expect(decryptBackup(file, "Correct horse battery")).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("refuses a file that was changed", async () => {
    const file = await encryptBackup(backup, "correct horse battery");
    const bytes = atob(file.data);
    const flipped = btoa(bytes.slice(0, 5) + String.fromCharCode(bytes.charCodeAt(5) ^ 1) + bytes.slice(6));
    await expect(decryptBackup({ ...file, data: flipped }, "correct horse battery")).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("uses a fresh salt and IV each time", async () => {
    const a = await encryptBackup(backup, "same password");
    const b = await encryptBackup(backup, "same password");
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.cipher.iv).not.toBe(b.cipher.iv);
    expect(a.data).not.toBe(b.data);
  });

  it("doesn't mistake a plain backup for an encrypted one", () => {
    expect(isEncryptedBackup(JSON.parse(backup))).toBe(false);
    expect(isEncryptedBackup(null)).toBe(false);
  });
});
