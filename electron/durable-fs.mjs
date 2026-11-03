// PGlite's file layer for a real folder (Emscripten's NODEFS) has no fsync: when Postgres flushes a write to
// disk (its write-ahead log at every commit, data files at checkpoints), nothing happens, and the write sits in
// Windows' cache until Windows gets round to it. A crashed or killed app loses nothing (Windows still writes it),
// but a power cut or system crash could lose recent commits, or keep data pages without the log that explains
// them. This adds the missing fsync, so a change the app reports saved is on the disk. Use it with
// DURABLE_START_PARAMS: PGlite also tells Postgres not to flush at all.
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { NodeFS } from "@electric-sql/pglite/nodefs";

/**
 * PGlite starts Postgres with -F (fsync off); without it, Postgres flushes its log at every commit. Its default
 * flush for the log, fdatasync, is an empty stub in Emscripten, so it uses fsync, which reaches the file layer below.
 */
export const DURABLE_START_PARAMS = [...PGlite.defaultStartParams.filter((p) => p !== "-F"), "-c", "wal_sync_method=fsync"];

/**
 * Files dated before this are taken to have PGlite's wrong date (below). Nothing in a database folder is really
 * that old.
 */
const BEFORE_2000 = Date.UTC(2000, 0, 1);

/**
 * Gives files dated in 1970 today's date. PGlite unpacks a new database with each file's date given in seconds
 * where Emscripten's file layer expects milliseconds, so they're dated January 1970. Anything that tidies up
 * "old" files (Windows' temp-file cleanup did, on test folders) or backs up only recently changed ones would then
 * delete or skip most of the database. Postgres doesn't read file dates, so changing them is safe.
 * Returns how many files it fixed.
 */
export function repairFileDates(dir) {
  if (!fs.existsSync(dir)) return 0;
  const now = new Date();
  let fixed = 0;
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const file = path.join(e.parentPath, e.name);
    if (fs.statSync(file).mtimeMs >= BEFORE_2000) continue;
    fs.utimesSync(file, now, now);
    fixed++;
  }
  return fixed;
}

/** EIO: Postgres stops rather than carry on as if a failed flush had worked. */
const EIO = 29;

export class DurableNodeFS extends NodeFS {
  /** `sync` is fs.fsyncSync; tests pass their own to count calls. */
  constructor(dataDir, sync = fs.fsyncSync) {
    super(dataDir);
    this.sync = sync;
  }

  async init(pg, opts) {
    repairFileDates(this.rootDir); // a folder made before this fix
    const result = await super.init(pg, opts);
    const sync = this.sync;
    const preRun = result.emscriptenOpts.preRun ?? [];
    result.emscriptenOpts.preRun = [...preRun, (mod) => {
      // Setting a file's dates comes only from PGlite unpacking a new database (Postgres never does it), and it
      // gets them wrong (repairFileDates): leave them out, so each file keeps the real time it was written.
      const nodeOps = mod.FS.filesystems.NODEFS.node_ops;
      const setattr = nodeOps.setattr;
      nodeOps.setattr = (node, attr) => {
        const { atime, mtime, timestamp, ...rest } = attr;
        return setattr(node, rest);
      };
      const ops = mod.FS.filesystems.NODEFS.stream_ops;
      ops.fsync = (stream) => {
        if (stream.nfd == null) return 0;
        try {
          sync(stream.nfd);
        } catch {
          throw new mod.FS.ErrnoError(EIO);
        }
        return 0;
      };
    }];
    return result;
  }
}
