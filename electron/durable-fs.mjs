// PGlite's file layer for a real folder (Emscripten's NODEFS) has no fsync: when Postgres flushes a write to
// disk (its write-ahead log at every commit, data files at checkpoints), nothing happens, and the write sits in
// Windows' cache until Windows gets round to it. A crashed or killed app loses nothing (Windows still writes it),
// but a power cut or system crash could lose recent commits, or keep data pages without the log that explains
// them. This adds the missing fsync, so a change the app reports saved is on the disk. Use it with
// DURABLE_START_PARAMS: PGlite also tells Postgres not to flush at all.
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { NodeFS } from "@electric-sql/pglite/nodefs";

/**
 * PGlite starts Postgres with -F (fsync off); without it, Postgres flushes its log at every commit. Its default
 * flush for the log, fdatasync, is an empty stub in Emscripten, so it uses fsync, which reaches the file layer below.
 */
export const DURABLE_START_PARAMS = [...PGlite.defaultStartParams.filter((p) => p !== "-F"), "-c", "wal_sync_method=fsync"];

/** EIO: Postgres stops rather than carry on as if a failed flush had worked. */
const EIO = 29;

export class DurableNodeFS extends NodeFS {
  /** `sync` is fs.fsyncSync; tests pass their own to count calls. */
  constructor(dataDir, sync = fs.fsyncSync) {
    super(dataDir);
    this.sync = sync;
  }

  async init(pg, opts) {
    const result = await super.init(pg, opts);
    const sync = this.sync;
    const preRun = result.emscriptenOpts.preRun ?? [];
    result.emscriptenOpts.preRun = [...preRun, (mod) => {
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
