// The only things the page can reach in the desktop app: the database, the backup files and the lock.
// Typed for the page in src/lib/desktop.ts.
const { contextBridge, ipcRenderer } = require("electron");

/** Calls the main process and turns its plain error back into a thrown Error with the same message. */
async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (r.ok) return r.value;
  throw new Error(r.message);
}

contextBridge.exposeInMainWorld("meridianDesktop", {
  db: {
    query: (sql, params, txId) => call("db:query", sql, params ?? [], txId ?? null),
    exec: (sql, txId) => call("db:exec", sql, txId ?? null),
    begin: () => call("db:begin"),
    end: (txId, commit) => call("db:end", txId, commit),
    setAside: () => call("db:set-aside"),
  },
  scratch: {
    open: () => call("scratch:open"),
    query: (sql, params, txId) => call("scratch:query", sql, params ?? [], txId ?? null),
    exec: (sql, txId) => call("scratch:exec", sql, txId ?? null),
    begin: () => call("scratch:begin"),
    end: (txId, commit) => call("scratch:end", txId, commit),
    close: () => call("scratch:close"),
  },
  backups: {
    add: (record) => call("backups:add", record),
    get: (id) => call("backups:get", id),
    list: () => call("backups:list"),
    remove: (ids) => call("backups:delete", ids),
  },
  security: {
    status: () => call("security:status"),
    unlock: (password) => call("security:unlock", password),
    recover: (recoveryKey, newPassword) => call("security:recover", recoveryKey, newPassword),
    recoverWithCloud: (escrowKey, newPassword) => call("security:recover-cloud", escrowKey, newPassword),
    setPassword: (current, next) => call("security:set-password", current, next),
    removePassword: (current) => call("security:remove-password", current),
    newRecoveryKey: (current) => call("security:new-recovery-key", current),
    enableCloudReset: (current) => call("security:enable-cloud-reset", current),
    disableCloudReset: () => call("security:disable-cloud-reset"),
    startOver: () => call("security:start-over"),
  },
  backupCopy: {
    status: () => call("backup-copy:status"),
    choose: () => call("backup-copy:choose"),
    check: (folder) => call("backup-copy:check", folder),
    set: (choice) => call("backup-copy:set", choice),
    off: () => call("backup-copy:off"),
    now: () => call("backup-copy:now"),
  },
  info: () => call("desktop:info"),
  session: () => call("desktop:session"),
  openFolder: (which) => call("desktop:open-folder", which),
  onClosing: (beforeClose) => {
    ipcRenderer.removeAllListeners("app:closing");
    ipcRenderer.on("app:closing", () => {
      Promise.resolve().then(beforeClose).catch(() => {}).finally(() => ipcRenderer.send("app:close-ready"));
    });
    ipcRenderer.send("app:close-watch");
  },
});
