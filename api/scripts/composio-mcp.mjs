#!/usr/bin/env node
// Composio MCP stdio server. Exposes the workspace's connected SaaS tools
// (Gmail, GitHub, Slack, CRMs, …) to an agent runtime as three meta-tools:
// discover (composio_list_tools), run (composio_execute), and inspect
// connections (composio_connections).
//
// Dependency-free by design — it only speaks HTTP to CircleChat's /agent-api,
// exactly like circlechat-mcp.mjs. The Composio SDK and COMPOSIO_API_KEY live
// server-side in the CircleChat API; this shim (which runs INSIDE the agent
// container) never sees them. Execution is routed through /agent-api/act so it
// inherits scope/risk/approval gating.
//
// Wire-up (mirrors circlechat): registered by the equip layer with
//   command: node, args: [<this-file>, <botToken>, <apiBase>]

import { createInterface } from "node:readline";

const TOKEN = process.argv[2] || process.env.CC_BOT_TOKEN || "";
const BASE = (process.argv[3] || process.env.CC_API_BASE || "http://localhost:3300/api").replace(/\/$/, "");

if (!TOKEN) {
  console.error("composio-mcp: missing bot token (argv[2] or CC_BOT_TOKEN)");
  process.exit(1);
}

async function apiGet(path) {
  const r = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function apiPost(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) throw new Error(`POST ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// ──────────────────────── tool catalog ────────────────────────

const TOOLS = [
  {
    name: "composio_list_tools",
    description:
      "Discover Composio tools you can run against the workspace's connected accounts (Gmail, GitHub, Slack, Notion, CRMs, …). Returns tool slugs + input schemas. Filter with `toolkits` (comma-separated, e.g. \"github,gmail\") and/or a `search` term. ALWAYS call this first to get the exact slug + arguments, then run it with composio_execute.",
    inputSchema: {
      type: "object",
      properties: {
        toolkits: { type: "string", description: 'comma-separated toolkit slugs, e.g. "github,gmail"' },
        search: { type: "string", description: "fuzzy search across tool names/descriptions" },
        limit: { type: "number", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    run: ({ toolkits, search, limit }) => {
      const q = new URLSearchParams();
      if (toolkits) q.set("toolkits", toolkits);
      if (search) q.set("search", search);
      if (limit) q.set("limit", String(limit));
      const qs = q.toString();
      return apiGet(`/agent-api/composio/tools${qs ? `?${qs}` : ""}`);
    },
  },
  {
    name: "composio_connections",
    description:
      "List the connected accounts available to you — which SaaS toolkits are linked, their status, and the approval policy. Use this to see what you can act on before discovering tools.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: () => apiGet("/agent-api/composio/status"),
  },
  {
    name: "composio_execute",
    description:
      "Run ONE Composio tool by slug (from composio_list_tools) with its arguments, acting as the workspace's connected account. Outbound/write actions are gated: if the result says an approval was opened (ap_…), STOP — do NOT call it again. It runs automatically once a human approves and you'll be woken with an approval_response trigger.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "exact Composio tool slug, e.g. GITHUB_CREATE_AN_ISSUE" },
        arguments: { type: "object", description: "arguments object matching the tool's inputSchema" },
        conversation_id: {
          type: "string",
          description: "optional: the conversation this is for, so an approval confirmation is posted there",
        },
      },
      required: ["slug"],
      additionalProperties: false,
    },
    run: async ({ slug, arguments: args, conversation_id }) => {
      const res = await apiPost("/agent-api/act", {
        action: {
          type: "composio_execute",
          slug,
          arguments: args ?? {},
          ...(conversation_id ? { conversation_id } : {}),
        },
      });
      // Tool ran → hand back its output. Gated/rejected → surface the message
      // (which names the approval card) so the model knows to wait, not retry.
      const cr = Array.isArray(res.composioResults)
        ? (res.composioResults.find((r) => r.slug === slug) ?? res.composioResults[0])
        : null;
      if (cr) return cr;
      if (Array.isArray(res.errors) && res.errors.length) {
        return { pending_approval: true, message: res.errors.join("; ") };
      }
      return res;
    },
  },
];

// ──────────────────────── JSON-RPC (MCP stdio) ────────────────────────

const PROTOCOL_VERSION = "2024-11-05";

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function result(id, res) {
  send({ jsonrpc: "2.0", id, result: res });
}
function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(req) {
  const { id, method, params } = req;
  try {
    if (method === "initialize") {
      return result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "composio", version: "0.1.0" },
      });
    }
    if (method === "notifications/initialized") return;
    if (method === "tools/list") {
      return result(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    }
    if (method === "tools/call") {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return error(id, -32601, `unknown tool: ${params?.name}`);
      const out = await tool.run(params.arguments ?? {});
      return result(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
    }
    if (method === "ping") return result(id, {});
    error(id, -32601, `method not found: ${method}`);
  } catch (e) {
    error(id, -32000, (e instanceof Error ? e.message : String(e)).slice(0, 500));
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  handle(msg);
});

process.stdin.on("end", () => process.exit(0));
