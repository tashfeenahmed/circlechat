// Multi-agent Hermes bridge.
//   CONFIG: a JSON file at CC_BRIDGE_CONFIG (default ./bridge-config.json):
//     [
//       { "handle": "samantha", "token": "cc_...", "hermesHome": "~/.hermes-samantha", "name": "Samantha", "title": "CEO" },
//       ...
//     ]
//   One Node process, one WS connection per agent. On an incoming heartbeat/event
//   for agent X, we shell out to `hermes chat -q <prompt> -Q --yolo` with
//   HERMES_HOME=<agent's home dir> so the invocation uses that agent's identity.
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { readFileSync, watchFile } from "node:fs";

const CFG_PATH = process.env.CC_BRIDGE_CONFIG ?? "./bridge-config.json";
const WSS = process.env.CC_WSS_URL ?? "ws://localhost:3300/agent-socket";
const API_BASE = process.env.CC_API_BASE ?? "http://localhost:3300/api";
const HERMES_TIMEOUT = Number(process.env.HERMES_TIMEOUT ?? 180);

// Per-handle connection registry so reconcile() can add/remove agents on the
// fly when bridge-config.json changes (e.g. when a new Hermes is installed).
const conns = new Map();

function loadCfg() {
  const raw = JSON.parse(readFileSync(CFG_PATH, "utf8"));
  if (!Array.isArray(raw)) throw new Error("bridge-config.json must be a JSON array");
  return raw;
}

function reconcile() {
  let cfg;
  try {
    cfg = loadCfg();
  } catch (e) {
    console.error(`[multi-bridge] bad config: ${e.message}`);
    return;
  }
  const want = new Map(cfg.map((e) => [e.handle, e]));
  for (const handle of [...conns.keys()]) {
    if (!want.has(handle)) {
      const c = conns.get(handle);
      console.log(`[multi-bridge] removing ${handle}`);
      c.removed = true;
      try { c.ws.close(); } catch {}
      conns.delete(handle);
    }
  }
  for (const [handle, entry] of want.entries()) {
    if (!conns.has(handle)) {
      console.log(`[multi-bridge] connecting ${handle}`);
      connect(entry);
    }
  }
}

function callHermes(prompt, hermesHome) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (hermesHome) env.HERMES_HOME = hermesHome;
    const args = ["chat", "-q", prompt, "-Q", "--yolo", "--source", "circlechat"];
    const p = spawn("hermes", args, { timeout: HERMES_TIMEOUT * 1000, env });
    let out = "",
      err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      if (code !== 0 && !out.trim()) return reject(new Error(err.slice(0, 400) || `hermes exit ${code}`));
      resolve({ stdout: out, stderr: err });
    });
    p.on("error", reject);
  });
}

function extractReply(raw) {
  const stripAnsi = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  const lines = stripAnsi.split("\n");
  const out = [];
  let inside = false;
  for (const line of lines) {
    if (/^\s*session_id\s*:/i.test(line)) break;
    if (/^[╭╰╮╯][─╭╰╮╯\s]*[╮╯╭╰]?/.test(line.trim())) {
      inside = !inside;
      continue;
    }
    if (!inside) continue;
    const content = line.replace(/^│\s?/, "").replace(/\s?│\s*$/, "");
    if (/^\s*⚕?\s*Hermes\s*$/.test(content)) continue;
    out.push(content);
  }
  const text = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text) return text;
  return stripAnsi
    .replace(/[╭╰│╮╯─]+/g, "")
    .split("\n")
    .filter((l) => !/^session_id:/i.test(l))
    .filter((l) => !/^\s*⚕?\s*Hermes\s*$/.test(l))
    .join("\n")
    .trim()
    .slice(0, 2000);
}

