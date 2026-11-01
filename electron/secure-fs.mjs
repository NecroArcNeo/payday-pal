// Encryption of the desktop database's files, block by block, as Postgres reads and writes them. This is the
// same idea as BitLocker, but for one folder and with the app's own key (see keyring.mjs).
//
// Each file on disk is a 4 KB header (a marker, the file's random id, and a check that the right key is in use)
// followed by the file's contents in 4 KB units, each encrypted with AES-256 in XTS mode. XTS is the mode disk
// encryption uses:
//  - The ciphertext is exactly as long as the data, so the file's size is the header plus its true size, and any
//    unit can be read or rewritten on its own.
//  - Every 16 bytes are encrypted separately, mixed with a "tweak" made from the file's id, the unit's number
//    and the position inside it. So the same data in two places looks different, and a write the disk only
//    half-finished (a power cut) leaves the old 16-byte pieces readable, exactly as with an unencrypted file.
//    Postgres' own recovery then repairs the page from its log (full_page_writes), as it always has.
//  - It doesn't detect tampering (nor does BitLocker); it keeps the data unreadable, which is the goal here.
// The file's id lives in its header, not its name, so Postgres renaming a file needs no re-encryption.
//
// Electron's crypto (BoringSSL) has no XTS, so it's built here from AES-ECB, which it has (tested against
// OpenSSL's own XTS in secure-fs.test.ts). Files shorter than 16 bytes, or a last unit that is, can't use XTS
// (it needs one whole block); those few bytes are XORed with a keystream made from the same tweak.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DurableNodeFS } from "./durable-fs.mjs";

export const UNIT = 4096;
export const HEADER = 4096;
const MAGIC = Buffer.from("MERIDENC", "latin1");
const VERSION = 1;
const ID_AT = 16;
const ID_LEN = 8;
const CHECK_AT = 24;
const CHECK_LEN = 16;
/** EIO: what Postgres sees when a file can't be decrypted. */
const EIO = 29;

if (os.endianness() !== "LE") throw new Error("The database encryption assumes a little-endian processor");

/** A file that isn't one of ours (no header, or another key's). */
export class CipherError extends Error {}

const derive = (key, info, length) => Buffer.from(crypto.hkdfSync("sha256", key, Buffer.alloc(0), info, length));

/** An AES-ECB cipher with no padding. ECB keeps no state between calls, so one object serves every call. */
function ecb(key, decrypt) {
  const c = decrypt ? crypto.createDecipheriv("aes-256-ecb", key, null) : crypto.createCipheriv("aes-256-ecb", key, null);
  c.setAutoPadding(false);
  return c;
}

/**
 * Writes `blocks` successive XTS tweaks into `mask` (as 32-bit words, from word `at`), starting at the 16 bytes
 * of `t` at `tAt`. Each next tweak is the previous one multiplied by x in GF(2^128): a one-bit shift left of the
 * little-endian 128-bit number, folding the bit that falls off back in as 0x87.
 */
function fillMask(mask, at, t, tAt, blocks) {
  let a = t.readUInt32LE(tAt), b = t.readUInt32LE(tAt + 4), c = t.readUInt32LE(tAt + 8), d = t.readUInt32LE(tAt + 12);
  for (let j = 0; j < blocks; j++) {
    mask[at++] = a; mask[at++] = b; mask[at++] = c; mask[at++] = d;
    const carry = d >>> 31;
    d = ((d << 1) | (c >>> 31)) >>> 0;
    c = ((c << 1) | (b >>> 31)) >>> 0;
    b = ((b << 1) | (a >>> 31)) >>> 0;
    a = ((a << 1) ^ (carry ? 0x87 : 0)) >>> 0;
  }
}

/** XEX: each block is XORed with its tweak, run through AES, then XORed again. `bytes` is a multiple of 16. */
function xex(bytes, mask, cipher) {
  const work = new Uint8Array(bytes.length); // a fresh ArrayBuffer, so its 32-bit view is aligned
  const words = new Uint32Array(work.buffer);
  work.set(bytes);
  for (let i = 0; i < words.length; i++) words[i] ^= mask[i];
  work.set(cipher.update(work));
  for (let i = 0; i < words.length; i++) words[i] ^= mask[i];
  return work;
}

