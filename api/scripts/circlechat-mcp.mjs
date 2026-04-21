#!/usr/bin/env node
// CircleChat MCP stdio server. Exposes the workspace (post, react, DM, search,
// upload, members, messages, threads) as typed MCP tools so agent runtimes see
// a discoverable, schema-validated surface instead of having to reach for
// terminal/curl and hallucinate APIs.
//
// Wire-up: `hermes mcp add circlechat --command node --args <this-file> --args <botToken> --args <apiBase>`
// or set env CC_BOT_TOKEN + CC_API_BASE.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const TOKEN = process.argv[2] || process.env.CC_BOT_TOKEN || "";
const BASE = (process.argv[3] || process.env.CC_API_BASE || "http://localhost:3300/api").replace(/\/$/, "");

if (!TOKEN) {
  console.error("circlechat-mcp: missing bot token (argv[2] or CC_BOT_TOKEN)");
  process.exit(1);
}

// ──────────────────────── HTTP to agent-api ────────────────────────

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
async function apiUploadFile(filePath) {
  // Use native FormData + a Blob stream to stay dep-free.
  const buf = await readFile(filePath);
  const fd = new FormData();
  fd.set("file", new Blob([buf]), basename(filePath));
  const r = await fetch(`${BASE}/agent-api/uploads`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: fd,
  });
  if (!r.ok) throw new Error(`upload → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// ──────────────────────── tool catalog ────────────────────────

const TOOLS = [
  {
    name: "me",
    description: "Get your own identity (agent id, member id, handle).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: () => apiGet("/agent-api/me"),
  },
  {
    name: "list_conversations",
    description: "List every channel and DM you can see in this workspace.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: () => apiGet("/agent-api/conversations"),
  },
  {
    name: "list_members",
    description:
      "Directory of humans and agents in your workspace. Use this before start_dm to resolve a handle to a memberId.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: () => apiGet("/agent-api/members"),
  },
  {
    name: "get_messages",
    description:
      "List recent messages in a conversation (newest last). Optionally scoped to a thread via parentId, or paged via before (ISO ts).",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string" },
        parentId: { type: "string" },
        before: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 200, default: 50 },
      },
      required: ["conversationId"],
      additionalProperties: false,
    },
    run: ({ conversationId, parentId, before, limit }) => {
      const q = new URLSearchParams({ conversationId });
      if (parentId) q.set("parentId", parentId);
      if (before) q.set("before", before);
      if (limit) q.set("limit", String(limit));
      return apiGet(`/agent-api/messages?${q}`);
    },
  },
  {
    name: "get_thread",
    description: "Fetch a thread root plus every reply in chronological order.",
    inputSchema: {
      type: "object",
      properties: { messageId: { type: "string" } },
      required: ["messageId"],
      additionalProperties: false,
    },
    run: ({ messageId }) => apiGet(`/agent-api/thread?messageId=${encodeURIComponent(messageId)}`),
  },
  {
    name: "search",
    description:
      "Case-insensitive substring search across conversations you belong to. Optionally scope to one conversationId.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", minLength: 2 },
        conversationId: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 50, default: 20 },
      },
      required: ["q"],
      additionalProperties: false,
    },
    run: ({ q, conversationId, limit }) => {
      const qs = new URLSearchParams({ q });
      if (conversationId) qs.set("conversationId", conversationId);
      if (limit) qs.set("limit", String(limit));
      return apiGet(`/agent-api/search?${qs}`);
    },
  },
  {
    name: "post_message",
    description:
      "Post a message in a conversation you're a member of. Use replyTo to reply in a thread. Attach files by uploading first (upload_file) and passing the returned descriptors.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string" },
        bodyMd: { type: "string", minLength: 1 },
        replyTo: { type: "string" },
        attachments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              name: { type: "string" },
              contentType: { type: "string" },
              size: { type: "number" },
              url: { type: "string" },
            },
            required: ["key", "name", "contentType", "size", "url"],
          },
        },
      },
      required: ["conversationId", "bodyMd"],
      additionalProperties: false,
    },
    run: (a) => apiPost("/agent-api/post_message", a),
  },
  {
    name: "react",
    description: "Add a reaction emoji to a message. Idempotent.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string" },
        emoji: { type: "string", minLength: 1 },
      },
      required: ["messageId", "emoji"],
      additionalProperties: false,
    },
    run: (a) => apiPost("/agent-api/react", a),
  },
  {
    name: "start_dm",
    description:
      "Start (or retrieve) a direct-message conversation with another member of your workspace. Returns conversationId; use post_message to write into it.",
    inputSchema: {
      type: "object",
      properties: { otherMemberId: { type: "string" } },
      required: ["otherMemberId"],
      additionalProperties: false,
    },
    run: (a) => apiPost("/agent-api/start_dm", a),
  },
  {
    name: "upload_file",
    description:
      "Upload a local file by absolute path. Returns {key,name,contentType,size,url}; pass into post_message's attachments array to share it.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    run: ({ path }) => apiUploadFile(path),
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
        serverInfo: { name: "circlechat", version: "0.1.0" },
      });
    }
    if (method === "notifications/initialized") {
      return; // no response for notifications
    }
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
      return result(id, {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
      });
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
void createReadStream; // tree-shake quiet
