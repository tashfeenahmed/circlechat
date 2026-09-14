import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        // One 920 KB chunk meant every deploy invalidated the whole bundle,
        // even though react/router/query/markdown barely move between
        // releases. Splitting the stable dependencies out lets a returning
        // visitor reuse them from cache and only re-download app code.
        //
        // Grouped rather than one-chunk-per-package: a few large, long-lived
        // chunks parallelise well and keep the request count sane, whereas
        // hundreds of tiny vendor files cost more in round-trips than they
        // save in bytes.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "vendor-react";
          if (/[\\/]node_modules[\\/](react-router|react-router-dom|@remix-run)[\\/]/.test(id)) return "vendor-router";
          if (/[\\/]node_modules[\\/]@tanstack[\\/]/.test(id)) return "vendor-query";
          if (/[\\/]node_modules[\\/](markdown-it|dompurify|entities|linkify-it|mdurl|uc\.micro|punycode)/.test(id))
            return "vendor-markdown";
          if (/[\\/]node_modules[\\/](lucide-react|@base-ui)[\\/]/.test(id)) return "vendor-ui";
          return "vendor";
        },
      },
    },
  },
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
