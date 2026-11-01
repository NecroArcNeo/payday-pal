// The key that encrypts the desktop database and its automatic backups, and the ways to unlock it.
//
// Envelope encryption: the data is encrypted once, with a random 32-byte data key that never changes. That key
// is stored only "wrapped" (itself encrypted) in keyring.json, once per way of unlocking:
//  - device:   by Windows for this user account (Electron's safeStorage, i.e. DPAPI). Only while there is no
//              app password, so the app opens without asking.
//  - password: by a key derived from the app password (PBKDF2-SHA-256, as backup-crypto.ts).
//  - recovery: by a random recovery key the user writes down, for a forgotten password.
//  - cloud:    by a random escrow key kept only in the user's cloud account (opt-in email reset).
// Setting, changing or removing the password only rewraps the data key: instant, and the data isn't touched.
// Losing keyring.json loses the data key: it is never written anywhere else.
//
// Pure Node crypto, no Electron (the device wrap is passed in as protect/unprotect, which may be async), so
// it's tested directly.
import crypto from "node:crypto";

export const KEYRING_FORMAT = "meridian-keyring";
export const SEALED_FORMAT = "meridian-payroll-backup-sealed";
/** As backup-crypto.ts: OWASP's 2023 figure for PBKDF2-SHA-256. */
export const ITERATIONS = 600_000;

export class WrongKeyError extends Error {}

const b64 = (buf) => Buffer.from(buf).toString("base64");
const unb64 = (s) => Buffer.from(s, "base64");

/** AES-256-GCM, so a wrong key (or a changed keyring) is detected rather than producing a wrong data key. */
function wrap(kek, dataKey, label) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", kek, iv);
  c.setAAD(Buffer.from(label));
  const data = Buffer.concat([c.update(dataKey), c.final(), c.getAuthTag()]);
  return { iv: b64(iv), data: b64(data) };
}
function unwrap(kek, wrapped, label) {
  const raw = unb64(wrapped.data);
  const d = crypto.createDecipheriv("aes-256-gcm", kek, unb64(wrapped.iv));
  d.setAAD(Buffer.from(label));
  d.setAuthTag(raw.subarray(raw.length - 16));
  try {
    return Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]);
  } catch {
    throw new WrongKeyError("That doesn't unlock this computer's payroll data");
  }
}

const passwordKek = (password, salt, iterations) =>
  new Promise((resolve, reject) => crypto.pbkdf2(password.normalize("NFC"), salt, iterations, 32, "sha256", (e, k) => (e ? reject(e) : resolve(k))));
/** A recovery key is random (not chosen by a person), so it needs no slow derivation to resist guessing. */
const recoveryKek = (bytes) => Buffer.from(crypto.hkdfSync("sha256", bytes, Buffer.alloc(0), "meridian keyring recovery", 32));

// Crockford's base32: no I, L, O or U, so it reads back unambiguously; typing an I, L or O is forgiven.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RECOVERY_BYTES = 20; // 160 bits: 32 characters, 8 groups of 4

export function formatRecoveryKey(bytes) {
  let bits = 0, value = 0, out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{1,4}/g).join("-");
}