/**
 * AES-XTS (IEEE 1619) over units of UNIT bytes, keyed with 64 bytes (two AES-256 keys). Unit n of a file is
 * tweaked with `fileId ‖ n` (8 bytes each, little-endian), which is the 16-byte "IV" OpenSSL's aes-256-xts takes.
 */
export function xtsCipher(key64) {
  const enc = ecb(key64.subarray(0, 32), false);
  const dec = ecb(key64.subarray(0, 32), true);
  const tweakKey = ecb(key64.subarray(32, 64), false);

  /** The plain tweaks (file id ‖ unit number) of `count` units from `first`. */
  function tweakBlocks(fileId, first, count) {
    const plain = Buffer.alloc(count * 16);
    for (let i = 0; i < count; i++) {
      fileId.copy(plain, i * 16);
      plain.writeBigUInt64LE(BigInt(first + i), i * 16 + 8);
    }
    return plain;
  }

  /** A last unit whose length isn't a multiple of 16: XTS's "ciphertext stealing" for the final partial block. */
  function steal(unit, t, decrypt) {
    const m = Math.floor(unit.length / 16), r = unit.length % 16;
    const mask = new Uint32Array((m + 1) * 4);
    fillMask(mask, 0, t, 0, m + 1);
    const cipher = decrypt ? dec : enc;
    if (m > 1) unit.set(xex(unit.subarray(0, (m - 1) * 16), mask.subarray(0, (m - 1) * 4), cipher));
    const last = unit.subarray((m - 1) * 16, m * 16), partial = unit.subarray(m * 16);
    const maskOf = (j) => mask.subarray(j * 4, j * 4 + 4);
    // Encrypting: the last whole block goes first, lends its tail to the partial one, and they swap places.
    // Decrypting undoes it, so the tweaks are used the other way round.
    const first = xex(last, maskOf(decrypt ? m : m - 1), cipher);
    const joined = new Uint8Array(16);
    joined.set(partial);
    joined.set(first.subarray(r), r);
    const second = xex(joined, maskOf(decrypt ? m - 1 : m), cipher);
    last.set(second);
    partial.set(first.subarray(0, r));
  }

  return {
    tweakBlocks,
    /** Encrypts (or decrypts) in place `data`: whole units from `first`, the last one possibly shorter (≥ 16 bytes). */
    crypt(fileId, first, data, decrypt) {
      const count = Math.ceil(data.length / UNIT);
      if (!count) return data;
      const lastLen = data.length - (count - 1) * UNIT;
      if (lastLen < 16) throw new Error("XTS needs at least 16 bytes");
      const t = tweakKey.update(tweakBlocks(fileId, first, count));
      const plainUnits = lastLen % 16 === 0 ? count : count - 1;
      const plainLen = plainUnits === count ? data.length : (count - 1) * UNIT;
      if (plainLen) {
        const mask = new Uint32Array(plainLen / 4);
        for (let u = 0; u < plainUnits; u++) fillMask(mask, (u * UNIT) / 4, t, u * 16, Math.min(UNIT, plainLen - u * UNIT) / 16);
        data.set(xex(data.subarray(0, plainLen), mask, decrypt ? dec : enc));
      }
      if (plainUnits < count) steal(data.subarray(plainLen), t.subarray((count - 1) * 16), decrypt);
      return data;
    },
  };
}

/** The data key's ciphers for database files, and the check its headers carry. */
export function fileCipher(dataKey) {
  if (dataKey?.length !== 32) throw new Error("The data key must be 32 bytes");
  const xts = xtsCipher(derive(dataKey, "meridian database xts", 64));
  const tail = ecb(derive(dataKey, "meridian database short tail", 32), false);
  const check = derive(dataKey, "meridian database key check", CHECK_LEN);
  return {
    check,
    /** Encrypts (or decrypts) in place the units from `first`: all whole except perhaps the last. */
    crypt(fileId, first, data, decrypt) {
      const count = Math.ceil(data.length / UNIT);
      const lastLen = data.length - (count - 1) * UNIT;
      if (count && lastLen < 16) {
        // Too short for XTS: XOR with AES(tweak), which is the same both ways.
        const end = data.subarray((count - 1) * UNIT);
        const stream = tail.update(xts.tweakBlocks(fileId, first + count - 1, 1));
        for (let i = 0; i < end.length; i++) end[i] ^= stream[i];
        xts.crypt(fileId, first, data.subarray(0, (count - 1) * UNIT), decrypt);
      } else {
        xts.crypt(fileId, first, data, decrypt);
      }
      return data;
    },
  };
}

