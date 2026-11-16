// SPDX-License-Identifier: AGPL-3.0-only
// Test harness: a real App + HTTP server on a random port, a cookie-aware client,
// and small fake upstreams (GitHub, a JSON API, Slack).
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { App, newMasterKey } from "../server/src/app.ts";
import { createHttpServer } from "../server/src/server.ts";

export interface Harness {
  app: App;
  url: string;
  dir: string;
  close(): Promise<void>;
}

export async function startApp(opts: { idleSleepMs?: number; approvalTtlMs?: number; turnTimeoutMs?: number; baseDir?: string; trustProxy?: boolean } = {}): Promise<Harness> {
  if (opts.baseDir) mkdirSync(opts.baseDir, { recursive: true });
  const dir = mkdtempSync(join(opts.baseDir ?? tmpdir(), "cc-test-"));
  const app = new App({ dataDir: dir, masterKey: newMasterKey(), idleSleepMs: opts.idleSleepMs ?? 0, approvalTtlMs: opts.approvalTtlMs ?? 60_000, turnTimeoutMs: opts.turnTimeoutMs ?? 30_000, trustProxy: opts.trustProxy });
  const server = createHttpServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  app.gateway.publicUrl = `http://127.0.0.1:${port}`;
  app.start();
  return {
    app,
    url: `http://127.0.0.1:${port}`,
    dir,
    async close() {
      await app.runtime.shutdown();
      await app.gateway.closeAll();
      for (const b of app.bridges.values()) b.stop();
      app.triggers.stop();
      await new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections?.();
      try {
        app.db.close();
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export class Client {
  cookie = "";
  base: string;
  constructor(base: string) {
    this.base = base;
  }
  async req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const r = await fetch(this.base + path, {
      method,
      headers: { "content-type": "application/json", ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0];
    const text = await r.text();
    let json: any = text;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, json };
  }
  get = (p: string) => this.req("GET", p);
  post = (p: string, b?: unknown) => this.req("POST", p, b ?? {});
  put = (p: string, b?: unknown) => this.req("PUT", p, b ?? {});
  patch = (p: string, b?: unknown) => this.req("PATCH", p, b ?? {});
  del = (p: string) => this.req("DELETE", p);
}

export async function waitFor<T>(fn: () => T | Promise<T>, what: string, timeoutMs = 15_000, every = 50): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error(`timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 300)})`);
}

/** A tiny fake HTTP upstream that records requests and answers from a handler. */
export async function fakeServer(handler: (req: { method: string; url: string; headers: any; body: any }) => { status?: number; body?: any }): Promise<{ url: string; calls: any[]; close(): Promise<void>; server: Server }> {
  const calls: any[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = raw;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {}
      const call = { method: req.method!, url: req.url!, headers: req.headers, body };
      calls.push(call);
      const out = handler(call);
      res.writeHead(out.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(out.body ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, calls, server, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

/** Owner + workspace set up, returns a signed-in client. */
export async function setupOwner(h: Harness): Promise<Client> {
  const c = new Client(h.url);
  const r = await c.post("/api/setup", { email: "tash@lumen.test", name: "Tash", password: "correct horse battery", workspace: "Lumen" });
  if (r.status !== 200) throw new Error("setup failed: " + JSON.stringify(r.json));
  return c;
}

export async function mockAgent(c: Client, handle: string, extra: Record<string, unknown> = {}): Promise<any> {
  const r = await c.post("/api/agents", { name: handle[0].toUpperCase() + handle.slice(1), handle, engine: "mock", sandbox: "local", roleTitle: "Tester", ...extra });
  if (r.status !== 200) throw new Error("agent create failed: " + JSON.stringify(r.json));
  return r.json.agent;
}

/** Wait for the next agent message in a chat after a given timestamp. */
/** Waits for the agent's answer. Fails at once if the turn failed (CircleChat posts an error card for it). */
export async function agentReply(c: Client, chatId: string, agentId: string, after: number, timeoutMs = 15_000): Promise<any> {
  const found = await waitFor(async () => {
    const r = await c.get(`/api/chats/${chatId}/messages`);
    const msgs = (r.json.messages as any[]).filter((m) => m.ts > after);
    return (
      msgs.find((m) => m.authorType === "agent" && m.authorId === agentId && !m.meta?.interim && m.kind === "text") ??
      msgs.find((m) => m.kind === "error" && m.meta?.agentId === agentId)
    );
  }, `reply from ${agentId}`, timeoutMs);
  if (found.kind === "error") throw new Error(`turn failed: ${found.body}`);
  return found;
}
