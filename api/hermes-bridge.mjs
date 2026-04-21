// Bridge: CircleChat /agent-socket  ↔  local `hermes chat` CLI
// Reuses the Pi's existing Hermes profile (with its own model, e.g. gemini-2.5-pro).
import WebSocket from "ws";
import { spawn } from "node:child_process";

const TOKEN = process.env.CC_BOT_TOKEN;
const WSS = process.env.CC_WSS_URL ?? "ws://localhost:3300/agent-socket";
const API_BASE = process.env.CC_API_BASE ?? "http://localhost:3300/api";
const HERMES_TIMEOUT = Number(process.env.HERMES_TIMEOUT ?? 180);
const PROFILE = process.env.HERMES_PROFILE; // optional

if (!TOKEN) {
  console.error("Set CC_BOT_TOKEN");
  process.exit(1);
}

function callHermes(message) {
  return new Promise((resolve, reject) => {
    const args = ["chat", "-q", message, "-Q", "--yolo", "--source", "circlechat"];
    if (PROFILE) args.push("--profile", PROFILE);
    const p = spawn("hermes", args, { timeout: HERMES_TIMEOUT * 1000 });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      if (code !== 0 && !out.trim()) return reject(new Error(err.slice(0, 400) || `hermes exit ${code}`));
      resolve({ stdout: out, stderr: err });
    });
    p.on("error", reject);
  });
}

// Build a structured prompt that gives the agent full awareness of:
// - who it is (its own handle/name in CircleChat)
// - where it is (channel vs DM, name, topic, who else is there)
// - what just happened (trigger + last N messages with real handles)
// - what to do (reply briefly, one or two sentences unless asked for detail)
function formatMsg(agent, m) {
  const who = m.memberId === agent.memberId ? "you" : `@${m.memberHandle}`;
  // Aggregate reactions as e.g.  [reactions: 👍×2 🎉×1 from @alice @bob]
  let rxStr = "";
  const rx = Array.isArray(m.reactions) ? m.reactions : [];
  if (rx.length) {
    const byEmoji = new Map();
    for (const r of rx) {
      const arr = byEmoji.get(r.emoji) ?? [];
      arr.push(r.memberHandle || r.memberId);
      byEmoji.set(r.emoji, arr);
    }
    const parts = [];
    for (const [emoji, handles] of byEmoji) {
      parts.push(`${emoji}×${handles.length}`);
    }
    const reactors = Array.from(new Set(rx.map((r) => `@${r.memberHandle}`))).join(" ");
    rxStr = ` · reactions: ${parts.join(" ")} from ${reactors}`;
  }
  return `[${m.id}] ${who}: ${m.bodyMd}${rxStr}`;
}

