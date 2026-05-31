// Minimal static file server with SPA fallback, used to serve web/dist so
// Lighthouse can load client-routed pages like /login and /signup.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json; charset=utf-8",
};

export async function serveStatic(root, port = 4180) {
  const server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      let filePath = join(root, normalize(urlPath));
      if (!filePath.startsWith(root)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      let s = await stat(filePath).catch(() => null);
      if (s && s.isDirectory()) {
        filePath = join(filePath, "index.html");
        s = await stat(filePath).catch(() => null);
      }
      // SPA fallback: unknown non-asset routes (e.g. /login) -> index.html
      if (!s) {
        if (extname(urlPath)) {
          res.writeHead(404).end("not found");
          return;
        }
        filePath = join(root, "index.html");
      }
      const body = await readFile(filePath);
      res.writeHead(200, { "content-type": MIME[extname(filePath)] || "application/octet-stream" });
      res.end(body);
    } catch (e) {
      res.writeHead(500).end(String(e?.message || e));
    }
  });
  await new Promise((resolve) => server.listen(port, resolve));
  return {
    url: `http://localhost:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