function readFull(fd, buf, position) {
  let done = 0;
  while (done < buf.length) {
    const n = fs.readSync(fd, buf, done, buf.length - done, position + done);
    if (n === 0) throw new CipherError("The file ended early");
    done += n;
  }
}
function writeFull(fd, buf, position) {
  let done = 0;
  while (done < buf.length) done += fs.writeSync(fd, buf, done, buf.length - done, position + done);
}

/** A file's true size from its size on disk (a file still without a whole header holds nothing yet). */
export const logicalSize = (rawSize) => (rawSize >= HEADER ? rawSize - HEADER : 0);

/**
 * Reading, writing and resizing encrypted files through their open file descriptors, with their true sizes and
 * offsets. Every unit is always encrypted at its current length (the last one is shorter when the file is), so a
 * write that grows a file also rewrites its old last unit, and the gap before a write past the end is filled
 * with encrypted zeros (an unencrypted hole would read back as garbage).
 */
export class EncryptedFiles {
  /** `sync` flushes a file to disk (fs.fsyncSync; tests pass their own). */
  constructor(cipher, sync = fs.fsyncSync) {
    this.cipher = cipher;
    this.sync = sync;
    /** Each open file's id, once read. A header never changes after it's written, so this can't go stale. */
    this.ids = new Map();
  }

  /** Call when a descriptor closes: the number may be reused for another file. */
  forget(fd) {
    this.ids.delete(fd);
  }

  size(fd) {
    return logicalSize(fs.fstatSync(fd).size);
  }

  /** The file's id from its header, or null if it has none yet. */
  idOf(fd) {
    const known = this.ids.get(fd);
    if (known) return known;
    if (fs.fstatSync(fd).size < HEADER) return null;
    const head = Buffer.alloc(CHECK_AT + CHECK_LEN);
    readFull(fd, head, 0);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC) || head[8] !== VERSION) throw new CipherError("Not an encrypted database file");
    if (!head.subarray(CHECK_AT).equals(this.cipher.check)) throw new CipherError("The file was encrypted with another key");
    const id = Buffer.from(head.subarray(ID_AT, ID_AT + ID_LEN));
    this.ids.set(fd, id);
    return id;
  }

  /**
   * The id, writing a header first if the file has none. The header is flushed by itself before any data, so a
   * power cut can't leave data behind a missing header (the data would be unreadable); a header the disk only
   * partly wrote leaves the file shorter than HEADER, which counts as empty and is simply written again.
   */
  ensureId(fd) {
    const known = this.idOf(fd);
    if (known) return known;
    const id = crypto.randomBytes(ID_LEN);
    const head = Buffer.alloc(HEADER);
    MAGIC.copy(head);
    head[8] = VERSION;
    id.copy(head, ID_AT);
    this.cipher.check.copy(head, CHECK_AT);
    fs.ftruncateSync(fd, 0);
    writeFull(fd, head, 0);
    this.sync(fd);
    this.ids.set(fd, id);
    return id;
  }

  /** The plain bytes of units `first`..`last` (the last as long as the file allows). */
  readUnits(fd, id, first, last, size) {
    const from = first * UNIT;
    const buf = Buffer.alloc(Math.min((last + 1) * UNIT, size) - from);
    readFull(fd, buf, HEADER + from);
    return this.cipher.crypt(id, first, buf, true);
  }

  /** Reads into `target` from `position`; returns how many bytes there were. */
  read(fd, target, position) {
    const size = this.size(fd);
    if (!target.length || position >= size) return 0;
    const end = Math.min(position + target.length, size);
    const first = Math.floor(position / UNIT);
    const plain = this.readUnits(fd, this.idOf(fd), first, Math.floor((end - 1) / UNIT), size);
    target.set(plain.subarray(position - first * UNIT, end - first * UNIT));
    return end - position;
  }

  /** Writes `data` at `position`. Only a unit the write covers in part is read first, to keep the rest of it. */
  write(fd, data, position) {
    if (!data.length) return 0;
    const id = this.ensureId(fd);
    const size = this.size(fd);
    const end = position + data.length;
    const newSize = Math.max(size, end);
    const first = Math.floor(Math.min(position, size) / UNIT);
    const last = Math.floor((end - 1) / UNIT);
    const from = first * UNIT;
    const to = Math.min((last + 1) * UNIT, newSize);
    const buf = Buffer.alloc(to - from); // zeros, for any gap between the old end and `position`
    const keptTo = Math.min(to, size);
    // The first unit's start (or the old last unit, if writing past the end) and the last unit's end, if they
    // hold old data the write doesn't replace.
    if (position > from && from < size) buf.set(this.readUnits(fd, id, first, first, size));
    if (end < keptTo && (last !== first || position <= from)) {
      buf.set(this.readUnits(fd, id, last, last, size), last * UNIT - from);
    }
    buf.set(data, position - from);
    writeFull(fd, this.cipher.crypt(id, first, buf, false), HEADER + from);
    return data.length;
  }

  /** Changes the file's true size: cutting it re-encrypts the new last unit at its new length; growing adds zeros. */
  truncate(fd, length) {
    const size = this.size(fd);
    if (length > size) {
      this.write(fd, Buffer.alloc(length - size), size);
      return;
    }
    if (length === size) return;
    const id = this.idOf(fd);
    const unit = Math.floor(length / UNIT);
    const keep = length - unit * UNIT;
    const tail = keep ? Buffer.from(this.readUnits(fd, id, unit, unit, size).subarray(0, keep)) : null;
    fs.ftruncateSync(fd, HEADER + length); // keeps the header, and with it the file's id
    if (tail) writeFull(fd, this.cipher.crypt(id, unit, tail, false), HEADER + unit * UNIT);
  }
}