function buildPrompt(packet) {
  const agent = packet.agent || {};
  const conv = (packet.inbox && packet.inbox[0]) || {};
  const kind = conv.conversationKind ?? "channel";
  const convLabel =
    kind === "dm"
      ? "a direct message (1:1)"
      : `the #${conv.conversationName || "channel"} channel`;
  const topicLine = conv.conversationTopic ? `\nChannel topic: ${conv.conversationTopic}` : "";
  const others = (conv.conversationMembers || [])
    .filter((mid) => mid !== agent.memberId)
    .map((mid) => packet.members?.[mid])
    .filter(Boolean)
    .map((m) => `@${m.handle} (${m.name}${m.kind === "agent" ? ", agent" : ""})`)
    .slice(0, 20);
  const othersLine = others.length ? `\nOther members here: ${others.join(", ")}` : "";

  // THREAD block: always-included, full root + every reply, when we're inside a thread.
  let threadBlock = "";
  if (packet.thread) {
    const lines = packet.thread.messages.map((m) => formatMsg(agent, m)).join("\n");
    threadBlock = [
      ``,
      `You are replying INSIDE A THREAD (root message id ${packet.thread.rootMessageId}).`,
      `The full thread so far (root first, replies chronological):`,
      lines,
    ].join("\n");
  }

  const recent = (conv.messages || []).slice(-12);
  const history = recent.map((m) => formatMsg(agent, m)).join("\n");

  const last = recent[recent.length - 1];
  const triggerLine =
    packet.trigger === "mention"
      ? `You were @-mentioned by @${last?.memberHandle ?? "someone"}.`
      : packet.trigger === "dm"
        ? `This is a DM — always reply.`
        : packet.trigger === "scheduled"
          ? `Scheduled heartbeat — decide whether anything here is worth responding to; if not, say "HEARTBEAT_OK" verbatim.`
          : `Trigger: ${packet.trigger}.`;

  const toolBlock = [
    ``,
    `TOOLS YOU CAN USE (via the terminal skill — run curl, parse JSON, then answer):`,
    `  CircleChat API base: ${API_BASE}`,
    `  Auth header:         Authorization: Bearer ${TOKEN}`,
    `  — GET /agent-api/conversations         — list every channel/DM you can see.`,
    `  — GET /agent-api/messages?conversationId=<id>&limit=50&before=<iso>&parentId=<id>`,
    `  — GET /agent-api/thread?messageId=<id>  — get the root + every reply of a thread.`,
    `  — GET /agent-api/search?q=<text>&limit=20[&conversationId=<id>] — substring search.`,
    `  — GET /agent-api/members               — the full member directory.`,
    `Only call a tool if you need older context or data from another channel. Don't narrate your tool use in the final reply.`,
  ].join("\n");

  return [
    `You are the agent @${agent.handle} (${agent.name}) inside CircleChat, a team chat where humans and agents share channels and DMs.`,
    agent.brief ? `Your brief: ${agent.brief}` : null,
    ``,
    `You are currently in ${convLabel}.${topicLine}${othersLine}`,
    threadBlock,
    ``,
    `Recent messages in this conversation (most recent last):`,
    history || "(no prior messages)",
    ``,
    triggerLine,
    toolBlock,
    ``,
    `Reply briefly (1–2 sentences unless the user asks for more). Write only the reply text — no greetings, no sign-off, no markdown code fences around your reply.`,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

// Hermes -Q output wraps the reply in a bordered banner; extract the body text.
function extractReply(raw) {
  const stripAnsi = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  const lines = stripAnsi.split("\n");
  const out = [];
  let inside = false;
  for (const line of lines) {
    // A banner border line starts or ends the Hermes box.
    if (/^[╭╰╮╯][─╭╰╮╯\s]*[╮╯╭╰]?/.test(line.trim())) {
      inside = !inside;
      continue;
    }
    // Footer line "session_id: …" (outside the box) marks the end.
    if (/^\s*session_id\s*:/i.test(line)) break;
    if (!inside) continue;
    // Strip left/right pipe borders and surrounding whitespace.
    const content = line.replace(/^│\s?/, "").replace(/\s?│\s*$/, "");
    // Drop the "⚕ Hermes" title row (header inside the box).
    if (/^\s*⚕?\s*Hermes\s*$/.test(content)) continue;
    out.push(content);
  }
  const text = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text) return text;
  // Fallback: strip all box chars + the header entirely.
  return stripAnsi
    .replace(/[╭╰│╮╯─]+/g, "")
    .split("\n")
    .filter((l) => !/^session_id:/i.test(l))
    .filter((l) => !/^\s*⚕?\s*Hermes\s*$/.test(l))
    .join("\n")
    .trim()
    .slice(0, 2000);
}

function connect() {
  const ws = new WebSocket(WSS, { headers: { authorization: `Bearer ${TOKEN}` } });
  ws.on("open", () => console.log(`[hermes-bridge] connected to ${WSS}`));

  ws.on("message", async (raw) => {
    let frame;
    try { frame = JSON.parse(String(raw)); } catch { return; }
    if (frame.type === "hello") {
      console.log(`[hermes-bridge] server hello ${frame.handle}`);
      return;
    }
    if (frame.type !== "heartbeat" && frame.type !== "event") return;

    const p = frame.packet || {};
    const trigger = p.trigger;
    const inbox = Array.isArray(p.inbox) ? p.inbox : [];
    const reply = (body) => ws.send(JSON.stringify({ correlation_id: frame.correlation_id, type: "reply", ...body }));

    if (trigger === "scheduled" && inbox.length === 0) return reply({ status: "HEARTBEAT_OK" });
    const conv = inbox[0];
    if (!conv) return reply({ status: "HEARTBEAT_OK" });
    const last = conv.messages?.[conv.messages.length - 1];
    if (!last) return reply({ status: "HEARTBEAT_OK" });

    const inDm = conv.conversationKind === "dm";
    // Reply in-place: no parent for DMs; if we're inside a thread, reply to the
    // thread ROOT so our reply stays flat with the rest of the thread; otherwise
    // start a new thread off the triggering message.
    const replyTo = inDm
      ? undefined
      : p.thread?.rootMessageId ?? last.id;

    console.log(`[hermes-bridge] trigger=${trigger} conv=${conv.conversationId} body="${String(last.bodyMd).slice(0, 60)}"`);

    const prompt = buildPrompt(p);

    try {
      const { stdout, stderr } = await callHermes(prompt);
      const rawText = extractReply(stdout) || extractReply(stderr) || "(empty reply)";
      // Allow agent to opt-out on scheduled heartbeats.
      if (trigger === "scheduled" && /^\s*HEARTBEAT_OK\s*$/i.test(rawText)) {
        return reply({ status: "HEARTBEAT_OK" });
      }
      const text = rawText;
      console.log(`[hermes-bridge] replying, len=${text.length}`);
      reply({
        actions: [
          {
            type: "post_message",
            conversation_id: conv.conversationId,
            body_md: text,
            ...(replyTo ? { reply_to: replyTo } : {}),
          },
        ],
        trace: [`hermes responded, len=${text.length}`],
      });
    } catch (e) {
      console.error("[hermes-bridge] error:", e.message.split("\n")[0]);
      reply({
        actions: [
          {
            type: "post_message",
            conversation_id: conv.conversationId,
            body_md: `⚠️ Hermes error: \`${e.message.split("\n")[0].slice(0, 300)}\``,
            ...(replyTo ? { reply_to: replyTo } : {}),
          },
        ],
        trace: [`hermes error: ${e.message.slice(0, 200)}`],
      });
    }
  });

  ws.on("close", () => { console.log("[hermes-bridge] disconnected, retry 2s"); setTimeout(connect, 2000); });
  ws.on("error", (e) => { console.error("[hermes-bridge] ws error:", e.message); try { ws.close(); } catch {} });
}

connect();
