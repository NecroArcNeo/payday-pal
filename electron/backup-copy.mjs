// Copies of the backups in a folder the user picks (a USB stick, another drive), so the data survives this
// computer's disk failing or being wiped. The backups in the app's own folder are sealed with this computer's
// data key (keyring.mjs), which goes with the disk, so the copies can't be: each one is a password-protected
// backup file in exactly the format "Download backup file" makes (src/lib/backup-crypto.ts), opened with
// "Restore from file" on any computer. The key is worked out from the password once, when copies are turned
// on, and kept sealed with the data key, so the app writes copies without asking and never stores the password.
// Everything here uses fs.promises: the folder may be a slow USB stick or a network drive, and the main process
// also answers the page's database calls.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ITERATIONS } from "./keyring.mjs";

export const ENCRYPTED_FORMAT = "meridian-payroll-backup-encrypted";
/** How many copies are kept (newest first). Copies of backups the user saved themselves are always kept. */
export const KEEP_CHOICES = [5, 10, 30, 100];
export const DEFAULT_KEEP = 10;

const b64 = (buf) => Buffer.from(buf).toString("base64");
const unb64 = (s) => Buffer.from(s, "base64");
const pbkdf2 = promisify(crypto.pbkdf2);

/** The copies' key from their password: PBKDF2-SHA-256, as backup-crypto.ts does, with one salt for every copy. */
export async function deriveCopyKey(password, salt = crypto.randomBytes(16), iterations = ITERATIONS) {
  return { salt: b64(salt), iterations, key: await pbkdf2(password, salt, iterations, 32, "sha256") };
}

/** A snapshot as a backup file's text: encrypted with `protection` ({ key, salt, iterations }), or plain when it's null. */
export function copyText(snapshot, protection) {
  const text = JSON.stringify(snapshot, null, 1);
  if (!protection) return text;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", protection.key, iv);
  // WebCrypto's AES-GCM puts the tag after the ciphertext; decryptBackup expects it there.
  const data = Buffer.concat([c.update(text, "utf8"), c.final(), c.getAuthTag()]);
  return JSON.stringify({
    format: ENCRYPTED_FORMAT,
    version: 1,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: protection.iterations, salt: protection.salt },
    cipher: { name: "AES-GCM", iv: b64(iv) },
    data: b64(data),
  });
}

/** The snapshot in a copy's text. Throws when `protection` can't open it (another password, or a changed file). */
export function readCopy(text, protection) {
  const raw = JSON.parse(text);
  if (raw?.format !== ENCRYPTED_FORMAT) return raw;
  if (!protection || raw.kdf?.salt !== protection.salt) throw new Error("This copy was made with another password");
  const data = unb64(raw.data);
  const d = crypto.createDecipheriv("aes-256-gcm", protection.key, unb64(raw.cipher.iv));
  d.setAuthTag(data.subarray(data.length - 16));
  return JSON.parse(Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]).toString("utf8"));
}

// ---------------------------------------------------------------- file names

