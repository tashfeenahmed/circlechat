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
// Match the api process' runtime decision. "docker" is the default going
// forward; "host" is only retained as an escape hatch.
const HERMES_RUNTIME = process.env.CC_HERMES_RUNTIME === "host" ? "host" : "docker";
const HERMES_IMAGE = process.env.CC_HERMES_IMAGE ?? "nousresearch/hermes-agent:latest";
const CONTAINER_HERMES_HOME = "/opt/data";
const OPENCLAW_IMAGE = process.env.CC_OPENCLAW_IMAGE ?? "alpine/openclaw:latest";
const CONTAINER_OPENCLAW_HOME = "/root/.openclaw";

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

function buildHermesSpawn(hermesHome, hermesArgs, envExtras = {}) {
  if (HERMES_RUNTIME === "host") {
    const env = { ...process.env, ...envExtras };
    if (hermesHome) env.HERMES_HOME = hermesHome;
    return { cmd: "hermes", args: hermesArgs, env };
  }
  // docker: bind-mount the per-agent home into the image's /opt/data and
  // use the default entrypoint so config.yaml / .env / SOUL.md get bootstrapped
  // the first time. The entrypoint also prints skills_sync progress to stdout
  // on every invocation, which extractReply() filters out below.
  //
  // `-e` flags forward the agent's bot token + API base into the container so
  // its terminal / Python snippets can call back into /agent-api/* without
  // hard-coding secrets. See the `browser/agent-browser` skill for usage.
  const envArgs = [];
  for (const [k, v] of Object.entries(envExtras)) {
    if (v !== undefined && v !== null) envArgs.push("-e", `${k}=${v}`);
  }
  const dockerArgs = [
    "run",
    "--rm",
    "-i",
    "--network=host",
    "-v",
    `${hermesHome}:${CONTAINER_HERMES_HOME}`,
    ...envArgs,
    HERMES_IMAGE,
    ...hermesArgs,
  ];
  return { cmd: "docker", args: dockerArgs, env: process.env };
}

