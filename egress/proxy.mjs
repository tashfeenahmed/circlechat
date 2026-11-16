// SPDX-License-Identifier: AGPL-3.0-only
// The agents' only way out: an HTTP proxy that lets through CircleChat itself and the
// hosts on the allow list, and nothing else. Agent containers sit on a Docker network
// with no route out, so traffic that ignores the proxy simply fails.
//   ALWAYS  host:port pairs that are always allowed (CircleChat's tool gateway and model proxy)
//   ALLOW   comma-separated hosts; "*.example.com" matches subdomains; ports 80 and 443 only
import http from "node:http";
import net from "node:net";

const always = new Set((process.env.ALWAYS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
const allow = (process.env.ALLOW ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const PORT = Number(process.env.PORT ?? 3128);

function allowed(host, port) {
  host = String(host).toLowerCase().replace(/^\[|\]$/g, "");
  if (always.has(`${host}:${port}`)) return true;
  if (port !== 80 && port !== 443) return false;
  return allow.some((a) => (a.startsWith("*.") ? host.endsWith(a.slice(1)) || host === a.slice(2) : host === a));
}
const deny = (what) => console.log(`${new Date().toISOString()} blocked ${what}`);

const server = http.createServer((req, res) => {
  // plain HTTP: the client sends an absolute URL
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return void res.writeHead(400).end("absolute URL expected\n");
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (url.protocol !== "http:" || !allowed(url.hostname, port)) {
    deny(`${req.method} ${url.hostname}:${port}`);
    return void res.writeHead(403, { "content-type": "text/plain" }).end(`CircleChat blocked ${url.hostname}: not on this workspace's allow list\n`);
  }
  const headers = { ...req.headers };
  delete headers["proxy-connection"];
  delete headers["proxy-authorization"];
  const up = http.request({ host: url.hostname, port, method: req.method, path: url.pathname + url.search, headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", (e) => (res.headersSent ? res.end() : res.writeHead(502).end(`${e.message}\n`)));
  req.pipe(up);
});

// HTTPS and other TLS: CONNECT host:port, then a raw tunnel
server.on("connect", (req, socket, head) => {
  const [host, p] = String(req.url).split(/:(?=\d+$)/);
  const port = Number(p || 443);
  if (!allowed(host, port)) {
    deny(`CONNECT ${host}:${port}`);
    return void socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  }
  const up = net.connect(port, host, () => {
    socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
  socket.on("error", () => up.destroy());
});

server.listen(PORT, () => console.log(`egress filter on :${PORT}; always ${[...always].join(" ") || "-"}; allow ${allow.join(" ") || "-"}`));