/**
 * Makes Emscripten's NODEFS (the file layer PGlite uses for a real folder) read and write through EncryptedFiles.
 * Everything else (names, folders, renames, deletes, fsync) stays as it is.
 */
export function encryptNodeFS(FS, files) {
  const NODEFS = FS.filesystems.NODEFS;
  const ops = NODEFS.stream_ops;
  const nodeOps = NODEFS.node_ops;
  const io = (f) => NODEFS.tryFSOperation(() => {
    try {
      return f();
    } catch (e) {
      if (e instanceof CipherError) throw new FS.ErrnoError(EIO);
      throw e;
    }
  });

  const getattr = nodeOps.getattr;
  nodeOps.getattr = (node) => {
    const stat = getattr(node);
    if (FS.isFile(stat.mode)) stat.size = logicalSize(stat.size);
    return stat;
  };
  const setattr = nodeOps.setattr;
  nodeOps.setattr = (node, attr) => {
    const { size, ...rest } = attr;
    setattr(node, rest);
    if (size === undefined) return;
    io(() => {
      const fd = fs.openSync(NODEFS.realPath(node), "r+");
      try {
        files.truncate(fd, size);
      } finally {
        files.forget(fd);
        fs.closeSync(fd);
      }
    });
  };

  // Write-only becomes read-write (writing part of a unit means reading the rest of it first), and append is
  // dropped: Emscripten moves to the end itself (through llseek) before an appending write.
  ops.open = (stream) => {
    io(() => {
      if (!FS.isFile(stream.node.mode)) return;
      let flags = stream.flags & ~1024; // O_APPEND
      if ((flags & 3) === 1) flags = (flags & ~3) | 2; // O_WRONLY → O_RDWR
      stream.shared.refcount = 1;
      stream.nfd = fs.openSync(NODEFS.realPath(stream.node), NODEFS.flagsForNode(flags));
    });
  };
  const close = ops.close;
  ops.close = (stream) => {
    if (FS.isFile(stream.node.mode) && stream.nfd && stream.shared.refcount === 1) files.forget(stream.nfd);
    close(stream);
  };
  ops.read = (stream, buffer, offset, length, position) => {
    if (length === 0) return 0;
    return io(() => files.read(stream.nfd, buffer.subarray(offset, offset + length), position));
  };
  ops.write = (stream, buffer, offset, length, position) => {
    if (length === 0) return 0;
    return io(() => files.write(stream.nfd, buffer.subarray(offset, offset + length), position));
  };
  const llseek = ops.llseek;
  ops.llseek = (stream, offset, whence) => {
    if (whence !== 2 || !FS.isFile(stream.node.mode)) return llseek(stream, offset, whence);
    const position = offset + io(() => files.size(stream.nfd));
    if (position < 0) throw new FS.ErrnoError(28);
    return position;
  };
}

/** The durable file layer (durable-fs.mjs) with every file encrypted with `dataKey`. */
export class SecureNodeFS extends DurableNodeFS {
  constructor(dataDir, dataKey, sync = fs.fsyncSync) {
    super(dataDir, sync);
    this.files = new EncryptedFiles(fileCipher(dataKey), sync);
  }