function callHermes(prompt, hermesHome, token) {
  return new Promise((resolve, reject) => {
    const hermesArgs = ["chat", "-q", prompt, "-Q", "--yolo", "--source", "circlechat"];
    const envExtras = {
      CC_API_BASE: API_BASE,
      CC_BOT_TOKEN: token,
    };
    const spec = buildHermesSpawn(hermesHome, hermesArgs, envExtras);
    const p = spawn(spec.cmd, spec.args, { timeout: HERMES_TIMEOUT * 1000, env: spec.env });
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

// One-shot openclaw invocation against a container-local agent. Uses
// `openclaw agent --local --agent main` — the `main` agent is always
// present in a freshly onboarded state dir.
function callOpenClaw(prompt, openclawHome, token) {
  return new Promise((resolve, reject) => {
    const args = [
      "run",
      "--rm",
      "-i",
      "--user",
      "0:0",
      "--network=host",
      "-v",
      `${openclawHome}:${CONTAINER_OPENCLAW_HOME}`,
      "-e",
      `CC_API_BASE=${API_BASE}`,
      "-e",
      `CC_BOT_TOKEN=${token}`,
      "--entrypoint",
      "openclaw",
      OPENCLAW_IMAGE,
      "agent",
      "--local",
      "--agent",
      "main",
      "-m",
      prompt,
      "--json",
    ];
    const p = spawn("docker", args, { timeout: HERMES_TIMEOUT * 1000, env: process.env });
    let out = "",
      err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      if (code !== 0 && !out.trim()) return reject(new Error(err.slice(0, 400) || `openclaw exit ${code}`));
      resolve({ stdout: out, stderr: err });
    });
    p.on("error", reject);
  });
}

// Parse the `--json` output from `openclaw agent --local` and pull the
// assistant message text. Shape varies across versions; defensively drill into
// the expected path and fall back to whatever looks like a string.
function extractOpenClawReply(stdout) {
  try {
    // --json emits the whole run envelope; assistant text is usually under
    // result.messages[-1].content or result.text. Find a JSON object in the
    // stream (agent prints progress logs first, then the JSON payload).
    const firstBrace = stdout.indexOf("{");
    if (firstBrace === -1) return "";
    const payload = JSON.parse(stdout.slice(firstBrace));
    // alpine/openclaw `agent --local --json` shape (2026.4.x):
    //   { payloads: [{ text: "..." }], meta: { finalAssistantVisibleText: "..." } }
    const payloadText = Array.isArray(payload?.payloads)
      ? payload.payloads.map((p) => (typeof p?.text === "string" ? p.text : "")).filter(Boolean).join("\n")
      : "";
    const candidates = [
      payloadText,
      payload?.meta?.finalAssistantVisibleText,
      payload?.meta?.finalAssistantRawText,
      payload?.result?.finalAssistantVisibleText,
      payload?.text,
      payload?.reply,
      payload?.message?.content,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return c;
      if (Array.isArray(c)) {
        const joined = c
          .map((b) => (typeof b?.text === "string" ? b.text : ""))
          .filter(Boolean)
          .join("\n");
        if (joined) return joined;
      }
    }
    return "";
  } catch {
    // JSON parsing failed — try to pull a sensible last non-empty, non-log line.
    const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    if (last && !last.startsWith("[") && !last.startsWith("{")) return last;
    return "";
  }
}

// Lines emitted by the hermes image's entrypoint (skills_sync.py) that must
// never leak into a reply. The default entrypoint runs on every `docker run
// hermes-agent <subcmd>` even when we just want a chat reply, so we filter
// its progress output at the bridge.
function isEntrypointNoise(line) {
  const t = line.trim();
  if (!t) return false;
  if (/^Syncing bundled skills/i.test(t)) return true;
  if (/^Done: \d+ new, /.test(t)) return true;
  if (/^\s*[~+↑!] \S/.test(line)) return true;
  if (/^Dropping root privileges/i.test(t)) return true;
  if (/^\s*==+/.test(t)) return true;
  // Hermes' tool-dispatcher status lines. These are internal diagnostics and
  // must never land as chat messages. "Auto-repaired tool name" specifically
  // happens when the model emits a tool call whose name Hermes fuzzy-matches
  // to a registered tool (e.g. our `share_files` action → `search_files`).
  if (/^🔧\s*Auto-repaired tool name/i.test(t)) return true;
  if (/^⚠️?\s*Unknown tool/i.test(t)) return true;
  if (/^✓\s*(Enabled toolset|Loaded \d+ tools?)/i.test(t)) return true;
  return false;
}

// Python traceback in stdout/stderr means Hermes crashed (usually SIGTERM
// from our spawn timeout → KeyboardInterrupt). Posting the traceback to
// chat is never useful — treat it as a crash and let the bridge fall
// through to its error handler.
function looksLikeTraceback(text) {
  return /^\s*Traceback \(most recent call last\):/m.test(text);
}

// FreeLLMAPI / OpenRouter-style gateway error strings that Hermes streams
// back as if they were the model's answer. Same treatment as a traceback
// — the agent didn't actually reply, stay silent.
function looksLikeGatewayError(text) {
  return /^\s*API call failed after \d+ retries|^\s*Provider error \([^)]+\):\s*[A-Za-z]+ API error \d{3}/m.test(text);
}

// Hermes' built-in "clarify" feature emits this placeholder to stdout when
// its internal clarification prompt times out. It's scaffolding text, not
// something the agent decided to say — strip it.
function stripClarifyNoise(text) {
  return text
    .replace(/^\s*\(clarify timed out after \d+s[^)]*\)\s*\n?/gm, "")
    .trim();
}

function extractReply(raw) {
  const stripAnsi = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  if (looksLikeTraceback(stripAnsi)) return "";
  if (looksLikeGatewayError(stripAnsi)) return "";
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
    if (isEntrypointNoise(content)) continue;
    out.push(content);
  }
  const text = stripClarifyNoise(out.join("\n").replace(/\n{3,}/g, "\n\n").trim());
  if (text) return text;
  return stripClarifyNoise(stripAnsi
    .replace(/[╭╰│╮╯─]+/g, "")
    .split("\n")
    .filter((l) => !/^session_id:/i.test(l))
    .filter((l) => !/^\s*⚕?\s*Hermes\s*$/.test(l))
    .filter((l) => !isEntrypointNoise(l))
    .join("\n")
    .trim()
    .slice(0, 2000));
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

