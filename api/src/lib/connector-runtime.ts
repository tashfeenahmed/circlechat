import type { connectors } from "../db/schema.js";
import { decryptSecret } from "./secret-box.js";
import { resolveWorkflowTemplate } from "./workflow-definition.js";

type Connector = typeof connectors.$inferSelect;
type ConnectorSecret = {
  bearerToken?: string;
  oauthAccessToken?: string;
  headers?: Record<string, string>;
};

export interface ConnectorInvocation {
  operation?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  input: Record<string, unknown>;
  steps: Record<string, unknown>;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;

function connectorHeaders(connector: Connector): Headers {
  const headers = new Headers({ accept: "application/json" });
  const configHeaders = (connector.configJson.headers ?? {}) as Record<string, unknown>;
  for (const [name, value] of Object.entries(configHeaders)) {
    if (typeof value === "string") headers.set(name, value);
  }
  if (!connector.secretCiphertext) return headers;
  const secret = decryptSecret<ConnectorSecret>(connector.secretCiphertext);
  for (const [name, value] of Object.entries(secret.headers ?? {})) headers.set(name, value);
  const token = secret.oauthAccessToken ?? secret.bearerToken;
  if (token) headers.set("authorization", `Bearer ${token}`);
  return headers;
}

function connectorUrl(connector: Connector, path = "", query?: ConnectorInvocation["query"]): URL {
  const base = new URL(connector.baseUrl);
  if (!/^https?:$/.test(base.protocol) || base.username || base.password) throw new Error("connector_url_invalid");
  const url = path ? new URL(path.replace(/^\/+/, ""), base.toString().replace(/\/?$/, "/")) : base;
  // A workflow may select a path, never a second host.
  if (url.origin !== base.origin) throw new Error("connector_cross_origin_path");
  for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, String(value));
  return url;
}

export async function invokeConnector(
  connector: Connector,
  invocation: ConnectorInvocation,
): Promise<{ status: number; headers: Record<string, string>; data: unknown }> {
  if (connector.status === "disabled") throw new Error("connector_disabled");
  const ctx = { input: invocation.input, steps: invocation.steps };
  const resolved = resolveWorkflowTemplate(
    {
      path: invocation.path ?? "",
      query: invocation.query ?? {},
      body: invocation.body,
      headers: invocation.headers ?? {},
      operation: invocation.operation,
    },
    ctx,
  ) as {
    path: string;
    query: Record<string, string | number | boolean>;
    body: unknown;
    headers: Record<string, string>;
    operation?: string;
  };

  const headers = connectorHeaders(connector);
  for (const [name, value] of Object.entries(resolved.headers ?? {})) headers.set(name, String(value));
  const controller = new AbortController();
  const configuredTimeout = Number(connector.configJson.timeoutMs ?? 30_000);
  const timeoutMs = Math.max(1_000, Math.min(120_000, configuredTimeout || 30_000));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    if (connector.kind === "mcp") {
      headers.set("content-type", "application/json");
      headers.set("accept", "application/json, text/event-stream");
      response = await fetch(connectorUrl(connector, resolved.path).toString(), {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `cc-${Date.now()}`,
          method: "tools/call",
          params: { name: resolved.operation, arguments: resolved.body ?? {} },
        }),
      });
    } else {
      const method = String(invocation.method ?? "POST").toUpperCase();
      const permitsBody = method !== "GET" && method !== "HEAD";
      if (permitsBody && resolved.body !== undefined) headers.set("content-type", "application/json");
      response = await fetch(connectorUrl(connector, resolved.path, resolved.query).toString(), {
        method,
        headers,
        signal: controller.signal,
        redirect: "manual",
        body: permitsBody && resolved.body !== undefined ? JSON.stringify(resolved.body) : undefined,
      });
    }
  } finally {
    clearTimeout(timeout);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_RESPONSE_BYTES) throw new Error("connector_response_too_large");
  const text = bytes.toString("utf8");
  let data: unknown = text;
  if (text) {
    try { data = JSON.parse(text); } catch { /* text response */ }
  } else data = null;
  if (!response.ok) throw new Error(`connector_http_${response.status}:${text.slice(0, 300)}`);
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), data };
}

export async function checkConnector(connector: Connector): Promise<{ ok: boolean; error?: string }> {
  try {
    if (connector.kind === "mcp") {
      const headers = connectorHeaders(connector);
      headers.set("content-type", "application/json");
      headers.set("accept", "application/json, text/event-stream");
      const response = await fetch(connectorUrl(connector).toString(), {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: "cc-health", method: "tools/list", params: {} }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`http_${response.status}`);
    } else {
      const path = typeof connector.configJson.healthPath === "string" ? connector.configJson.healthPath : "";
      const response = await fetch(connectorUrl(connector, path).toString(), {
        method: "GET",
        headers: connectorHeaders(connector),
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`http_${response.status}`);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message.slice(0, 300) };
  }
}