  async init(pg, opts) {
    const result = await super.init(pg, opts);
    const files = this.files;
    result.emscriptenOpts.preRun = [...result.emscriptenOpts.preRun, (mod) => encryptNodeFS(mod.FS, files)];
    return result;
  }
}

// ---------------------------------------------------------------- whole folders

/** Whether a database folder is "missing", "plain" (from before encryption), or "encrypted". */
export function folderState(dir) {
  const marker = path.join(dir, "PG_VERSION");
  if (!fs.existsSync(marker)) return "missing";
  const head = Buffer.alloc(MAGIC.length);
  const fd = fs.openSync(marker, "r");
  try {
    return fs.readSync(fd, head, 0, head.length, 0) === head.length && head.equals(MAGIC) ? "encrypted" : "plain";
  } finally {
    fs.closeSync(fd);
  }
}

/** Whether an encrypted folder's files were encrypted with this key (checked on PG_VERSION's header). */
export function folderKeyMatches(dir, dataKey) {
  const files = new EncryptedFiles(fileCipher(dataKey));
  const fd = fs.openSync(path.join(dir, "PG_VERSION"), "r");
  try {
    files.idOf(fd);
    return true;
  } catch (e) {
    if (e instanceof CipherError) return false;
    throw e;
  } finally {
    fs.closeSync(fd);
  }
}

function walk(dir, rel = "") {
  const out = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push({ rel: r, dir: true }, ...walk(dir, r));
    else if (entry.isFile()) out.push({ rel: r, dir: false });
  }
  return out;
}

/** Fsyncs a folder's entry list (Windows can't open a folder for that; there, renames are already journaled). */
function syncDir(dir) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/**
 * Copies an unencrypted database folder (`src`, closed) into a new encrypted one (`dst`, which mustn't exist),
 * flushing every file, then reads each one back and compares it with the original. Throws if anything differs;
 * `src` is never changed.
 */
export function encryptFolder(src, dst, dataKey) {
  if (fs.existsSync(dst)) throw new Error(`${dst} already exists`);
  const files = new EncryptedFiles(fileCipher(dataKey));
  const entries = walk(src);
  fs.mkdirSync(dst);
  const CHUNK = 1024 * UNIT;
  for (const { rel, dir } of entries) {
    const to = path.join(dst, rel);
    if (dir) { fs.mkdirSync(to); continue; }
    const from = fs.openSync(path.join(src, rel), "r");
    const fd = fs.openSync(to, "wx+");
    try {
      const size = fs.fstatSync(from).size;
      files.ensureId(fd);
      const buf = Buffer.alloc(CHUNK);
      for (let at = 0; at < size; at += CHUNK) {
        const n = Math.min(CHUNK, size - at);
        readFull(from, buf.subarray(0, n), at);
        files.write(fd, buf.subarray(0, n), at);
      }
      fs.fsyncSync(fd);
    } finally {
      files.forget(fd);
      fs.closeSync(fd);
      fs.closeSync(from);
    }
  }
  for (const { rel, dir } of entries) if (dir) syncDir(path.join(dst, rel));
  syncDir(dst);
  verifyFolder(src, dst, dataKey);
}

/** Throws unless every file in `encrypted` decrypts to exactly the same bytes as in `plain`, and none is missing. */
export function verifyFolder(plain, encrypted, dataKey) {
  const files = new EncryptedFiles(fileCipher(dataKey));
  const want = walk(plain), got = walk(encrypted);
  const names = (list) => list.map((e) => `${e.dir ? "d" : "f"}:${e.rel}`).sort().join("\n");
  if (names(want) !== names(got)) throw new Error("The encrypted copy's files don't match the original's");
  for (const { rel, dir } of want) {
    if (dir) continue;
    const original = fs.readFileSync(path.join(plain, rel));
    const fd = fs.openSync(path.join(encrypted, rel), "r");
    try {
      if (files.size(fd) !== original.length) throw new Error(`${rel}: the encrypted copy has the wrong size`);
      const back = Buffer.alloc(original.length);
      files.read(fd, back, 0);
      if (!back.equals(original)) throw new Error(`${rel}: the encrypted copy doesn't read back the same`);
    } finally {
      files.forget(fd);
      fs.closeSync(fd);
    }
  }
}
