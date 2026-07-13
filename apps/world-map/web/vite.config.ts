import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The World runtime dev server (see apps/world-map/src/WorldMap.Api launchSettings).
const WORLD_API = process.env.WORLD_API_ORIGIN ?? "http://localhost:5266";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    // Proxy the federation API + health probes to the ASP.NET host during dev.
    // "/world" covers /world/v1/* including the SSE stream at /world/v1/stream.
    proxy: {
      "/world": { target: WORLD_API, changeOrigin: true },
      "/health": { target: WORLD_API, changeOrigin: true },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    css: false,
    exclude: ["node_modules/**", "dist/**"],
  },
});
