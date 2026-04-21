import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") },
      "/events": { target: "ws://localhost:3000", ws: true, changeOrigin: true },
      "/agent-socket": { target: "ws://localhost:3000", ws: true, changeOrigin: true },
    },
  },
  preview: {
    port: 8080,
  },
});
