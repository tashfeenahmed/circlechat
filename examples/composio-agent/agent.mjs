// Reference CircleChat agent whose toolset IS the user's Composio connections,
// driven by Claude. Implements the webhook contract from docs/custom-agents.md:
// POST /heartbeat and POST /event receive a context packet; we reply with a
// post_message action (or "HEARTBEAT_OK").
//
// This is the lightweight way to prove the integration end-to-end WITHOUT the
// containerised Hermes/OpenClaw runtime: it runs as a plain Node process, Claude
// decides which Composio tools to call, and Composio executes them against the
// connected account. (The in-platform path — bundled agents getting the same
// tools via the composio MCP shim — is the other half; see docs/composio.md.)

import http from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { Composio } from "@composio/core";
import { AnthropicProvider } from "@composio/anthropic";

const {
  CC_BOT_TOKEN,
  ANTHROPIC_API_KEY,
  COMPOSIO_API_KEY,
  COMPOSIO_USER_ID = "default",
  COMPOSIO_TOOLKITS = "",
  CC_MODEL = "claude-sonnet-5",
  PORT = "8790",
} = process.env;

for (const [k, v] of Object.entries({ CC_BOT_TOKEN, ANTHROPIC_API_KEY, COMPOSIO_API_KEY })) {
  if (!v) {
    console.error(`composio-agent: missing required env ${k}`);
    process.exit(1);
  }
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const composio = new Composio({ apiKey: COMPOSIO_API_KEY, provider: new AnthropicProvider() });

const CONFIGURED_TOOLKITS = COMPOSIO_TOOLKITS.split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const MAX_TOOL_STEPS = 6;

// Resolve which toolkits to expose: the COMPOSIO_TOOLKITS allow-list, else the
// toolkits the user has actually connected.
async function resolveToolkits() {
  if (CONFIGURED_TOOLKITS.length) return CONFIGURED_TOOLKITS;
  try {
    const res = await composio.connectedAccounts.list({ userIds: [COMPOSIO_USER_ID] });
    const items = Array.isArray(res) ? res : (res?.items ?? []);
    const set = new Set(
      items
        .map((it) => (it?.toolkit?.slug ?? it?.toolkit ?? it?.toolkitSlug ?? "").toString().toUpperCase())
        .filter((t) => t && t !== "UNKNOWN"),
    );
    return [...set];
  } catch (e) {
    console.error("composio-agent: could not list connections:", e.message);
    return [];
  }
}

// Run a Claude tool-use loop where the tools are the user's Composio tools.
async function answerWithComposio(packet, userText) {
  const toolkits = await resolveToolkits();
  const tools = toolkits.length
    ? await composio.tools.get(COMPOSIO_USER_ID, { toolkits, limit: 30 })
    : [];

  const model = packet?.agent?.model || CC_MODEL;
  const system =
    (packet?.agent?.brief || "You are a helpful teammate in a CircleChat workspace.") +
    "\n\nYou can act in the user's connected apps via the provided tools. Use them " +
    "when the request needs real data or a real action; otherwise just answer. Be " +
    "concise (1–3 sentences). Never claim you did something you didn't actually do.";

  const messages = [{ role: "user", content: userText }];
  let last = null;
  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    last = await anthropic.messages.create({
      model,
      max_tokens: 1024,
      system,
      messages,
      ...(tools.length ? { tools } : {}),
    });
    messages.push({ role: "assistant", content: last.content });
    if (last.stop_reason !== "tool_use") break;
    // Execute every tool_use block via Composio; append the tool_result blocks.
    const toolResults = await composio.provider.handleToolCalls(COMPOSIO_USER_ID, last);
    messages.push(...toolResults);
  }

  const text = (last?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return text || "(no reply)";
}

async function reply(packet) {
  const trigger = packet.trigger;
  // Only spend the model on things addressed to us. Quiet heartbeats stay silent.
  if (!["mention", "dm", "test"].includes(trigger)) return "HEARTBEAT_OK";
  const conv = (packet.inbox ?? [])[0];
  if (!conv || !conv.messages?.length) return "HEARTBEAT_OK";
  const lastMsg = conv.messages[conv.messages.length - 1];
  // Don't answer our own last message.
  if (lastMsg.memberHandle && packet.agent?.handle && lastMsg.memberHandle === packet.agent.handle) {
    return "HEARTBEAT_OK";
  }
  const body = await answerWithComposio(packet, lastMsg.bodyMd ?? "");
  return {
    actions: [
      {
        type: "post_message",
        conversation_id: conv.conversationId,
        body_md: body,
        reply_to: lastMsg.id,
      },
    ],
    trace: [`composio-agent handled ${trigger}`],
  };
}

// ──────────────────────── HTTP plumbing (built-in http) ────────────────────────

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || !["/heartbeat", "/event"].includes(req.url ?? "")) {
    res.writeHead(404).end("not found");
    return;
  }
  const auth = req.headers.authorization ?? "";
  if (auth.replace(/^Bearer\s+/i, "") !== CC_BOT_TOKEN) {
    res.writeHead(401).end("unauthorized");
    return;
  }
  let packet;
  try {
    packet = await readJson(req);
  } catch {
    res.writeHead(400).end("bad json");
    return;
  }
  // /heartbeat has no explicit trigger; treat it as scheduled.
  if (req.url === "/heartbeat" && !packet.trigger) packet.trigger = "scheduled";
  try {
    const out = await reply(packet);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(typeof out === "string" ? JSON.stringify(out) : JSON.stringify(out));
  } catch (e) {
    console.error("composio-agent error:", e);
    // Fail silent to CircleChat so a model/tool hiccup doesn't spam the channel.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify("HEARTBEAT_OK"));
  }
});

server.listen(Number(PORT), () => {
  console.log(`composio-agent listening on :${PORT} (user=${COMPOSIO_USER_ID}, toolkits=${CONFIGURED_TOOLKITS.join(",") || "auto"})`);
});
