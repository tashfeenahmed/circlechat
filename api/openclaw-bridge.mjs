// Bridge: CircleChat /agent-socket  ↔  local `openclaw agent` CLI
// Falls back to local Ollama if OpenClaw returns an auth error.
import WebSocket from "ws";
import { spawn } from "node:child_process";

const TOKEN = process.env.CC_BOT_TOKEN;
const WSS = process.env.CC_WSS_URL ?? "ws://localhost:3000/agent-socket";
const OPENCLAW_AGENT = process.env.OPENCLAW_AGENT ?? "main";
const OPENCLAW_TIMEOUT = Number(process.env.OPENCLAW_TIMEOUT ?? 120);
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "phi4-mini:latest";

if (!TOKEN) {
  console.error("Set CC_BOT_TOKEN");
  process.exit(1);
}

function callOpenclaw(message, sessionId) {
  return new Promise((resolve, reject) => {
    const args = [
      "agent",
      "--agent", OPENCLAW_AGENT,
      "--message", message,
      "--json",
      "--timeout", String(OPENCLAW_TIMEOUT),
      "--session-id", sessionId,
    ];
    const p = spawn("openclaw", args);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      if (code !== 0 && !out.trim()) return reject(new Error(err || `openclaw exited ${code}`));
      // OpenClaw emits JSON at end of stdout even if some warnings land in stderr.
      try {
        const start = out.lastIndexOf("{");
        const json = JSON.parse(start >= 0 ? out.slice(start) : out);
        resolve(json);
      } catch (e) {
        reject(new Error(`openclaw parse fail: ${e.message}\nSTDOUT:\n${out}\nSTDERR:\n${err}`));
      }
    });
  });
}

function textFromOpenclaw(resp) {
  // Try several common shapes.
  if (Array.isArray(resp?.payloads)) {
    const t = resp.payloads.map((p) => p?.text).filter(Boolean).join("\n");
    if (t) return t;
  }
  if (typeof resp?.reply === "string") return resp.reply;
  if (typeof resp?.message === "string") return resp.message;
  if (typeof resp?.text === "string") return resp.text;
  if (typeof resp?.output === "string") return resp.output;
  if (Array.isArray(resp?.messages)) {
    const last = resp.messages[resp.messages.length - 1];
    if (typeof last?.content === "string") return last.content;
    if (typeof last?.text === "string") return last.text;
  }
  return JSON.stringify(resp).slice(0, 600);
}

function looksLikeAuthError(err) {
  const m = String(err?.message ?? err ?? "");
  return /no api key|unauthorized|401|invalid x-api-key|FailoverError/i.test(m);
}

async function ollamaFallback(message) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [
        { role: "system", content: "You are a concise teammate in a chat. Reply in one or two sentences." },
        { role: "user", content: message },
      ],
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`ollama_${res.status}`);
  const j = await res.json();
  return j?.message?.content ?? "[empty ollama reply]";
}

function connect() {
  const ws = new WebSocket(WSS, { headers: { authorization: `Bearer ${TOKEN}` } });
  ws.on("open", () => console.log(`[bridge] connected to ${WSS}`));

  ws.on("message", async (raw) => {
    let frame;
    try { frame = JSON.parse(String(raw)); } catch { return; }
    if (frame.type === "hello") {
      console.log("[bridge] server hello", frame.handle);
      return;
    }
    if (frame.type !== "heartbeat" && frame.type !== "event") return;

    const p = frame.packet || {};
    const trigger = p.trigger;
    const inbox = Array.isArray(p.inbox) ? p.inbox : [];
    const reply = (body) => ws.send(JSON.stringify({ correlation_id: frame.correlation_id, type: "reply", ...body }));

    // Scheduled beats with no new inbox → silent
    if (trigger === "scheduled" && inbox.length === 0) {
      return reply({ status: "HEARTBEAT_OK" });
    }
    // Only actually run the model for mention/dm/test (or a non-empty scheduled beat)
    const conv = inbox[0] ?? null;
    if (!conv) return reply({ status: "HEARTBEAT_OK" });
    const last = conv.messages?.[conv.messages.length - 1];
    if (!last) return reply({ status: "HEARTBEAT_OK" });

    console.log(`[bridge] trigger=${trigger} conv=${conv.conversationId} body="${String(last.bodyMd).slice(0, 60)}"`);

    const inDm = conv.conversationKind === "dm";
    const replyTo = inDm ? undefined : last.id;

    let text = null, trace = [], source = "openclaw";
    try {
      const resp = await callOpenclaw(last.bodyMd, `cc:${conv.conversationId}`);
      text = textFromOpenclaw(resp);
      // Detect embedded "HTTP 401 authentication_error" from Anthropic too.
      if (looksLikeAuthError(text) || !text || text.startsWith("{")) {
        throw new Error(text || "openclaw returned empty");
      }
      trace = [`openclaw responded (len=${text.length})`];
    } catch (e) {
      console.error("[bridge] openclaw error:", e.message.split("\n")[0]);
      if (looksLikeAuthError(e)) {
        try {
          const ollama = await ollamaFallback(last.bodyMd);
          text = `_[ollama ${OLLAMA_MODEL} fallback — openclaw has no anthropic key]_\n\n${ollama}`;
          source = "ollama";
          trace = [`openclaw no-auth → ollama fallback (len=${ollama.length})`];
        } catch (oe) {
          text = `⚠️ Both paths failed. OpenClaw: \`${e.message.split("\n")[0].slice(0, 200)}\`. Ollama: \`${oe.message}\`.`;
          trace = [`openclaw error + ollama error`];
        }
      } else {
        text = `⚠️ OpenClaw error: \`${e.message.split("\n")[0].slice(0, 300)}\``;
        trace = [`openclaw error: ${e.message.slice(0, 200)}`];
      }
    }

    console.log(`[bridge] replying via ${source}, len=${text.length}`);
    reply({
      actions: [
        {
          type: "post_message",
          conversation_id: conv.conversationId,
          body_md: text,
          ...(replyTo ? { reply_to: replyTo } : {}),
        },
      ],
      trace,
    });
  });

  ws.on("close", () => {
    console.log("[bridge] disconnected, retrying in 2s");
    setTimeout(connect, 2000);
  });
  ws.on("error", (e) => {
    console.error("[bridge] ws error:", e.message);
    try { ws.close(); } catch {}
  });
}

connect();