const safeName = (computer) => computer.replace(/[^\w.-]+/g, "-").slice(0, 40) || "computer";
const two = (n) => String(n).padStart(2, "0");
/** Local time, so the names read as the user's clock does; sortable as text. */
const stamp = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`;
};
const KEPT = " - saved by you";

/** "KoPayroll backup - DESKTOP-1 - 2026-11-04 15-30-05.json": the computer's name, so two computers can share one folder. */
export const copyName = (computer, createdAt, manual = false) => `KoPayroll backup - ${safeName(computer)} - ${stamp(createdAt)}${manual ? KEPT : ""}.json`;

/** The app was called Meridian Payroll before: copies it made keep their names and still count as this computer's. */
const COPY_PREFIXES = ["KoPayroll backup - ", "Meridian backup - "];

/** This computer's copies in the folder, oldest first. Anything else there (other computers', the user's own files) is never touched. */
export async function ownCopies(folder, computer) {
  const pattern = /^\d{4}-\d\d-\d\d \d\d-\d\d-\d\d( - saved by you)?\.json$/;
  /** The time part of one of this computer's copy names, or null for any other file. */
  const when = (f) => {
    const prefix = COPY_PREFIXES.map((p) => `${p}${safeName(computer)} - `).find((p) => f.startsWith(p));
    return prefix && pattern.test(f.slice(prefix.length)) ? f.slice(prefix.length) : null;
  };
  // Sorted by the time in the name, so old and new names interleave correctly.
  return (await fs.readdir(folder)).filter((f) => when(f) !== null).sort((a, b) => when(a).localeCompare(when(b)));
}

/** Writes to a temporary file, flushes it to the drive, then renames it into place, so a copy is never half-written. */
export async function writeDurably(file, text) {
  const tmp = `${file}.tmp`;
  const fd = await fs.open(tmp, "w");
  try {
    await fd.writeFile(text);
    await fd.sync();
  } finally {
    await fd.close();
  }
  await fs.rename(tmp, file);
}

// ---------------------------------------------------------------- copying

/**
 * Writes one backup record ({ created_at, reason, snapshot }) into the folder, reads it back to check it opens
 * to the same data, then removes this computer's oldest copies beyond `keep` (copies of "manual" backups stay).
 */
export async function copyBackup({ folder, computer, keep, protection, record }) {
  const name = copyName(computer, record.created_at, record.reason === "manual");
  const file = path.join(folder, name);
  await writeDurably(file, copyText(record.snapshot, protection));
  const back = readCopy(await fs.readFile(file, "utf8"), protection);
  if (JSON.stringify(back) !== JSON.stringify(record.snapshot)) throw new Error("The copy didn't read back the same");
  const rolling = (await ownCopies(folder, computer)).filter((f) => !f.endsWith(`${KEPT}.json`));
  for (const old of rolling.slice(0, Math.max(0, rolling.length - keep))) await fs.rm(path.join(folder, old), { force: true });
  return name;
}

/**
 * Re-encrypts this computer's copies in the folder from one protection to another (a new password, or
 * turning the password on or off), so none is left needing a password the user has moved on from.
 * Returns how many couldn't be opened with `from` and were left as they were.
 */
export async function rewriteCopies(folder, computer, from, to) {
  let skipped = 0;
  for (const name of await ownCopies(folder, computer)) {
    const file = path.join(folder, name);
    try {
      await writeDurably(file, copyText(readCopy(await fs.readFile(file, "utf8"), from), to));
    } catch {
      skipped++;
    }
  }
  return skipped;
}

/** Inside a folder that OneDrive, Dropbox or Google Drive uploads. */
function inCloudFolder(folder, env) {
  const roots = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].filter(Boolean);
  const lower = folder.toLowerCase();
  return roots.some((r) => lower === r.toLowerCase() || lower.startsWith(r.toLowerCase() + path.sep))
    || /[\\/](dropbox|google drive|onedrive[^\\/]*)([\\/]|$)/i.test(folder);
}

/**
 * Checks a folder can take the copies: it exists, isn't inside the app's own folder, and can be written to
 * (a test file is written and removed). Throws with the reason when it can't. Also says whether it's on the
 * same drive as the app's data (a wiped or failed disk would take both) or in a folder a cloud service uploads.
 */
export async function checkFolder(folder, appDir, env = process.env) {
  const full = path.resolve(folder);
  const rel = path.relative(path.resolve(appDir), full);
  if (!rel || (!rel.startsWith("..") && !path.isAbsolute(rel))) throw new Error("That's inside the app's own folder: pick a folder on another drive, such as a USB stick.");
  const stat = await fs.stat(full).catch(() => null);
  if (!stat?.isDirectory()) throw new Error("That folder doesn't exist (is the drive plugged in?).");
  const probe = path.join(full, `.meridian-write-test-${process.pid}`);
  try {
    await fs.writeFile(probe, "test");
    await fs.rm(probe, { force: true });
  } catch (e) {
    throw new Error(`The app can't write in that folder: ${copyError(e)}`);
  }
  return {
    folder: full,
    sameDrive: path.parse(full).root.toLowerCase() === path.parse(path.resolve(appDir)).root.toLowerCase(),
    cloudFolder: inCloudFolder(full, env),
  };
}

/** A copy failure in words the user can act on. */
export function copyError(e) {
  switch (e?.code) {
    case "ENOENT": return "the folder isn't there (is the USB stick or drive plugged in?)";
    case "EACCES": case "EPERM": return "Windows didn't allow writing there";
    case "ENOSPC": return "the drive is full";
    case "EROFS": return "the drive is read-only";
    case "EBUSY": return "the file was in use";
    default: return e instanceof Error ? e.message : String(e);
  }
}
