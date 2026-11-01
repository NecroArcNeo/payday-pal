// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createKeyring, disableEscrow, enableEscrow, formatRecoveryKey, isSealed, keyringStatus, newRecoveryKey, parseRecoveryKey,
  removePassword, seal, sealedHeader, setPassword, unlockWithDevice, unlockWithEscrow, unlockWithPassword, unlockWithRecovery, unseal,
  // @ts-expect-error: the Electron main process's plain-JS module
} from "../../../electron/keyring.mjs";

// Stands in for Windows' safeStorage: reversible, but only with this "account".
const protect = async (s: string) => Buffer.from(`acct:${s}`);
const unprotect = async (b: Buffer) => {
  const s = b.toString();
  if (!s.startsWith("acct:")) throw new Error("not this account");
  return s.slice(5);
};

describe("the keyring", () => {
  it("opens by itself with no password, and the data key never changes when the password does", async () => {
    const { ring, dataKey } = await createKeyring(protect);
    expect((await unlockWithDevice(ring, unprotect))!.equals(dataKey)).toBe(true);
    expect(keyringStatus(ring)).toMatchObject({ password: false, recovery: false, cloud: false });

    const locked = await setPassword(ring, dataKey, "correct horse");
    expect(locked.wraps.device).toBeUndefined(); // or the password would protect nothing
    expect(await unlockWithDevice(locked, unprotect)).toBeNull();
    expect((await unlockWithPassword(locked, "correct horse")).equals(dataKey)).toBe(true);
    await expect(unlockWithPassword(locked, "correct horsf")).rejects.toThrow("Wrong password");

    const changed = await setPassword(locked, dataKey, "battery staple");
    await expect(unlockWithPassword(changed, "correct horse")).rejects.toThrow("Wrong password");
    expect((await unlockWithPassword(changed, "battery staple")).equals(dataKey)).toBe(true);

    const open = await removePassword(changed, dataKey, protect);
    expect(open.wraps.password).toBeUndefined();
    expect((await unlockWithDevice(open, unprotect))!.equals(dataKey)).toBe(true);
  }, 30_000);

  it("unlocks with the recovery key however it's typed, and a new one replaces the old", async () => {
    const { ring, dataKey } = await createKeyring(protect);
    const { ring: withKey, text } = newRecoveryKey(ring, dataKey);
    expect(text).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(unlockWithRecovery(withKey, text).equals(dataKey)).toBe(true);
    expect(unlockWithRecovery(withKey, ` ${text.toLowerCase().replace(/-/g, " ")} `).equals(dataKey)).toBe(true);
    // Swap one character for another valid one: refused.
    const typo = (text[0] === "A" ? "B" : "A") + text.slice(1);
    expect(() => unlockWithRecovery(withKey, typo)).toThrow(/doesn't match/);
    expect(() => unlockWithRecovery(withKey, "ABCD")).toThrow(/isn't a recovery key/);

    const { ring: renewed, text: next } = newRecoveryKey(withKey, dataKey);
    expect(() => unlockWithRecovery(renewed, text)).toThrow();
    expect(unlockWithRecovery(renewed, next).equals(dataKey)).toBe(true);
  });

  it("reads back recovery keys exactly, with the letters people confuse", () => {
    const bytes = Buffer.from([0, 255, 1, 128, 64, 32, 16, 8, 4, 2, 1, 0, 9, 99, 199, 250, 7, 77, 177, 17]);
    const text = formatRecoveryKey(bytes);
    expect(parseRecoveryKey(text)!.equals(bytes)).toBe(true);
    expect(parseRecoveryKey(text.replace(/0/g, "O").replace(/1/g, "l"))!.equals(bytes)).toBe(true);
    expect(parseRecoveryKey(text.replace(/-/g, "").slice(1) + "U")).toBeNull();
  });

  it("unlocks with the cloud's escrow key only while email reset is on", async () => {
    const { ring, dataKey } = await createKeyring(protect);
    const { ring: on, escrowKey } = enableEscrow(ring, dataKey);
    expect(keyringStatus(on).cloud).toBe(true);
    expect(unlockWithEscrow(on, escrowKey).equals(dataKey)).toBe(true);
    expect(() => unlockWithEscrow(on, Buffer.alloc(32).toString("base64"))).toThrow();
    expect(() => unlockWithEscrow(disableEscrow(on), escrowKey)).toThrow(/isn't turned on/);
  });

  it("refuses the device wrap from another account", async () => {
    const { ring } = await createKeyring(protect);
    await expect(unlockWithDevice(ring, () => { throw new Error("DPAPI says no"); })).rejects.toThrow(/recovery key/);
  });
});

describe("sealed backups", () => {
  it("hide the snapshot, keep the header readable, and refuse another key or a changed header", async () => {
    const { dataKey } = await createKeyring(protect);
    const record = { id: 3, created_at: "2026-10-31T10:00:00Z", reason: "auto", counts: { employees: 2 }, snapshot: { employees: [{ ssn: "123-45-6789" }] } };
    const { snapshot: _s, ...header } = record;
    const sealed = seal(dataKey, header, record);
    expect(isSealed(sealed)).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain("123-45-6789");
    expect(sealedHeader(sealed)).toEqual(header);
    expect(unseal(dataKey, sealed)).toEqual(record);
    const other = (await createKeyring(protect)).dataKey;
    expect(() => unseal(other, sealed)).toThrow();
    expect(() => unseal(dataKey, { ...sealed, reason: "manual" })).toThrow();
  });
});
