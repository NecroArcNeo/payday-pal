import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { nitro } from "nitro/vite";

export default defineConfig(({ command, mode }) => ({
  server: {
    host: "::", port: 8080,
    // npm run dev's desktop window keeps its data in .dev-data (database, Chromium's files): not source, and some are
    // held open, which crashed the file watcher (EBUSY). release/ is the installer output.
    watch: { ignored: ["**/.dev-data/**", "**/release/**"] },
  },
  resolve: {
    alias: { "@": `${process.cwd()}/src` },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
  },
  // PGlite loads its own WebAssembly and data files; pre-bundling breaks those paths in dev.
  optimizeDeps: { exclude: ["@electric-sql/pglite"] },
  plugins: [
    tailwindcss(),
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tanstackStart({
      // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
      server: { entry: "server" },
      // `--mode desktop`: a static single-page build (one HTML shell plus assets) for the desktop app.
      ...(mode === "desktop" ? { spa: { enabled: true } } : {}),
      importProtection: {
        behavior: "error",
        client: { files: ["**/server/**"], specifiers: ["server-only"] },
      },
    }),
    // Build a standalone Node server (.output/server/index.mjs) for running locally.
    ...(command === "build" && mode !== "desktop" ? [nitro({ preset: "node-server" })] : []),
    viteReact(),
  ],
}));
