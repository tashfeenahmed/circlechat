// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const target = "http://127.0.0.1:3150";
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api": { target, changeOrigin: false },
      "/ws": { target: target.replace("http", "ws"), ws: true },
      "/mcp": { target },
      "/hooks": { target },
    },
  },
});