// Pulls an optional trailing <actions>[...]</actions> block — the native
// side-channel for structured tool calls (create_task, react, assign_task,
// task_comment, etc.). Shape-checks each entry against a whitelist of action
// types and drops junk. Returns the stripped reply body plus the validated
// action list, ready to be appended to the post_message action before it
// hits the executor.
const ALLOWED_ACTION_TYPES = new Set([
  "react",
  "open_thread",
  "request_approval",
  "set_memory",
  "create_task",
  "update_task",
  "assign_task",
  "task_comment",
  "share_to_task",
]);
function extractActions(text) {
  const re = /<actions>\s*(\[[\s\S]*?\])\s*<\/actions>/i;
  const m = re.exec(text);
  if (!m) return { body: text, actions: [] };
  let arr;
  try {
    arr = JSON.parse(m[1]);
  } catch {
    return { body: text.replace(re, "").trim(), actions: [] };
  }
  if (!Array.isArray(arr)) return { body: text.replace(re, "").trim(), actions: [] };
  const clean = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    if (typeof raw.type !== "string") continue;
    if (!ALLOWED_ACTION_TYPES.has(raw.type)) continue;
    clean.push(raw);
    if (clean.length >= 20) break;
  }
  return { body: text.replace(re, "").trim(), actions: clean };
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
  const primaryConv = packet.inbox && packet.inbox[0];
  const taskOnly = !primaryConv;
  const conv = primaryConv || {};
  const kind = conv.conversationKind ?? "channel";
  const convLabel = taskOnly
    ? "no active channel — this is a task-only heartbeat"
    : kind === "dm"
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
  // Member IDs for the people in this conversation. The task API takes
  // memberIds (not handles) for assignees, so surface them here so the agent
  // doesn't have to round-trip through GET /agent-api/members first.
  const memberIdLines = Object.values(packet.members || {})
    .filter((m) => m.memberId)
    .map((m) => `  ${m.memberId} — @${m.handle} (${m.name}${m.kind === "agent" ? ", agent" : ""}${m.isMe ? ", you" : ""})`)
    .slice(0, 30);
  const memberIdBlock = memberIdLines.length
    ? `\nMember IDs (use these when calling task/assignee APIs):\n${memberIdLines.join("\n")}`
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
  const lastSenderKind = last ? packet.members?.[last.memberId]?.kind : undefined;

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

  const triggerLine = taskOnly
    ? `Task-only scheduled heartbeat — the channels you belong to have nothing new and you have no thread to reply in. Your only path to a useful turn is to act on a task from YOUR OPEN TASKS above. See TASK-ONLY MODE for the exact contract.`
    : packet.trigger === "mention"
      ? lastSenderKind === "agent"
        ? `You were @-mentioned by another agent (@${last?.memberHandle ?? "someone"}). Reply ONLY if the message asks YOU a specific question, assigns YOU a task, or gives YOU new info you need to act on. If it's recognition / thanks / agreement / pleasantries, react with an emoji (use the react tool: 🙏 👏 🎉 ✅ 👍 ❤️) and respond with exactly "HEARTBEAT_OK" — don't write a reply. Never write a prose "thanks back" message. When you DO write a reply, do NOT @-mention the person you're replying to (they're already in the thread); re-tag only when bringing in someone new.`
        : `A human (@${last?.memberHandle ?? "someone"}) @-mentioned you directly. ALWAYS write a real reply — never return "HEARTBEAT_OK" on a human mention, even if the message looks like thanks or a pleasantry. If they're assigning a task, acknowledge it concretely and say what you'll do (or who you're delegating to). If it's a question, answer it. If it's praise, respond briefly in character. Optionally also react with an emoji (POST /agent-api/react), but the reply itself is required. Do NOT @-mention the human back (they're already in the thread); re-tag only when bringing in someone new.`
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
                : packet.trigger === "task_assigned"
                  ? `You were assigned a task on the workspace board. Task details are below in the TASK block. Decide what to do: if you can get started now, move it to in_progress via the task API and optionally comment on the task to tell the team you've picked it up. If the scope is unclear, add a comment with your clarifying question rather than starting work. If this isn't in your lane, add a comment saying so and unassign yourself. Don't post in the channel just to say "got it" — the activity log already shows the assignment. Return "HEARTBEAT_OK" if you acknowledged via the task itself.`
                  : packet.trigger === "task_comment"
                    ? `A new comment landed on a task you're involved with. Read the recent comments in the TASK block. Reply by adding a comment on the task (POST /agent-api/tasks/<id>/comments), not by posting in the channel. If the comment is a question for you, answer concretely. If it's an ack or thanks, respond with "HEARTBEAT_OK" — silence is fine on the task thread too.`
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
    `ACTIONS you can take (the native, preferred channel):`,
    `End your reply with a JSON block: <actions>[ {...}, {...} ]</actions>`,
    `The block is parsed out of your reply, executed server-side, and stripped from the message body before it posts. Use it whenever you'd otherwise promise to "do" something.`,
    ``,
    `IMPORTANT: <actions> is LITERAL TEXT you write in your reply body. It is NOT a tool call. Do NOT invoke share_files, create_task, react, or any action type below as a function/tool — write the JSON inside <actions>…</actions> tags as part of your message. If your runtime tries to auto-route one of these names to a similarly-named tool (e.g. share_files → search_files), that means you emitted it wrong: wrap it in <actions> next turn.`,
    ``,
    `DO IT, DON'T TASK IT. If the user is asking for a direct in-chat thing you can fulfill this turn — share a file from the web, fetch and summarise a page, look something up, send a DM, react — DO IT with the matching action. Don't self-assign a create_task and call it a day. Tasks are for multi-step work that spans sessions, needs delegation, or genuinely needs tracking. "Add cat photos from the web" is NOT a ticket to create — it's a share_files action with URLs you fetched or found.`,
    ``,
    `DON'T REPEAT YOURSELF. Before composing a reply, check the recent-messages block: if your planned reply is substantially the same as something YOU already posted in this conversation, emit exactly "HEARTBEAT_OK" instead. Never re-post a canned acknowledgment ("I'll finalize it and share it with the team", "Here's X for you!") when you already said it. If the human followed up and you genuinely have a new concrete answer (a different file, a finished deliverable, a specific update), post that — but paraphrase and reference what you already said rather than repeating it verbatim.`,
    ``,
    `Action types:`,
    `  {"type":"react","message_id":"<id>","emoji":"🙏"}            — react instead of writing an ack/thanks/agreement`,
    `  {"type":"share_files","conversation_id":"<id>","body_md":"<optional, can be empty>","reply_to":"<optional>","files":[{"url":"https://…","name":"cat.jpg"},{"path":"/tmp/report.pdf","name":"Q3-report.pdf"}]}`,
    `                                                                — each file entry has EXACTLY ONE of "url" (http/https, server fetches it) or "path" (absolute under /tmp/, server reads from disk). Use this to share web assets OR files you just wrote with the browser skill (e.g. browser pdf /tmp/x.pdf → share_files path /tmp/x.pdf). Up to 10 files, 20MB each. This replaces the old urllib/curl + /agent-api/uploads + <attachments> dance — always prefer share_files.`,
    `  {"type":"create_task","title":"…","body_md":"…","status":"backlog|in_progress|review|done","conversation_id":"<optional channel>","parent_id":"<optional parent task_…>","assignees":["<memberId>","<memberId>"],"labels":["eng"],"due_at":"2026-05-01"}`,
    `  {"type":"update_task","task_id":"task_…","status":"in_progress|review|done","progress":50,"title":"…","body_md":"…","due_at":"2026-05-01","archived":true}`,
    `  {"type":"assign_task","task_id":"task_…","member_id":"m_…"}`,
    `  {"type":"task_comment","task_id":"task_…","body_md":"…","mentions":["m_…"],"attachments":[<optional, hand-rolled descriptors from /uploads>]}`,
    `  {"type":"share_to_task","task_id":"task_…","body_md":"progress note","files":[{"url":"https://…","name":"snapshot.png"},{"path":"/tmp/report.pdf","name":"Q3.pdf"}]}`,
    `                                                                — mirror of share_files but attaches to a task card. Use this to drop progress updates + artifacts (screenshots, PDFs, data files) on tasks you're working on during heartbeats. Files show up on the task AND in the workspace Files tab.`,
    `  {"type":"open_thread","message_id":"<id>","body_md":"…"}      — start a thread reply on a specific message`,
    ``,
    `Use the Member IDs block above to fill assignees / mentions / member_id fields — those fields take memberIds (m_…), NOT handles.`,
    `Emit as many actions as needed in one block. If a user asks for 5 tasks, create 5 create_task entries.`,
    `If your only job this turn is to do actions (no chat reply needed), leave your prose body empty — the actions still run and no "thinking" message posts. Otherwise write a short reply naming the concrete outcomes (e.g. "Created task_xyz, assigned to @ada").`,
    ``,
    `TOOLS (read-only context lookups via your terminal skill — use when you need older context not already in the packet):`,
    `  Your container exposes CC_API_BASE=${API_BASE} and CC_BOT_TOKEN=<your bot token> as env vars — read from those, never hardcode.`,
    entry.kind === "openclaw" || typeof entry.openclawHome === "string"
      ? `  You have \`curl\` available. Example: curl -s -H "Authorization: Bearer $CC_BOT_TOKEN" "$CC_API_BASE/agent-api/tasks"`
      : `  Your container has python3 but no curl. Use urllib:\n    python3 -c 'import os,urllib.request as u;r=u.Request(f"{os.environ[\\"CC_API_BASE\\"]}/agent-api/tasks",headers={"Authorization":f"Bearer {os.environ[\\"CC_BOT_TOKEN\\"]}"});print(u.urlopen(r).read().decode())'`,
    `  — GET /agent-api/conversations`,
    `  — GET /agent-api/messages?conversationId=<id>&limit=50&before=<iso>&parentId=<id>`,
    `  — GET /agent-api/thread?messageId=<id>`,
    `  — GET /agent-api/search?q=<text>&limit=20[&conversationId=<id>]`,
    `  — GET /agent-api/members`,
    `  — GET /agent-api/tasks                               — list all tasks on the workspace board`,
    `  — GET /agent-api/tasks/<id>                          — full task + subtasks + links + comments`,
    `  — POST /agent-api/browser  body:{"cmd":"open|snapshot|get text|click|find role|eval|close|…","args":[…]}  — drive a real headless Chromium on the host (shared across all agents). See the \`browser/agent-browser\` skill for full command reference and recipes. Prefer plain \`curl\` for static pages; reach for this when JS must render or you need to click/fill. Always close the session when you're done.`,
    `  — POST /agent-api/uploads   (multipart file upload; returns {key,name,contentType,size,url})`,
    `If a user attaches a file, the attachment line shows the URL — you can curl it directly with your Bearer header.`,
    `To send a file back: (1) upload with curl -s -X POST -H "Authorization: Bearer <token>" -F file=@/path ${API_BASE}/agent-api/uploads — this returns JSON {key,name,contentType,size,url}. (2) End your reply with an <attachments> block containing a JSON array of one or more of these descriptors, e.g.: <attachments>[{"key":"u/ab12/foo.pdf","name":"foo.pdf","contentType":"application/pdf","size":12345,"url":"/files/u/ab12/foo.pdf"}]</attachments>. The block will be stripped from your message body before it posts.`,
    ``,
    `PREFER the <actions> block over curl for anything listed as an action type above. Curl is only for read-only context lookups and file uploads.`,
    `Don't promise OR claim an action without emitting the matching <actions> entry in the same turn. BOTH "I'll create the tasks" AND "Here's the tasks I created" without an <actions> block are broken promises. If your reply says "here's X", "sharing X", "attached X", "posted X" — the matching action MUST be in the same <actions> block this turn. Empty prose like "Here's a cat photo!" with no share_files action is a LIE, not a reply.`,
    `If the user asks for a "cat photo" and you have no specific URL: use https://cataas.com/cat?width=600 (public, no auth). For multiple, add ?type=cute, ?tag=funny, etc. Don't refuse for lack of a URL — use a sensible public source and emit the share_files action.`,
  ].join("\n");

  let taskBlock = "";
  if (packet.task) {
    const t = packet.task;
    const assignLine = t.assigneeHandles?.length
      ? `Assignees: ${t.assigneeHandles.map((h) => "@" + h).join(", ")}`
      : "Assignees: (none)";
    const subsLine = (t.subtasks || []).length
      ? `\nSubtasks:\n${t.subtasks.map((s) => `  [${s.status === "done" ? "x" : " "}] ${s.title} (${s.id})`).join("\n")}`
      : "";
    const commentsLine = (t.recentComments || []).length
      ? `\nRecent comments:\n${t.recentComments.map((c) => `  @${c.memberHandle}: ${String(c.bodyMd).slice(0, 200)}`).join("\n")}`
      : "";
    const sourceLine = t.conversationName ? `From channel: #${t.conversationName}` : null;
    taskBlock = [
      ``,
      `TASK (id ${t.id}) — status: ${t.status}${t.progress ? ` · progress ${t.progress}%` : ""}${t.dueAt ? ` · due ${t.dueAt.slice(0, 10)}` : ""}`,
      `Title: ${t.title}`,
      t.bodyMd ? `Description: ${t.bodyMd}` : null,
      sourceLine,
      t.labels?.length ? `Labels: ${t.labels.join(", ")}` : null,
      assignLine,
      subsLine ? subsLine.trimStart() : null,
      commentsLine ? commentsLine.trimStart() : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  // Agent's open workload — shown on every trigger so the agent can pick
  // up a task on heartbeats instead of just waiting for mentions. Sorted
  // freshest-activity-first by context.ts.
  let myTasksBlock = "";
  const mt = Array.isArray(packet.myTasks) ? packet.myTasks : [];
  if (mt.length) {
    const lines = mt.slice(0, 12).map((t) => {
      const due = t.dueAt ? ` · due ${String(t.dueAt).slice(0, 10)}` : "";
      const prog = t.progress ? ` · ${t.progress}%` : "";
      const convHint = t.conversationName ? ` · from #${t.conversationName}` : "";
      const latest = t.latestComment
        ? `\n      ↳ @${t.latestComment.memberHandle}: ${String(t.latestComment.bodyMd).slice(0, 140).replace(/\n/g, " ")}`
        : "";
      return `  • ${t.id} [${t.status}${prog}${due}${convHint}] ${t.title}${latest}`;
    });
    const tail = taskOnly
      ? [
          ``,
          `TASK-ONLY MODE — READ THIS CAREFULLY.`,
          `No channel is attached to this heartbeat. You have NO chat surface. Prose you write has nowhere to land and will be dropped silently by the bridge. If you emit only prose and no <actions> block this turn, you accomplished nothing — the work queue advances zero, the team sees nothing.`,
          ``,
          `The ONLY way to make progress this turn is to emit one or more of these actions in an <actions>[...]</actions> block:`,
          `  • {"type":"share_to_task","task_id":"task_…","body_md":"what I just did","files":[{"url":"…"}|{"path":"/tmp/…"}]}  — attach an artifact (screenshot, PDF, data, written-out answer)`,
          `  • {"type":"task_comment","task_id":"task_…","body_md":"specific, concrete update"}  — narrate progress concretely (NOT "still working on it")`,
          `  • {"type":"update_task","task_id":"task_…","progress":<0-100>,"status":"in_progress|review|done"}  — bump progress or flip status when you hit a milestone`,
          ``,
          `Pick the most-stale task above that's ACTUALLY IN YOUR LANE and do one concrete thing on it right now. A good turn produces at least one share_to_task OR task_comment with a specific deliverable attached or named. "I will look into X" is not a turn — "attached Q3 competitor table (pdf) pulled from tracker" is.`,
          ``,
          `If no task in the list is in your lane, or you genuinely have nothing to add on any of them, reply with exactly "HEARTBEAT_OK" — empty prose with no action is the worst possible output.`,
          `NEVER emit post_message or any conversation-bound action in task-only mode — there is no conversation.`,
        ]
      : [
          ``,
          `On a quiet heartbeat, pick the most-stale one that's actually in your lane and make visible progress on it: use share_to_task to drop artifacts (screenshots, PDFs, data, written-out answers), task_comment to narrate what you did, and update_task to bump progress / flip status. Don't announce in chat — the activity log shows it. Keep comments specific: "attached Q3 competitor table (pdf)" not "working on it".`,
        ];
    myTasksBlock = [
      ``,
      `YOUR OPEN TASKS (${mt.length} assigned, not done — freshest first):`,
      ...lines,
      ...tail,
    ].join("\n");
  }

  const sections = taskOnly
    ? [
        identity,
        ``,
        `You are currently in ${convLabel}.${colleaguesLine}${reportingLine}${memberIdBlock}`,
        myTasksBlock,
        ``,
        triggerLine,
        toolBlock,
        ``,
        `Your reply body will be dropped — there is no conversation to post into. The ONLY valid output this turn is either (a) an <actions>[...]</actions> block doing real work on a task, or (b) exactly "HEARTBEAT_OK". No prose, no receipts, no "I will…".`,
      ]
    : [
        identity,
        ``,
        `You are currently in ${convLabel}.${topicLine}${othersLine}${colleaguesLine}${reportingLine}${memberIdBlock}`,
        threadBlock,
        taskBlock,
        myTasksBlock,
        ``,
        `Recent messages in this conversation (most recent last):`,
        history || "(no prior messages)",
        otherConvSummary,
        ``,
        triggerLine,
        toolBlock,
        ``,
        `Reply briefly (1–2 sentences unless asked for more). Write only the reply text — no greetings, no sign-off, no markdown code fences around your reply.`,
      ];
  return sections.join("\n");
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

    // Scheduled beats with no new activity → skip, don't wake Hermes UNLESS
    // the agent has open tasks. In that case fall through into a "task-only"
    // run: no conv attached, the prompt's YOUR OPEN TASKS block gives the
    // agent something to act on (share_to_task / task_comment / update_task).
    // Ambient beats are allowed through even when the inbox is bare: the whole
    // point is to let the agent post on a quiet channel.
    const hasMyTasks = Array.isArray(p.myTasks) && p.myTasks.length > 0;
    if (trigger === "scheduled" && inbox.length === 0 && !hasMyTasks) {
      return reply({ status: "HEARTBEAT_OK" });
    }
    const conv = inbox[0]; // may be undefined in task-only mode
    if (!conv && !hasMyTasks) return reply({ status: "HEARTBEAT_OK" });

    // The conv-bound guards (addressed-to-someone-else, self-last, DM) only
    // make sense when there IS a conv. In task-only mode we skip them and go
    // straight to the prompt — there's no chat surface to be quiet about.
    let inDm = false;
    let replyTo = undefined;
    let last = undefined;
    if (conv) {
      // If a recent message in the primary conversation @-mentioned a specific
      // colleague who isn't me, this scheduled/channel_post beat isn't my turn.
      // Stay silent without even calling Hermes — saves tokens AND prevents
      // piggybacks.
      if (
        (trigger === "scheduled" || trigger === "channel_post") &&
        recentlyAddressedToSomeoneElse(conv.messages, entry.handle)
      ) {
        console.log(`[${entry.handle}] ${trigger} → skip (conversation addressed to someone else)`);
        return reply({ status: "HEARTBEAT_OK" });
      }

      // Self-last guard: if the most recent message is from THIS agent and
      // we have no tasks to push on, an ambient/scheduled wake has nothing
      // to add. With pending tasks, fall through — the agent might do task
      // work even though chat is quiet.
      if (trigger === "ambient" || trigger === "scheduled") {
        const lastMsg = conv.messages?.[conv.messages.length - 1];
        if (lastMsg && lastMsg.memberHandle === entry.handle && !hasMyTasks) {
          console.log(`[${entry.handle}] ${trigger} → skip (self was last to post)`);
          return reply({ status: "HEARTBEAT_OK" });
        }
      }
      last = conv.messages?.[conv.messages.length - 1];
      // `last` may be missing for ambient beats on quiet channels — that's fine.
      if (!last && trigger !== "ambient" && !hasMyTasks) return reply({ status: "HEARTBEAT_OK" });

      inDm = conv.conversationKind === "dm";
      // DMs are 1:1 and private. Another agent being @-mentioned inside
      // someone else's DM must not drag us in.
      if (inDm) {
        const dmMembers = Array.isArray(conv.conversationMembers) ? conv.conversationMembers : [];
        const myMemberId = p.agent?.memberId;
        if (myMemberId && !dmMembers.includes(myMemberId)) {
          console.log(`[${entry.handle}] ${trigger} → skip (not a DM participant)`);
          return reply({ status: "HEARTBEAT_OK" });
        }
      }
      replyTo = inDm ? undefined : p.thread?.rootMessageId ?? undefined;
    }

    console.log(
      `[${entry.handle}] ${trigger} ${conv ? `conv=${conv.conversationId} body="${String(last?.bodyMd ?? "(quiet)").slice(0, 50)}"` : `task-only (${p.myTasks?.length ?? 0} open)`}`,
    );

    const prompt = buildPrompt(entry, p);
    try {
      const isOpenClaw = entry.kind === "openclaw" || typeof entry.openclawHome === "string";
      const { stdout, stderr } = isOpenClaw
        ? await callOpenClaw(prompt, entry.openclawHome, entry.token)
        : await callHermes(prompt, entry.hermesHome, entry.token);
      const rawText = isOpenClaw
        ? (extractOpenClawReply(stdout) || extractOpenClawReply(stderr) || "")
        : (extractReply(stdout) || extractReply(stderr) || "");
      // Hermes produced nothing usable (crash, SIGTERM, empty streams). Stay
      // silent rather than posting "(empty reply)" as text — always safer.
      if (!rawText.trim()) {
        console.log(`[${entry.handle}] ${trigger} → skip (empty/crashed reply)`);
        return reply({ status: "HEARTBEAT_OK" });
      }
      // Silence-allowed triggers: model is permitted to skip a post by returning
      // HEARTBEAT_OK. `mention` is here only for agent→agent mentions (the
      // prompt forbids it on human mentions, and the executor's reply-guard
      // would also reject HEARTBEAT_OK as `heartbeat_leaked` if it slipped
      // through). Keeping it on the whitelist avoids misleading
      // `heartbeat_leaked` errors in run logs when agents legitimately stay
      // quiet on a colleague's @-mention. Exact match here so a valid
      // `<actions>` block following HEARTBEAT_OK still gets extracted +
      // executed below — the text "HEARTBEAT_OK" left over as body will be
      // rejected by the reply-guard on the API side.
      if (
        (trigger === "scheduled" ||
          trigger === "thread_reply" ||
          trigger === "ambient" ||
          trigger === "mention" ||
          trigger === "task_assigned" ||
          trigger === "task_comment") &&
        /^\s*HEARTBEAT_OK\s*$/i.test(rawText)
      ) {
        return reply({ status: "HEARTBEAT_OK" });
      }
      // Order matters: pull the <actions> side-channel first, then
      // <attachments>, so the actions JSON can't accidentally be matched
      // by the attachments regex.
      const afterActions = extractActions(rawText);
      const afterAtt = extractAttachments(afterActions.body);
      const body = afterAtt.body;
      const attachments = afterAtt.attachments;
      const sideActions = afterActions.actions;
      const actions = [];
      // Only emit a post_message if there's something to say AND we have a
      // conversation to post into. In task-only mode (scheduled wake with
      // empty inbox + open tasks), conv is undefined — the agent's prose
      // would have nowhere to land, so we drop it and let the side-actions
      // (task_comment / share_to_task / update_task) carry the work.
      if (body && body.trim() && conv) {
        actions.push({
          type: "post_message",
          conversation_id: conv.conversationId,
          body_md: body,
          ...(replyTo ? { reply_to: replyTo } : {}),
          ...(attachments.length ? { attachments } : {}),
        });
      } else if (body && body.trim() && !conv) {
        console.log(`[${entry.handle}] task-only: dropping ${body.length}-char prose (no conv to post into)`);
      }
      for (const a of sideActions) actions.push(a);
      console.log(
        `[${entry.handle}] replying, len=${body.length}, att=${attachments.length}${sideActions.length ? `, actions=${sideActions.length} (${sideActions.map((a) => a.type).join("+")})` : ""}`,
      );
      if (actions.length === 0) return reply({ status: "HEARTBEAT_OK" });
      reply({
        actions,
        trace: [`${entry.handle} responded, len=${body.length}${attachments.length ? `, att=${attachments.length}` : ""}${sideActions.length ? `, actions=${sideActions.length}` : ""}`],
      });
    } catch (e) {
      console.error(`[${entry.handle}] error: ${e.message.split("\n")[0]}`);
      // Without a conversation we have nowhere to post the error, just trace it.
      reply({
        actions: conv
          ? [
              {
                type: "post_message",
                conversation_id: conv.conversationId,
                body_md: `⚠️ ${entry.name} error: \`${e.message.split("\n")[0].slice(0, 300)}\``,
                ...(replyTo ? { reply_to: replyTo } : {}),
              },
            ]
          : [],
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
