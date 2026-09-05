import { config } from "./config.js";

// Guard for process-internal HTTP endpoints (currently /_internal/agent-dispatch,
// which the worker uses to reach a connected agent socket). They carry no user
// auth, so they must only ever be callable from inside the deployment. Two ways
// to qualify:
//   1. `x-internal-token` equal to SESSION_SECRET (api + worker already share
//      it) — the explicit, proxy-agnostic path; or
//   2. the TCP peer is a loopback/private address AND the request did not come
//      through a proxy hop (no X-Forwarded-For / X-Real-IP). Caddy always adds
//      X-Forwarded-For, so a public client can't reach it through the edge,
//      and a public client hitting the port directly has a public peer address.
// Before this, in the single-port deploy (API serving the web bundle — which is
// why the SPA 404 handler special-cases /_internal/) anyone on the internet
// could push arbitrary heartbeat/event packets to any connected agent by id.

export function isPrivateAddress(ip: string | undefined | null): boolean {
  if (!ip) return false;
  const v = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (v === "127.0.0.1" || v === "::1" || v === "localhost") return true;
  if (/^127\./.test(v)) return true;
  if (/^10\./.test(v)) return true;
  if (/^192\.168\./.test(v)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v)) return true;
  if (/^169\.254\./.test(v)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(v)) return true; // fc00::/7 (unique local)
  if (/^fe[89ab][0-9a-f]:/i.test(v)) return true; // fe80::/10 (link local)
  return false;
}

export interface InternalRequestLike {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
  raw?: { socket?: { remoteAddress?: string } };
}

export function isInternalRequest(req: InternalRequestLike, secret: string = config.sessionSecret): boolean {
  const token = req.headers["x-internal-token"];
  if (typeof token === "string" && token.length > 0 && secret && token === secret) return true;
  const forwarded = req.headers["x-forwarded-for"] ?? req.headers["x-real-ip"];
  if (forwarded) return false;
  const peer = req.raw?.socket?.remoteAddress ?? req.socket?.remoteAddress;
  return isPrivateAddress(peer);
}
