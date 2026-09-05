import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      // The API mounts every route under /api (the prefix Caddy proxies in
      // production), so the path is forwarded untouched. Stripping it made
      // `npm run dev` hit the API's SPA fallback and get index.html for every call.
      "/api": { target: "http://localhost:3000", changeOrigin: true },
      "/events": { target: "ws://localhost:3000", ws: true, changeOrigin: true },
      "/agent-socket": { target: "ws://localhost:3000", ws: true, changeOrigin: true },
    },
  },
  preview: {
    port: 8080,
  },
});
