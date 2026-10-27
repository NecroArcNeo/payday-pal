// The only things the page can reach in the desktop app: the database and the backup files.
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
  backups: {
    add: (record) => call("backups:add", record),
    get: (id) => call("backups:get", id),
    list: () => call("backups:list"),
    remove: (ids) => call("backups:delete", ids),
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
