import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";

// The app is the desktop window's pages only: a static single-page build (one HTML shell plus assets in dist/client),
// served by Electron at app://meridian/. There's no web server; the cloud is reached straight from the page.
export default defineConfig({
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
  plugins: [
    tailwindcss(),
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tanstackStart({ spa: { enabled: true } }),
    viteReact(),
  ],
});
