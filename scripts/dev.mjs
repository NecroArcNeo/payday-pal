// `npm run dev`: the Vite dev server (hot reload) and the desktop window showing it. The window's data lives in
// .dev-data in this folder (git-ignored), never in the installed app's folder, so testing can't touch real payroll
// data. Closing the window stops both. `npm run dev:web` is the dev server alone.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const PORT = 8080;
const URL = `http://localhost:${PORT}`;

const answering = () => fetch(URL).then(() => true, () => false);
// A dev server already running (another terminal) is used as it is; otherwise this starts one and stops it after.
const vite = (await answering()) ? null
  : spawn(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "dev", "--port", String(PORT), "--strictPort"], { cwd: root, stdio: "inherit" });
const stop = (code = 0) => {
  vite?.kill();
  process.exit(code);
};
vite?.on("exit", (code) => process.exit(code ?? 1));

// Wait for the dev server to answer before opening the window.
for (let i = 0; !(await answering()); i++) {
  if (i > 120) { console.error(`The dev server didn't start on ${URL}`); stop(1); }
  await new Promise((r) => setTimeout(r, 500));
}

const electron = spawn(require("electron"), [root], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, MERIDIAN_DEV_URL: URL, MERIDIAN_HOME: process.env.MERIDIAN_HOME ?? path.join(root, ".dev-data") },
});
electron.on("exit", (code) => stop(code ?? 0));
process.on("SIGINT", () => { electron.kill(); stop(0); });