// Pulls every @handle token out of a markdown body. Skips `@` inside code
// fences/backticks and URLs; accepts word-boundary-led @handles. Handles are
// lowercased so comparison is case-insensitive.
function extractMentionHandles(bodyMd) {
  if (!bodyMd) return [];
  // Strip inline code spans and fenced blocks so @handle inside code doesn't count.
  const clean = bodyMd
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ");
  const out = [];
  const re = /(?:^|[\s(])@([a-z0-9][a-z0-9._-]{1,40})/gi;
  let m;
  while ((m = re.exec(clean))) out.push(m[1].toLowerCase());
  return out;
}

// "Someone else is clearly being addressed" test for scheduled beats. Looks
// at the last few messages and finds the most recent one that has any
// specific @handle mention (not @everyone/@channel). If that mention list
// exists and does NOT include this agent, the scheduled beat should skip —
// it's not this agent's turn.
function recentlyAddressedToSomeoneElse(messages, myHandle) {
  const mine = String(myHandle || "").toLowerCase();
  const recent = (messages || []).slice(-6);
  for (let i = recent.length - 1; i >= 0; i--) {
    const handles = extractMentionHandles(recent[i]?.bodyMd);
    if (!handles.length) continue;
    const specifics = handles.filter((h) => h !== "everyone" && h !== "channel");
    if (!specifics.length) continue;
    // Found a targeted message. Is it aimed at me?
    return !specifics.includes(mine);
  }
  return false;
}

// Pulls an optional trailing <attachments>[...]</attachments> block out of a
// Hermes reply. Returns the stripped body plus any descriptors we could parse.
function extractAttachments(text) {
  const re = /<attachments>\s*(\[[\s\S]*?\])\s*<\/attachments>/i;
  const m = re.exec(text);
  if (!m) return { body: text, attachments: [] };
  let arr;
  try {
    arr = JSON.parse(m[1]);
  } catch {
    return { body: text.replace(re, "").trim(), attachments: [] };
  }
  if (!Array.isArray(arr)) return { body: text.replace(re, "").trim(), attachments: [] };
  const clean = arr.filter(
    (a) =>
      a &&
      typeof a === "object" &&
      typeof a.key === "string" &&
      typeof a.name === "string" &&
      typeof a.contentType === "string" &&
      typeof a.size === "number" &&
      typeof a.url === "string",
  );
  return { body: text.replace(re, "").trim(), attachments: clean };
}

function formatMsg(agent, m) {
  const who = m.memberId === agent.memberId ? "you" : `@${m.memberHandle}`;
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
    for (const [emoji, handles] of byEmoji) parts.push(`${emoji}×${handles.length}`);
    const reactors = Array.from(new Set(rx.map((r) => `@${r.memberHandle}`))).join(" ");
    rxStr = ` · reactions: ${parts.join(" ")} from ${reactors}`;
  }
  let attStr = "";
  const atts = Array.isArray(m.attachments) ? m.attachments : [];
  if (atts.length) {
    const items = atts
      .map((a) => {
        const url = a.url?.startsWith("/")
          ? `${API_BASE.replace(/\/api\/?$/, "")}${a.url}`
          : a.url;
        return `${a.name} (${a.contentType}, ${a.size}B) → ${url}`;
      })
      .join("; ");
    attStr = ` · attachments: ${items}`;
  }
  return `[${m.id}] ${who}: ${m.bodyMd}${rxStr}${attStr}`;
}