/** The recovery key's bytes from what the user typed (any case, spaces or dashes), or null if it can't be one. */
export function parseRecoveryKey(text) {
  const clean = String(text).toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (clean.length !== (RECOVERY_BYTES * 8) / 5) return null;
  const out = [];
  let bits = 0, value = 0;
  for (const ch of clean) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new keyring for a new data key, opened by this computer's account (`protect`: safeStorage, or null). */
export async function createKeyring(protect) {
  const dataKey = crypto.randomBytes(32);
  const ring = { format: KEYRING_FORMAT, version: 1, id: crypto.randomUUID(), wraps: {} };
  return { ring: await withDevice(ring, dataKey, protect), dataKey };
}

/** What the keyring offers, for the page (never any key material). */
export function keyringStatus(ring) {
  return {
    password: !!ring.wraps.password,
    recovery: !!ring.wraps.recovery,
    cloud: !!ring.wraps.cloud,
    keyringId: ring.id,
  };
}

export function validKeyring(raw) {
  return !!raw && raw.format === KEYRING_FORMAT && raw.version === 1 && typeof raw.id === "string" && !!raw.wraps && typeof raw.wraps === "object";
}

/**
 * The data key without asking anyone, if there's no password: from Windows' protection of this account, or
 * (where the system has no such store) kept as is. Null if it needs a password. Throws if Windows can't open it
 * (for example the folder was copied to another computer or account): then the password or recovery key is needed.
 */
export async function unlockWithDevice(ring, unprotect) {
  const w = ring.wraps.device;
  if (!w) return null;
  if (w.kind === "plain") return unb64(w.key);
  try {
    return unb64(await unprotect(unb64(w.data)));
  } catch {
    throw new WrongKeyError("Windows couldn't unlock the key on this account. Use the app password or the recovery key.");
  }
}

export async function unlockWithPassword(ring, password) {
  const w = ring.wraps.password;
  if (!w) throw new WrongKeyError("No app password is set");
  try {
    return unwrap(await passwordKek(password, unb64(w.salt), w.iterations), w, "password");
  } catch (e) {
    if (e instanceof WrongKeyError) throw new WrongKeyError("Wrong password");
    throw e;
  }
}

export function unlockWithRecovery(ring, text) {
  const w = ring.wraps.recovery;
  if (!w) throw new WrongKeyError("No recovery key was made for this computer");
  const bytes = parseRecoveryKey(text);
  if (!bytes) throw new WrongKeyError("That isn't a recovery key: it has 32 letters and digits, in groups of 4");
  try {
    return unwrap(recoveryKek(bytes), w, "recovery");
  } catch (e) {
    if (e instanceof WrongKeyError) throw new WrongKeyError("That recovery key doesn't match this computer's");
    throw e;
  }
}

export function unlockWithEscrow(ring, escrowKey) {
  const w = ring.wraps.cloud;
  if (!w) throw new WrongKeyError("Email reset isn't turned on for this computer");
  return unwrap(unb64(escrowKey), w, "cloud");
}

async function withDevice(ring, dataKey, protect) {
  const device = protect ? { kind: "safeStorage", data: b64(await protect(dataKey.toString("base64"))) } : { kind: "plain", key: b64(dataKey) };
  return { ...ring, wraps: { ...ring.wraps, device } };
}

/** The keyring with `password` opening the data key. The device wrap goes, or the password would protect nothing. */
export async function setPassword(ring, dataKey, password) {
  const salt = crypto.randomBytes(16);
  const kek = await passwordKek(password, salt, ITERATIONS);
  const { device: _gone, ...wraps } = ring.wraps;
  return { ...ring, wraps: { ...wraps, password: { salt: b64(salt), iterations: ITERATIONS, ...wrap(kek, dataKey, "password") } } };
}

/** No app password: the app opens without asking again. */
export async function removePassword(ring, dataKey, protect) {
  const { password: _gone, ...wraps } = (await withDevice(ring, dataKey, protect)).wraps;
  return { ...ring, wraps };
}

/** A new recovery key (the old one stops working). Returns the keyring and the key to show the user, once. */
export function newRecoveryKey(ring, dataKey) {
  const bytes = crypto.randomBytes(RECOVERY_BYTES);
  return { ring: { ...ring, wraps: { ...ring.wraps, recovery: wrap(recoveryKek(bytes), dataKey, "recovery") } }, text: formatRecoveryKey(bytes) };
}

/** Email reset on: a new escrow key for the cloud to keep. Returns the keyring and that key (base64). */
export function enableEscrow(ring, dataKey) {
  const escrow = crypto.randomBytes(32);
  return { ring: { ...ring, wraps: { ...ring.wraps, cloud: wrap(escrow, dataKey, "cloud") } }, escrowKey: b64(escrow) };
}

export function disableEscrow(ring) {
  const { cloud: _gone, ...wraps } = ring.wraps;
  return { ...ring, wraps };
}

// ---------------------------------------------------------------- sealed files (automatic backups)

const sealKey = (dataKey) => Buffer.from(crypto.hkdfSync("sha256", dataKey, Buffer.alloc(0), "meridian sealed backups", 32));

/**
 * A backup record encrypted with the data key (AES-256-GCM). `header` stays readable (when and why it was made,
 * how many rows), so listing backups needs no decryption; it's also bound to the contents, so it can't be swapped.
 */
export function seal(dataKey, header, record) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", sealKey(dataKey), iv);
  const head = { format: SEALED_FORMAT, version: 1, ...header };
  c.setAAD(Buffer.from(JSON.stringify(head)));
  const data = Buffer.concat([c.update(JSON.stringify(record), "utf8"), c.final(), c.getAuthTag()]);
  return { ...head, iv: b64(iv), data: b64(data) };
}

export const isSealed = (raw) => !!raw && raw.format === SEALED_FORMAT;

export function unseal(dataKey, sealed) {
  const { iv, data, ...head } = sealed;
  const raw = unb64(data);
  const d = crypto.createDecipheriv("aes-256-gcm", sealKey(dataKey), unb64(iv));
  d.setAAD(Buffer.from(JSON.stringify(head)));
  d.setAuthTag(raw.subarray(raw.length - 16));
  try {
    return JSON.parse(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString("utf8"));
  } catch {
    throw new WrongKeyError("This backup can't be opened with this computer's key, or it was changed");
  }
}

/** A sealed file's readable header, without its contents. */
export function sealedHeader(sealed) {
  const { iv: _iv, data: _data, format: _f, version: _v, ...header } = sealed;
  return header;
}
