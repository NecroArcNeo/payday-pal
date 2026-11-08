import { createStart } from "@tanstack/react-start";

// TanStack Start's options. The app is a static single-page build with no server (see vite.config.ts), so there's no
// request or server-function middleware.
export const startInstance = createStart(() => ({}));