function buildPrompt(entry, packet) {
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
    .slice(0, 30);
  const othersLine = others.length ? `\nOther members here: ${others.join(", ")}` : "";

  // Workspace-wide list of *other* agents with their titles so this agent
  // knows who to @-mention when a question is out of its lane.
  const colleagues = Object.values(packet.members || {})
    .filter((m) => m.kind === "agent" && !m.isMe)
    .map((m) => `@${m.handle} — ${m.name}`)
    .slice(0, 20);
  const colleaguesLine = colleagues.length
    ? `\nYour agent colleagues (you may @-mention to loop them in when relevant): ${colleagues.join(", ")}`
    : "";

  // Reporting / org-chart context: who the agent reports to, who reports to
  // them, and peers under the same manager. Helps route questions up, down,
  // or sideways to the right person.
  let reportingLine = "";
  const rpt = packet.reporting || {};
  const fmtEntry = (p) =>
    `@${p.handle}${p.title ? ` (${p.title})` : ""}${p.kind === "agent" ? ", agent" : ""}`;
  const mgr = rpt.manager;
  const reports = Array.isArray(rpt.directReports) ? rpt.directReports : [];
  const peers = Array.isArray(rpt.peers) ? rpt.peers : [];
  const pieces = [];
  if (mgr) pieces.push(`You report to ${fmtEntry(mgr)}`);
  if (reports.length) pieces.push(`Your direct reports: ${reports.map(fmtEntry).join(", ")}`);
  if (peers.length) pieces.push(`Your peers (same manager): ${peers.slice(0, 10).map(fmtEntry).join(", ")}`);
  if (pieces.length) reportingLine = "\n" + pieces.join(". ") + ".";

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

  // For scheduled beats, also show a compact summary of every OTHER active
  // conversation the agent belongs to, so they can jump in wherever there's
  // a question in their lane.
  let otherConvSummary = "";
  if (packet.trigger === "scheduled" && packet.inbox && packet.inbox.length > 1) {
    const lines = packet.inbox.slice(1, 6).map((c) => {
      const label = c.conversationKind === "dm" ? "DM" : `#${c.conversationName}`;
      const n = (c.messages || []).length;
      const latest = (c.messages || []).slice(-1)[0];
      return `- ${label}: ${n} new · last from @${latest?.memberHandle}: "${String(latest?.bodyMd ?? "").slice(0, 80)}"`;
    });
    if (lines.length)
      otherConvSummary = `\nOther conversations with new activity:\n${lines.join("\n")}`;
  }

  const triggerLine =
    packet.trigger === "mention"
      ? `You were @-mentioned by @${last?.memberHandle ?? "someone"}. Reply ONLY if the message asks YOU a specific question, assigns YOU a task, or gives YOU new info you need to act on. If it's recognition / thanks / agreement / pleasantries, react with an emoji (use the react tool: 🙏 👏 🎉 ✅ 👍 ❤️) and respond with exactly "HEARTBEAT_OK" — don't write a reply. Never write a prose "thanks back" message. When you DO write a reply, do NOT @-mention the person you're replying to (they're already in the thread); re-tag only when bringing in someone new.`
      : packet.trigger === "dm"
        ? `This is a DM — always reply.`
        : packet.trigger === "thread_reply"
          ? `A new message landed in a thread you've previously participated in — not addressed directly to you. You may reply if you have something substantive to add; otherwise respond with exactly "HEARTBEAT_OK". Don't chime in for minor acks like "ok", "thanks", "nice". If someone thanked you or the thread is winding down, react with an emoji instead of replying.`
          : packet.trigger === "channel_post"
            ? `A human posted in this channel without @-mentioning anyone. Read it and decide for yourself: if you can add something useful AND in your lane (a specific answer, a pointer, a concrete offer to help, a kudos if genuinely warranted) then reply in 1–2 sentences. Otherwise respond with exactly "HEARTBEAT_OK". Do NOT acknowledge, "+1", or echo — silence is fine. If another agent has already replied with the same point you'd make, react with an emoji instead of posting. If the post is broad ("team, anyone can…"), only chime in if it genuinely lands in YOUR role; don't pile on generically.`
            : packet.trigger === "scheduled"
              ? `Scheduled heartbeat — default answer is silence ("HEARTBEAT_OK"). Only reply if ALL of these hold: (1) the most recent message is a direct question and the asker did NOT @-mention a specific colleague; (2) the question is clearly in YOUR lane (not a generic take); (3) nobody has replied to it yet. If a colleague was @-mentioned and already answered, it is NOT your turn — do not add your own take, do not "+1", do not elaborate on their answer. If the request is broad ("team, anyone can help"), only one agent should reply — if you see another agent has already chimed in, stay silent. When in doubt, HEARTBEAT_OK.`
              : packet.trigger === "ambient"
                ? `Ambient window — the channel's been quiet and the team wants to keep it feeling alive. You're allowed (not required) to post a short, in-character contribution: continue the last thread of thought, ask a specific colleague something in your role's lane (@-mention them), share what you're working on, or react to a recent message. ONE message only, 1–2 sentences, no fake enthusiasm. If you genuinely have nothing to add right now, respond with exactly "HEARTBEAT_OK" — don't post filler.`
                : `Trigger: ${packet.trigger}.`;

  const identity = [
    `You are ${agent.name}${entry.title ? ` (${entry.title})` : ""} — an agent in CircleChat.`,
    `Your CircleChat handle is @${agent.handle}.`,
    entry.title ? `Your role: ${entry.title}.` : null,
    agent.brief ? `Brief: ${agent.brief}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const toolBlock = [
    ``,
    `TOOLS (via your terminal skill — curl + jq):`,
    `  CircleChat API base: ${API_BASE}`,
    `  Auth header:         Authorization: Bearer ${entry.token}`,
    `  — GET /agent-api/conversations`,
    `  — GET /agent-api/messages?conversationId=<id>&limit=50&before=<iso>&parentId=<id>`,
    `  — GET /agent-api/thread?messageId=<id>`,
    `  — GET /agent-api/search?q=<text>&limit=20[&conversationId=<id>]`,
    `  — GET /agent-api/members`,
    `  — POST /agent-api/react  body:{"messageId":"<id>","emoji":"🙏"} — use this instead of replying for acks, thanks, agreement, celebration`,
    `  — POST /agent-api/uploads   (multipart file upload; returns {key,name,contentType,size,url})`,
    `If a user attaches a file, the attachment line shows the URL — you can curl it directly with your Bearer header.`,
    `To send a file back: (1) upload with curl -s -X POST -H "Authorization: Bearer <token>" -F file=@/path ${API_BASE}/agent-api/uploads — this returns JSON {key,name,contentType,size,url}. (2) End your reply with an <attachments> block containing a JSON array of one or more of these descriptors, e.g.: <attachments>[{"key":"u/ab12/foo.pdf","name":"foo.pdf","contentType":"application/pdf","size":12345,"url":"/files/u/ab12/foo.pdf"}]</attachments>. The block will be stripped from your message body before it posts.`,
    `Only call a tool if you genuinely need older context. Don't mention the tool in your final reply.`,
  ].join("\n");

  return [
    identity,
    ``,
    `You are currently in ${convLabel}.${topicLine}${othersLine}${colleaguesLine}${reportingLine}`,
    threadBlock,
    ``,
    `Recent messages in this conversation (most recent last):`,
    history || "(no prior messages)",
    otherConvSummary,
    ``,
    triggerLine,
    toolBlock,
    ``,
    `Reply briefly (1–2 sentences unless asked for more). Write only the reply text — no greetings, no sign-off, no markdown code fences around your reply.`,
  ].join("\n");
}

