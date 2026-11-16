// SPDX-License-Identifier: AGPL-3.0-only
// Model proxy: agents call their model through CircleChat, so provider keys never
// enter a sandbox. Each running agent gets its own token; the engine is pointed at
//   <base>/llm/<token>/v1/...         OpenAI-compatible and OpenAI providers
//   <base>/llm/<token>/anthropic/...  Anthropic
// and this proxy adds the real key and forwards to the provider's own address only.
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import type { ModelProvider } from "./engines.ts";

interface Grant {
  agentId: string;
  provider: ModelProvider;
}

const DEFAULT_BASE: Record<ModelProvider["kind"], string> = {
  "openai-compatible": "",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
};
// never forwarded upstream: the agent's stand-in token, hop-by-hop headers, and anything that names this server
const DROP = new Set(["authorization", "x-api-key", "api-key", "host", "connection", "content-length", "accept-encoding", "cookie", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"]);
const DROP_BACK = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie"]);
export const LLM_ROUTE = /^\/llm\/([A-Za-z0-9_-]{20,})\/(v1|anthropic)(\/[^?#]*)?(\?[^#]*)?$/;

export class ModelProxy {
  private grants = new Map<string, Grant>();

  /** The provider an engine should see: same models, our address, a stand-in token. */
  wrap(agentId: string, provider: ModelProvider, base: string): { provider: ModelProvider; token: string } {
    const token = "ccm_" + randomBytes(24).toString("base64url");
    this.grants.set(token, { agentId, provider });
    const root = `${base.replace(/\/+$/, "")}/llm/${token}`;
    return {
      token,
      provider: {
        ...provider,
        apiKey: token,
        baseUrl: provider.kind === "anthropic" ? `${root}/anthropic` : `${root}/v1`,
      },
    };
  }

  revoke(token: string | undefined): void {
    if (token) this.grants.delete(token);
  }

  revokeAgent(agentId: string): void {
    for (const [t, g] of this.grants) if (g.agentId === agentId) this.grants.delete(t);
  }

  /** Where a proxied request goes. Exported for tests. */
  upstream(provider: ModelProvider, flavour: "v1" | "anthropic", rest: string, query = ""): string {
    // providers saved with the address containers use (host.docker.internal) are on this machine
    let base = (provider.baseUrl || DEFAULT_BASE[provider.kind]).replace(/\/+$/, "").replace("//host.docker.internal", "//127.0.0.1");
    if (!base) throw new Error("this provider has no address");
    if (rest.split("/").some((s) => s === ".." || s === ".")) throw new Error("bad path");
    // Anthropic clients ask for /v1/messages themselves; a stored base may already end in /v1
    if (flavour === "anthropic" && /\/v1$/.test(base) && rest.startsWith("/v1/")) base = base.slice(0, -3);
    const url = new URL(base + rest + query);
    if (url.host !== new URL(base).host) throw new Error("requests must stay on the provider");
    return url.toString();
  }

  /** Handles /llm/<token>/... Returns false for other urls. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const m = (req.url ?? "").match(LLM_ROUTE);
    if (!m) return false;
    const g = this.grants.get(m[1]);
    if (!g) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "This model token is not valid. Restart the agent.", type: "invalid_token" } }));
      return true;
    }
    const flavour = m[2] as "v1" | "anthropic";
    let target: string;
    try {
      target = this.upstream(g.provider, flavour, m[3] ?? "", m[4] ?? "");
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: (e as Error).message } }));
      return true;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROP.has(k) && typeof v === "string") headers[k] = v;
    if (g.provider.apiKey) {
      if (g.provider.kind === "anthropic") headers["x-api-key"] = g.provider.apiKey;
      else headers.authorization = `Bearer ${g.provider.apiKey}`;
    }
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readAll(req);
    let up: Response;
    try {
      up = await fetch(target, { method: req.method, headers, body: body ? new Uint8Array(body) : undefined, redirect: "manual", signal: AbortSignal.timeout(15 * 60_000) });
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `Couldn't reach the model provider: ${(e as Error).message}` } }));
      return true;
    }
    const back: Record<string, string> = {};
    up.headers.forEach((v, k) => {
      if (!DROP_BACK.has(k)) back[k] = v;
    });
    res.writeHead(up.status, back);
    if (!up.body) {
      res.end();
      return true;
    }
    const stream = Readable.fromWeb(up.body as any);
    req.on("close", () => stream.destroy());
    stream.on("error", () => res.end());
    stream.pipe(res);
    return true;
  }
}

function readAll(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