function connect(entry) {
  const ws = new WebSocket(WSS, { headers: { authorization: `Bearer ${entry.token}` } });
  const rec = { ws, entry, removed: false };
  conns.set(entry.handle, rec);
  ws.on("open", () => console.log(`[${entry.handle}] connected`));

  ws.on("message", async (raw) => {
    let frame;
    try {
      frame = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (frame.type === "hello") {
      console.log(`[${entry.handle}] hello → ${frame.handle} (HERMES_HOME=${entry.hermesHome})`);
      return;
    }
    if (frame.type !== "heartbeat" && frame.type !== "event") return;

    const p = frame.packet || {};
    const trigger = p.trigger;
    const inbox = Array.isArray(p.inbox) ? p.inbox : [];
    const reply = (body) =>
      ws.send(JSON.stringify({ correlation_id: frame.correlation_id, type: "reply", ...body }));

    // Scheduled beats with no new activity → skip, don't wake Hermes.
    // Ambient beats are allowed through even when the inbox is bare: the whole
    // point is to let the agent post on a quiet channel.
    if (trigger === "scheduled" && inbox.length === 0) return reply({ status: "HEARTBEAT_OK" });
    const conv = inbox[0];
    if (!conv) return reply({ status: "HEARTBEAT_OK" });

    // If a recent message in the primary conversation @-mentioned a specific
    // colleague who isn't me, this scheduled/channel_post beat isn't my turn.
    // Stay silent without even calling Hermes — saves tokens AND prevents
    // piggybacks. `channel_post` fires on any plain post, so this filter is
    // how we avoid waking every agent when one's already been tagged.
    if (
      (trigger === "scheduled" || trigger === "channel_post") &&
      recentlyAddressedToSomeoneElse(conv.messages, entry.handle)
    ) {
      console.log(`[${entry.handle}] ${trigger} → skip (conversation addressed to someone else)`);
      return reply({ status: "HEARTBEAT_OK" });
    }
    const last = conv.messages?.[conv.messages.length - 1];
    // `last` may be missing for ambient beats on quiet channels — that's fine,
    // we still want the agent to see context and decide.
    if (!last && trigger !== "ambient") return reply({ status: "HEARTBEAT_OK" });

    const inDm = conv.conversationKind === "dm";
    const replyTo = inDm ? undefined : p.thread?.rootMessageId ?? undefined;

    console.log(
      `[${entry.handle}] ${trigger} conv=${conv.conversationId} body="${String(last?.bodyMd ?? "(quiet)").slice(0, 50)}"`,
    );

    const prompt = buildPrompt(entry, p);
    try {
      const { stdout, stderr } = await callHermes(prompt, entry.hermesHome);
      const rawText = extractReply(stdout) || extractReply(stderr) || "(empty reply)";
      if (
        (trigger === "scheduled" || trigger === "thread_reply" || trigger === "ambient") &&
        /^\s*HEARTBEAT_OK\s*$/i.test(rawText)
      ) {
        return reply({ status: "HEARTBEAT_OK" });
      }
      const { body, attachments } = extractAttachments(rawText);
      console.log(`[${entry.handle}] replying, len=${body.length}, att=${attachments.length}`);
      reply({
        actions: [
          {
            type: "post_message",
            conversation_id: conv.conversationId,
            body_md: body,
            ...(replyTo ? { reply_to: replyTo } : {}),
            ...(attachments.length ? { attachments } : {}),
          },
        ],
        trace: [`${entry.handle} responded, len=${body.length}${attachments.length ? `, att=${attachments.length}` : ""}`],
      });
    } catch (e) {
      console.error(`[${entry.handle}] error: ${e.message.split("\n")[0]}`);
      reply({
        actions: [
          {
            type: "post_message",
            conversation_id: conv.conversationId,
            body_md: `⚠️ ${entry.name} error: \`${e.message.split("\n")[0].slice(0, 300)}\``,
            ...(replyTo ? { reply_to: replyTo } : {}),
          },
        ],
        trace: [`${entry.handle} error: ${e.message.slice(0, 200)}`],
      });
    }
  });

  ws.on("close", () => {
    if (rec.removed || conns.get(entry.handle) !== rec) return;
    console.log(`[${entry.handle}] disconnected — retry in 2s`);
    conns.delete(entry.handle);
    setTimeout(() => {
      // Only reconnect if still present in config.
      try {
        if (loadCfg().some((e) => e.handle === entry.handle)) connect(entry);
      } catch { /* ignore */ }
    }, 2000);
  });
  ws.on("error", (e) => {
    console.error(`[${entry.handle}] ws error:`, e.message);
    try {
      ws.close();
    } catch {}
  });
}

reconcile();
watchFile(CFG_PATH, { interval: 1500 }, reconcile);
console.log(`[multi-bridge] watching ${CFG_PATH} for changes`);
