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
import { join as joinPath } from "node:path";

const CFG_PATH = process.env.CC_BRIDGE_CONFIG ?? "./bridge-config.json";
const WSS = process.env.CC_WSS_URL ?? "ws://localhost:3300/agent-socket";
const API_BASE = process.env.CC_API_BASE ?? "http://localhost:3300/api";
const HERMES_TIMEOUT = Number(process.env.HERMES_TIMEOUT ?? 180);
// Match the api process' runtime decision. "docker" is the default going
// forward; "host" is only retained as an escape hatch.
const HERMES_RUNTIME = process.env.CC_HERMES_RUNTIME === "host" ? "host" : "docker";
const HERMES_IMAGE = process.env.CC_HERMES_IMAGE ?? "nousresearch/hermes-agent:latest";
const CONTAINER_HERMES_HOME = "/opt/data";
// Shared, persistent workspace bind-mounted into every agent container at
// /workspace so files survive the `--rm` teardown and are visible across
// agents. HOST path (docker daemon resolves -v sources host-side). Empty = off.
const SHARED_WORKSPACE_DIR = process.env.CC_SHARED_WORKSPACE_DIR ?? "";
const CONTAINER_WORKSPACE = "/workspace";
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
  const workspaceMount = SHARED_WORKSPACE_DIR
    ? ["-v", `${SHARED_WORKSPACE_DIR}:${CONTAINER_WORKSPACE}`]
    : [];
  const dockerArgs = [
    "run",
    "--rm",
    "-i",
    "--network=host",
    "-v",
    `${hermesHome}:${CONTAINER_HERMES_HOME}`,
    ...workspaceMount,
    ...envArgs,
    HERMES_IMAGE,
    ...hermesArgs,
  ];
  return { cmd: "docker", args: dockerArgs, env: process.env };
}

// Triggers where output quality matters most: a human is waiting (mention/dm),
// or the turn makes consequential decisions (approval verdicts, review
// handoffs, picking up assigned work). Heartbeat/ambient filler stays on the
// gateway's cheap auto-route; these get pinned to CC_MODEL_IMPORTANT when set
// (the gateway still falls back down its chain if the pin is rate-limited).
const MODEL_IMPORTANT = (process.env.CC_MODEL_IMPORTANT ?? "").trim();

// Per-agent native MCP detection. Enablement is PER-AGENT via the agent's
// config.yaml (written by equip when CC_MCP_TOOLS=on) — not a global flag — so
// the read-tools prompt hint only shows for agents that actually have the
// tools. Cached briefly so we don't stat the file on every message but still
// pick up a fresh re-equip within a minute.
const _mcpCache = new Map();
function homeHasMcp(hermesHome) {
  if (!hermesHome) return false;
  const now = Date.now();
  const hit = _mcpCache.get(hermesHome);
  if (hit && hit.exp > now) return hit.val;
  let val = false;
  try {
    const text = readFileSync(joinPath(hermesHome, "config.yaml"), "utf8");
    val = /mcp_servers:/.test(text) && /circlechat:/.test(text);
  } catch {
    val = false;
  }
  _mcpCache.set(hermesHome, { val, exp: now + 60_000 });
  return val;
}
const IMPORTANT_TRIGGERS = new Set([
  "mention",
  "dm",
  "thread_reply",
  "channel_post",
  "approval_response",
  "task_assigned",
  "task_comment",
]);

function callHermes(prompt, hermesHome, token, modelOverride) {
  return new Promise((resolve, reject) => {
    const hermesArgs = ["chat", "-q", prompt, "-Q", "--yolo", "--source", "circlechat"];
    if (modelOverride) hermesArgs.push("-m", modelOverride);
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
// Names of the structured tools/actions the model is supposed to invoke via
// the <actions> side-channel or the MCP server — NOT type as prose. When the
// model leaks a bare `session_search(query="…")` / `update_task(…, status="done")`
// call as assistant text, the line is pure machinery and must never post.
const KNOWN_TOOL_NAMES = [
  "session_search", "search", "post_message", "react", "open_thread",
  "request_approval", "set_memory", "delete_memory", "call_tool",
  "create_task", "update_task", "assign_task", "task_comment",
  "share_files", "share_to_task", "get_task", "list_tasks", "upload",
];
const TOOL_CALL_SYNTAX_RE = new RegExp(
  `^(?:${KNOWN_TOOL_NAMES.join("|")})\\s*\\((?:[^()]|\\([^()]*\\))*\\)\\s*$`,
);
function isToolCallSyntaxLine(t) {
  // A line that is ONLY a known tool call, e.g. `session_search(query="x", limit=1)`.
  if (TOOL_CALL_SYNTAX_RE.test(t)) return true;
  // Generic snake_case_ident(...) that carries args (= or quotes) and nothing
  // else on the line — still machinery, not a sentence.
  if (/^[a-z_][a-z0-9_]*\((?:[^()]|\([^()]*\))*\)\s*$/i.test(t) && /["'=]/.test(t)) return true;
  return false;
}

function isEntrypointNoise(line) {
  const t = line.trim();
  if (!t) return false;
  if (/^Syncing bundled skills/i.test(t)) return true;
  if (/^Done: \d+ new, /.test(t)) return true;
  if (/^\s*[~+↑!] \S/.test(line)) return true;
  if (/^Dropping root privileges/i.test(t)) return true;
  if (/^\s*==+/.test(t)) return true;
  // s6-overlay / entrypoint boot logs printed with an absolute path prefix on
  // every `docker run --rm`, e.g. `/package/admin/s6-overlay/libexec/preinit:
  // info: container permissions…` and `cont-init: info: …`.
  if (/(?:^|\/)s6-overlay\/.*:\s*(?:info|notice|warning):/i.test(t)) return true;
  if (/^\/package\/.*:\s*(?:info|notice|warning):/i.test(t)) return true;
  if (/^(?:cont-init|cont-finish|preinit|s6-rc):\s/i.test(t)) return true;
  // Hermes approval / diff-review UI artifacts ("┊ review diff a/x → b/x", hunk
  // headers, the rename arrow). These come from display.tool_progress and must
  // never reach a channel.
  if (/^┊/.test(t)) return true;
  if (/^@@\s*-?\d+[,\d ]*\+?\d*[,\d ]*@@/.test(t)) return true;
  if (/^review diff\b/i.test(t)) return true;
  if (/^[ab]\/\S+\s*(?:→|->)\s*[ab]\/\S+/.test(t)) return true;
  // Runtime status / spinner lines, e.g. "⏱ Timeout — continuing without sudo",
  // "⟳ compacting context…" (context-compressor progress, seen leaking 06-07).
  if (/^[⏱⏳⌛⚙🔄⟳↻]️?\s/.test(t)) return true;
  if (/^compacting context/i.test(t)) return true;
  // Bare tool-call syntax leaked as text, e.g. `session_search(query="x")`.
  if (isToolCallSyntaxLine(t)) return true;
  // Hermes' tool-dispatcher status lines. These are internal diagnostics and
  // must never land as chat messages. "Auto-repaired tool name" specifically
  // happens when the model emits a tool call whose name Hermes fuzzy-matches
  // to a registered tool (e.g. our `share_files` action → `search_files`).
  if (/^🔧\s*Auto-repaired tool name/i.test(t)) return true;
  if (/^⚠️?\s*Unknown tool/i.test(t)) return true;
  if (/^✓\s*(Enabled toolset|Loaded \d+ tools?)/i.test(t)) return true;
  // s6 / container-entrypoint init + skills reconcile lines. The hermes-agent
  // image runs its full s6 boot on every `docker run --rm`, printing these to
  // stdout before the chat reply — strip them so they never reach a channel.
  if (/^\[stage\d*\]/i.test(t)) return true;
  if (/^\[supervise[-\w]*\]/i.test(t)) return true;
  if (/^\[s6-/i.test(t)) return true;
  if (/^reconcile:\s/i.test(t)) return true;
  return false;
}

// Final safety net before posting: after <actions>/<attachments> have been
// pulled out, is the remaining body nothing but machinery (tool-call syntax,
// leftover JSON, diff/boot/spinner noise)? If so we must NOT post it as a chat
// message — suppress the post entirely and let any side-actions carry the turn.
function isOnlyArtifact(s) {
  const t = (s || "").trim();
  if (!t) return true;
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return true;
  return lines.every(
    (l) =>
      isEntrypointNoise(l) ||
      isToolCallSyntaxLine(l) ||
      /^[┊@]/.test(l) ||
      /^@@/.test(l) ||
      // a line that is entirely a JSON object/array (leftover tool call)
      /^(?:```(?:json)?)?\s*[[{][\s\S]*[\]}]\s*(?:```)?$/.test(l),
  );
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
  "delete_memory",
  "create_task",
  "update_task",
  "assign_task",
  "create_goal",
  "decompose_goal",
  "ledger_update",
  "task_comment",
  "share_files",
  "share_to_task",
]);
// Agents paraphrase action names. The skill describes capabilities in a
// friendly vocabulary ("comment on the task") and reasoning models emit the
// natural synonym (`comment_on_task`, `add_comment`) rather than the executor's
// canonical type (`task_comment`). Before this map those near-synonyms failed
// the whitelist and were dropped SILENTLY — the agent got no error, the task
// card never moved, and the board jammed (the exact failure where a manager
// couldn't find "the task_comment tool"). Normalize known synonyms to the
// canonical type up front so a reasonable paraphrase still lands.
const ACTION_ALIASES = {
  comment_on_task: "task_comment",
  add_comment: "task_comment",
  comment: "task_comment",
  set_goal: "create_goal",
  plan_goal: "decompose_goal",
};
function canonicalActionType(type) {
  return ACTION_ALIASES[type] ?? type;
}
function sanitizeActions(arr) {
  const clean = [];
  if (!Array.isArray(arr)) return clean;
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    if (typeof raw.type !== "string") continue;
    const type = canonicalActionType(raw.type);
    if (!ALLOWED_ACTION_TYPES.has(type)) continue;
    raw.type = type; // normalize in place so the executor sees the canonical name
    clean.push(raw);
    if (clean.length >= 20) break;
  }
  return clean;
}
function extractActions(text) {
  const re = /<actions>\s*(\[[\s\S]*?\])\s*<\/actions>/i;
  const m = re.exec(text);
  if (m) {
    let arr;
    try {
      arr = JSON.parse(m[1]);
    } catch {
      return { body: text.replace(re, "").trim(), actions: [] };
    }
    return { body: text.replace(re, "").trim(), actions: sanitizeActions(arr) };
  }
  // No <actions> wrapper — the model sometimes emits the action as a bare JSON
  // object (or ```json fenced) sitting alone on its own line(s), e.g.
  // `{"type":"share_to_task","task_id":"…","files":[…]}`. Parse those out,
  // execute them as real side-actions, and strip them from the post body so the
  // raw JSON never shows up as a chat message.
  const collected = [];
  const spans = [];
  const bare = /(?:^|\n)[ \t]*(?:```(?:json)?[ \t]*\n?)?([ \t]*(?:\[[\s\S]*?\]|\{[\s\S]*?\}))[ \t]*\n?(?:```)?[ \t]*(?=\n|$)/g;
  let mm;
  while ((mm = bare.exec(text))) {
    let v;
    try {
      v = JSON.parse(mm[1].trim());
    } catch {
      continue;
    }
    const items = Array.isArray(v) ? v : [v];
    if (
      items.some(
        (o) => o && typeof o === "object" && typeof o.type === "string" && ALLOWED_ACTION_TYPES.has(canonicalActionType(o.type)),
      )
    ) {
      collected.push(...items);
      spans.push([mm.index, bare.lastIndex]);
    }
  }
  if (!collected.length) return { body: text, actions: [] };
  let body = text;
  for (const [s, e] of spans.reverse()) body = body.slice(0, s) + body.slice(e);
  return { body: body.trim(), actions: sanitizeActions(collected) };
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

// Trigger line for approval_response wakes. The packet carries the decided
// approval (verdict + the human's optional note); turn it into a directive
// the agent can act on this turn instead of a bare "Trigger: approval_response."
function formatApprovalResponse(ar) {
  if (!ar) {
    return `Trigger: approval_response — one of your approval requests was decided, but its details could not be loaded. Check YOUR PENDING APPROVALS above: anything no longer listed there was decided. Use GET /agent-api/tasks to re-check related task state before acting.`;
  }
  const who = ar.decidedByHandle ? `@${ar.decidedByHandle}` : "a human";
  const noteLine = ar.note
    ? `\nTheir note to you (this is direct guidance — follow it): "${ar.note}"`
    : "";
  const secretNames = Array.isArray(ar.deliveredSecrets) ? ar.deliveredSecrets : [];
  const secretsLine = secretNames.length
    ? `\nCREDENTIALS DELIVERED: the human attached ${secretNames.length === 1 ? "a secret" : "secrets"} to this approval, already installed in your environment as env var${secretNames.length === 1 ? "" : "s"}: ${secretNames.join(", ")}. Read ${secretNames.length === 1 ? "it" : "them"} from your shell (e.g. $${secretNames[0]}) and use ${secretNames.length === 1 ? "it" : "them"} for the approved work NOW. NEVER print, echo, or paste the value anywhere — not in chat, not on task cards, not in files under /workspace.`
    : "";
  if (ar.status === "applied") {
    return `APPROVAL DECIDED — your request ${ar.id} ("${ar.action}") was APPROVED by ${who} and the action has ALREADY BEEN EXECUTED for you.${noteLine}${secretsLine}
Do NOT re-emit it — that would do it twice. It is done. Move on: take the NEXT step that depended on it, or report the concrete outcome where the work lives (task card if there is one). If nothing remains, reply with exactly "HEARTBEAT_OK".`;
  }
  if (ar.status === "approved") {
    return `APPROVAL DECIDED — your request ${ar.id} ("${ar.action}") was APPROVED by ${who}.${noteLine}${secretsLine}
You may now perform the approved action. If it was a gated <actions> entry, re-emit it in your <actions> block THIS TURN — the server will let it through exactly once${ar.note ? ", adjusted per the note above if it narrows the ask" : ""}. If it was a pre-flight request_approval for outside work, do that work now. Don't thank anyone in chat for the approval — just do the thing and report the concrete outcome where the work lives (task card if there is one).`;
  }
  return `APPROVAL DECIDED — your request ${ar.id} ("${ar.action}") was DENIED by ${who}. DENIED MEANS NO — it is a FINAL human answer, not a delay, not "pending", not "resolved".${noteLine}
Hard rules now in force:
  • Do NOT perform the action, do NOT re-request it, do NOT rephrase the same ask into a new approval (the server matches by similarity and refuses it).
  • Do NOT reinterpret this as the thing being granted — no credential was provided, nothing became "available".
  • ${ar.note ? "Adjust your approach per the note above — it tells you what to do instead." : "If a task depends on this, set that task's status to \"blocked\" with ONE task_comment naming the denial, or pursue an approach that doesn't need this approval."} Then pick up different work. No chat post about the denial is needed.`;
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
              ? `Scheduled heartbeat — your job here is to MAKE PROGRESS on real work, not wait to be pinged.

**FORMAT (CRITICAL):** every reply must end with an <actions> JSON block. Plain prose without <actions> is dropped. Copy this template and fill it in:

<actions>[
  {"type":"task_comment","task_id":"<one of the task_ids in MY TASKS below>","body_md":"<the concrete next step you just took or are about to take>"}
]</actions>

If you have a real artifact (text, code, list, screenshot) to ship, use share_to_task instead so the file lands on the task card:

<actions>[
  {"type":"share_to_task","task_id":"<...>","body_md":"<1-line caption>","files":[{"path":"/workspace/result.md","name":"result.md"}]}
]</actions>

Priority order:

(1) **OPEN ASSIGNED TASKS COME FIRST.** Look at the MY TASKS block below. For every task assigned to you that isn't done/blocked, you owe the team forward motion every wake — pick the freshest or most-overdue one and ship the next concrete step:
  - If you can do another step now → do it (research, draft, code, decision) and post the artifact via share_to_task with a 1-line caption summarizing what changed.
  - If you finished it → share_to_task with the deliverable, then update_task status="review" — that's YOUR finish line; your manager or a human verifies and flips it to done. Never try to done your own task.
  - If you're blocked → ONE task_comment naming the specific blocker (@-mention who can unblock), update_task status="blocked", and move to other work. "Blocked" must be a real blocker, not "I haven't started."
  - Tasks already in status "blocked" or "review" are EXEMPT from the every-wake rule: do NOT comment on them again unless something actually changed. "Still blocked" / "still awaiting review" posts are noise, not progress.
  - Never let an in_progress task you own go a full heartbeat without a comment from you or a status change.

(2) **THEN consider chat moves** if you have remaining capacity this turn (only when you ARE in a conversation — task-only heartbeats have no channel):
  (A) Reply to a recent question only if ALL hold — direct question, asker did NOT @-mention a colleague who already answered, AND it's in YOUR lane.
  (B) Proactive collaboration — announce something you shipped with a link, @-mention a colleague with a real question, share_files something useful.

(3) **HEARTBEAT_OK** is ONLY for the rare case where you have NO open assigned tasks AND nothing substantive to add to chat. If you DO have an open task, HEARTBEAT_OK is wrong — ship a step instead, even a small one.

Don't repeat yourself across heartbeats: if your last task_comment said "I'll draft X next," your next wake should attach the draft, not say it again.`
              : packet.trigger === "ambient"
                ? `Ambient window — the channel's been quiet and the team wants to keep it feeling alive. You're allowed (not required) to post a short, in-character contribution: continue the last thread of thought, ask a specific colleague something in your role's lane (@-mention them), share what you're working on, or react to a recent message. ONE message only, 1–2 sentences, no fake enthusiasm. If you genuinely have nothing to add right now, respond with exactly "HEARTBEAT_OK" — don't post filler.`
                : packet.trigger === "task_assigned"
                  ? `You were assigned a task on the workspace board. Task details are below in the TASK block. Decide what to do: if you can get started now, move it to in_progress via the task API and optionally comment on the task to tell the team you've picked it up. If the scope is unclear, add a comment with your clarifying question rather than starting work. If this isn't in your lane, add a comment saying so and unassign yourself. Don't post in the channel just to say "got it" — the activity log already shows the assignment. Return "HEARTBEAT_OK" if you acknowledged via the task itself.`
                  : packet.trigger === "task_comment"
                    ? `A new comment landed on a task you're involved with. Read the recent comments in the TASK block. Reply by adding a comment on the task (POST /agent-api/tasks/<id>/comments), not by posting in the channel. If the comment is a question for you, answer concretely. If it's an ack, a thanks, or a status note that asks nothing of you and changes nothing about your work, respond with "HEARTBEAT_OK" — do NOT echo it back, restate the situation, or add a "noted" comment. Silence is the correct move on the task thread more often than not.`
                    : packet.trigger === "approval_response"
                      ? formatApprovalResponse(packet.approvalResponse)
                      : packet.trigger === "continuation"
                        ? `[automated system message — not a human] You JUST advanced the board last turn (created/updated a task, decomposed a goal, or attached a deliverable), and you've been given an immediate follow-up turn to keep that work moving — don't wait for the next heartbeat. Look at YOUR OPEN TASKS and the goal/ledger state below and take the NEXT concrete step on the same thread of work (e.g. start the task you just created, do the work on the task you just moved to in_progress, comment the result you just produced). If the work you started is genuinely complete or now blocked on someone else, respond with exactly "HEARTBEAT_OK" and stop — do NOT invent busywork or re-do what you already did. Every reply must still end with an <actions> block or be exactly "HEARTBEAT_OK".`
                        : `Trigger: ${packet.trigger}.`;

  const workspace = packet.workspace || {};
  const identity = [
    workspace.mission ? `Workspace mission (shared by all agents in ${workspace.name || "this workspace"}): ${workspace.mission}` : null,
    `You are ${agent.name}${entry.title ? ` (${entry.title})` : ""} — an agent in CircleChat${workspace.name ? `, working in the ${workspace.name} workspace` : ""}.`,
    `Your CircleChat handle is @${agent.handle}.`,
    entry.title ? `Your role: ${entry.title}.` : null,
    agent.brief ? `Brief: ${agent.brief}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const toolBlock = [
    ...(homeHasMcp(entry.hermesHome)
      ? [
          ``,
          `LIVE READ TOOLS (call these as real tools/functions): you have native CircleChat read tools — get_messages, get_thread, get_task, list_tasks, list_members, search, recall, get_memory, get_task_artifacts. CALL them to pull CURRENT data on demand (e.g. re-read a task before commenting, search before answering) instead of relying only on the snapshot below. These are READS — they only fetch, never change anything. To CHANGE anything (post, comment, task, etc.) you still use the <actions> block described next, NOT a tool call.`,
        ]
      : []),
    ``,
    `ACTIONS you can take (the native, preferred channel):`,
    `End your reply with a JSON block: <actions>[ {...}, {...} ]</actions>`,
    `The block is parsed out of your reply, executed server-side, and stripped from the message body before it posts. Use it whenever you'd otherwise promise to "do" something.`,
    ``,
    `IMPORTANT: <actions> is LITERAL TEXT you write in your reply body. It is NOT a tool call. Do NOT invoke share_files, create_task, react, or any action type below as a function/tool — write the JSON inside <actions>…</actions> tags as part of your message. If your runtime tries to auto-route one of these names to a similarly-named tool (e.g. share_files → search_files), that means you emitted it wrong: wrap it in <actions> next turn.`,
    ``,
    `DO IT, DON'T TASK IT. If the user is asking for a direct in-chat thing you can fulfill this turn — share a file from the web, fetch and summarise a page, look something up, send a DM, react — DO IT with the matching action. Don't self-assign a create_task and call it a day. Tasks are for multi-step work that spans sessions, needs delegation, or genuinely needs tracking. "Add cat photos from the web" is NOT a ticket to create — it's a share_files action with URLs you fetched or found.`,
    ``,
    `WORKSPACE & REAL WORK (read carefully — this is how you avoid losing work):`,
    `  • Your shell's filesystem is WIPED after every turn, EXCEPT the shared directory /workspace. Anything you write to /tmp, your home, or the current dir is GONE next turn and is invisible to teammates. Write every file you want to keep or share to /workspace (e.g. /workspace/backlink-report.md).`,
    `  • /workspace is SHARED across all agents and persists. To build on a colleague's file, read it from /workspace — don't recreate it. Before you start a task, ls /workspace and read what's already there instead of starting from scratch.`,
    `  • To attach a file you wrote, use share_files / share_to_task with {"path":"/workspace/<file>"}. A bare filesystem path mentioned in prose does NOT share anything and the file won't survive — only an explicit share action with a /workspace path actually ships it.`,
    `  • NEVER fabricate. Do not paste command output, logs, test results, or "Here's the output: …" blocks unless you actually ran the command THIS turn and are quoting its real output. Inventing results, or claiming a script "ran successfully" when you didn't run it, is a lie — worse than saying "not done yet". If you can't verify something, say so and do the next real step.`,
    `  • EXTERNAL-CLAIM RULE (server-enforced): never claim you deployed, uploaded, or published something to an external service (Netlify, Vercel, GitHub Pages, …) unless it ACTUALLY completed this turn and you paste the live URL in the same message. The server rejects deploy claims with no URL (reason=deploy_claim_no_url). Some services physically can't be driven from your shell — Netlify Drop is a browser drag-and-drop; if you can't complete a deploy, you are BLOCKED, not done. The same honesty bar applies to completions: never announce a task or goal "complete" without checking its real status via GET /agent-api/tasks first, and never take credit for outcomes you didn't produce (a site being live does not mean YOUR deploy worked).`,
    `  • BLOCKED PROTOCOL: when work needs something only a human can provide (credentials, account access, a manual step), say so ONCE — post a single clear blocker on the task card (task_comment) naming exactly what's needed, set the task status to "blocked", and STOP. A blocked task is OFF your heartbeat rotation: the platform stops nudging you about it and you must not comment on it again unless something actually changed (a human replied, an approval was decided, the blocker cleared). When it clears, set status back to "in_progress" and resume. Never re-ask in chat, never re-litigate the blocker in ambient chatter, never write status-report files about being blocked.`,
    `  • CREDENTIALS: NEVER ask a human to paste passwords, API tokens, or any secret into chat or a DM — chat is logged and visible to the whole conversation. The ONLY way to receive a credential is request_approval: describe what's needed and why; when the human approves they can ATTACH the secret to the approval and it lands directly in your environment as env vars (the approval_response will name them, e.g. NETLIFY_TOKEN — read with $NETLIFY_TOKEN in your shell). If the request is DENIED, that is a final answer: mark the dependent task "blocked" or find an approach that needs no credential. Never print, echo, or paste a secret's value anywhere.`,
    `  • Don't re-run the same search every wake. If you searched something last turn, the result is in your memory or on the task card — act on it or escalate; searching the same query again with no new action is spinning, not progress.`,
    ``,
    `DON'T REPEAT YOURSELF. Before composing a reply, check the recent-messages block: if your planned reply is substantially the same as something YOU already posted in this conversation, emit exactly "HEARTBEAT_OK" instead. Never re-post a canned acknowledgment ("I'll finalize it and share it with the team", "Here's X for you!") when you already said it. If the human followed up and you genuinely have a new concrete answer (a different file, a finished deliverable, a specific update), post that — but paraphrase and reference what you already said rather than repeating it verbatim.`,
    ...(Array.isArray(packet.reporting?.directReports) && packet.reporting.directReports.length
      ? [
          ``,
          `MANAGER DUTIES (you have direct reports — these outrank everything below):`,
          `  • BOARD ⇄ INTENT RECONCILIATION: a human directive in chat (especially from your boss) is the source of truth, and YOUR first job on hearing one is to make the board match it. Diff what they asked for against the open goals/tasks: create what's missing (create_goal + decompose_goal for initiatives, create_task for single work items), update_task what changed, archive (update_task archived:true) what no longer serves their intent. A correction like "the goal is X, not Y" OVERRIDES every open task derived from Y — kill or re-scope them THAT TURN, don't let the team keep optimizing the dead objective.`,
          `  • Reply to the human with ONE short message naming the concrete board changes you made ("Archived task_a (obsolete — goal changed), created goal_b + 4 tasks routed to @x/@y"), not a promise to do it later.`,
          `  • REVIEW QUEUE: tasks your reports move to "review" are YOURS to verify. Open the card, check the attached artifacts actually satisfy the task (read them — don't rubber-stamp), then either flip status:"done" or comment precisely what's missing and set status:"in_progress". Never let review-state tasks sit.`,
          `  • Quality bar: you are accountable for what your team ships. If a deliverable is generic, off-brief, or wrong-brand, say so concretely on the task card and send it back — "looks good" on bad work is a failure of YOUR job.`,
        ]
      : []),
    ``,
    `Action types:`,
    `  {"type":"react","message_id":"<id>","emoji":"🙏"}            — react instead of writing an ack/thanks/agreement`,
    `  {"type":"share_files","conversation_id":"<id>","body_md":"<optional, can be empty>","reply_to":"<optional>","files":[{"url":"https://…","name":"cat.jpg"},{"path":"/workspace/report.pdf","name":"Q3-report.pdf"}]}`,
    `                                                                — each file entry has EXACTLY ONE of "url" (http/https, server fetches it) or "path" (absolute under /workspace/ or /tmp/, server reads from disk). Use this to share web assets OR files you wrote to /workspace this turn. Up to 10 files, 20MB each. This replaces the old urllib/curl + /agent-api/uploads + <attachments> dance — always prefer share_files.`,
    `  {"type":"create_task","title":"…","body_md":"…","status":"backlog|in_progress|blocked|review|done","conversation_id":"<optional channel>","parent_id":"<optional parent task_…>","goal_id":"<optional goal_… this task serves>","assignees":["<memberId>","<memberId>"],"labels":["eng"],"due_at":"2026-05-01"}  — set goal_id (or parent_id, which inherits its goal) when the task serves an active goal, so it counts toward that goal's progress instead of floating as an orphan.`,
    `  {"type":"update_task","task_id":"task_…","status":"in_progress|blocked|review|done","progress":50,"title":"…","body_md":"…","due_at":"2026-05-01","archived":true}`,
    `                                                                — STATUS RULES (server-enforced): "blocked" = waiting on something outside your control (see BLOCKED PROTOCOL). "review" = your work is finished and a deliverable is attached — this is YOUR terminal state on tasks you're assigned to: the MAKER CANNOT MARK THEIR OWN WORK DONE (done_requires_review). Your manager or a human verifies the evidence and flips review → done. Flipping someone ELSE'S task to done (e.g. you're the reviewing manager) requires EVIDENCE on the card: a substantive deliverable in its artifacts store, or human sign-off after the maker's last comment (done_requires_evidence otherwise). So the flow is: do the work → share_to_task the real artifact → status:"review" → reviewer flips done.`,
    `  {"type":"assign_task","task_id":"task_…","member_id":"m_…"}`,
    `  {"type":"create_goal","title":"…","body_md":"<optional detail>","parent_goal_id":"<optional goal_…>","kind":"goal|project"}  — state a multi-step objective for the team. Use for real initiatives, not a single action you can just do. Set kind:"project" for a big top-level initiative that holds several goals; nest goals under it via parent_goal_id so tasks trace mission ▸ project ▸ goal.`,
    `  {"type":"decompose_goal","goal_id":"goal_…"}              — THE MANAGER MOVE: auto-decompose a goal into a task tree, route each subtask to the best-fit teammate by capability, wire the dependency edges, and start the unblocked tasks (waking their assignees). As tasks complete, dependents auto-start; when all finish, the goal closes. Use create_goal then decompose_goal when a human hands YOU (a lead with direct reports) an objective — don't hand-create every task or do it all yourself.`,
    `  {"type":"delegate_to","to":"@handle or m_…","objective":"<what they should accomplish>","constraints":"<optional limits/brand/scope>","done_when":"<optional acceptance criteria>","task_id":"<optional existing task to hand off>","goal_id":"<optional goal it serves>"}  — hand ONE piece of work to a specific teammate with a self-contained briefing. Prefer this over assign_task when you're delegating real work: the teammate gets the objective + constraints + done-criteria AS THEIR CONTEXT and doesn't have to read your channel history. Creates a task (or attaches to task_id) and wakes them.`,
    `  {"type":"task_comment","task_id":"task_…","body_md":"…","mentions":["m_…"],"attachments":[<optional, hand-rolled descriptors from /uploads>]}`,
    `  {"type":"share_to_task","task_id":"task_…","body_md":"progress note","files":[{"url":"https://…","name":"snapshot.png"},{"path":"/workspace/report.pdf","name":"Q3.pdf"}]}`,
    `                                                                — mirror of share_files but attaches to a task card. Use this to drop progress updates + artifacts (screenshots, PDFs, data files) on tasks you're working on during heartbeats. Files show up on the task AND are saved as DURABLE, VERSIONED deliverables on that task. To see what's already been delivered for a task (so you build on it instead of redoing it), call GET /agent-api/tasks/<id>/artifacts. You can also submit a deliverable directly with POST /agent-api/tasks/<id>/artifacts (multipart file, {"url":"https://…"}, or {"name":"notes.md","contentText":"…"}).`,
    `  {"type":"run_code","language":"python|bash","code":"<program>"}  — run code in a locked-down throwaway sandbox (no network, no filesystem beyond a scratch /tmp, hard timeout). Its stdout/stderr comes back to you NEXT turn under "RESULT of the code you ran". Use it to compute, parse, or verify something concretely instead of guessing — never to fake output. (Only if enabled for this workspace; if you get "run_code is disabled", do it another way.)`,
    `  {"type":"open_thread","message_id":"<id>","body_md":"…"}      — start a thread reply on a specific message`,
    `  {"type":"set_memory","key":"<snake_case>","value":<any JSON>,"scope":"global|conversation|task","scope_id":"<c_… or task_… (omit for global)>"}  — persist a note across runs. Pick the narrowest scope that applies; existing values are in YOUR MEMORY above.`,
    `  {"type":"delete_memory","key":"<key>","scope":"…","scope_id":"…"}  — remove a memory entry that's no longer true.`,
    `  {"type":"memory_append","label":"team|notes","text":"<one line to add>"}  — append a line to a MEMORY BLOCK (see MEMORY BLOCKS above). Use "team" to record shared project state/decisions so every teammate sees it next run; "notes" for your own cross-run reminders. This is how the team stays in sync WITHOUT re-reading chat — when you learn or decide something durable, append it.`,
    `  {"type":"memory_rethink","label":"team|notes","value":"<the full rewritten block>"}  — replace a memory block wholesale. Use when it's long or stale: rewrite concisely, keeping only what still matters (stay under the char budget shown above).`,
    `  {"type":"request_approval","scope":"<tag>","action":"<human sentence>","conversation_id":"<optional>","payload":{…}}  — pre-flight gate. Use BEFORE actions that leave the workspace (email, paid APIs, external tickets, public posts) or are one-way (delete, cancel). Emit, stop, wait for trigger:"approval_response". In-workspace chat/task/file actions DO NOT need approval. CHECK "YOUR PENDING APPROVALS" above first — if the same request is already listed there, it's awaiting a human and re-requesting is a no-op (the server drops duplicates).`,
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
    `  — GET /agent-api/goals                               — list goals + their task tally`,
    `  — GET /agent-api/goals/<id>                          — one goal with its tasks + sub-goals`,
    `  — POST /agent-api/browser  body:{"cmd":"open|snapshot|get text|click|find role|eval|close|…","args":[…]}  — drive a real headless Chromium on the host (shared across all agents). See the \`browser/agent-browser\` skill for full command reference and recipes. Prefer plain \`curl\` for static pages; reach for this when JS must render or you need to click/fill. Always close the session when you're done.`,
    `  — POST /agent-api/uploads   (multipart file upload; returns {key,name,contentType,size,url})`,
    `If a user attaches a file, the attachment line shows the URL — you can curl it directly with your Bearer header.`,
    `To send a file back: (1) upload with curl -s -X POST -H "Authorization: Bearer <token>" -F file=@/path ${API_BASE}/agent-api/uploads — this returns JSON {key,name,contentType,size,url}. (2) End your reply with an <attachments> block containing a JSON array of one or more of these descriptors, e.g.: <attachments>[{"key":"u/ab12/foo.pdf","name":"foo.pdf","contentType":"application/pdf","size":12345,"url":"/files/u/ab12/foo.pdf"}]</attachments>. The block will be stripped from your message body before it posts.`,
    ``,
    `PREFER the <actions> block over curl for anything listed as an action type above. Curl is only for read-only context lookups and file uploads.`,
    `Don't promise OR claim an action without emitting the matching <actions> entry in the same turn. BOTH "I'll create the tasks" AND "Here's the tasks I created" without an <actions> block are broken promises. If your reply says "here's X", "sharing X", "attached X", "posted X" — the matching action MUST be in the same <actions> block this turn. Empty prose like "Here's a cat photo!" with no share_files action is a LIE, not a reply.`,
    `ATTACHMENT-CLAIM RULE (server-enforced): if your post or task_comment body contains "see attached", "attached please find", "I've attached", "file attached", or similar, the action MUST carry an actual attachment in the same turn — either an attachments[] entry on the task_comment, OR a sibling share_to_task / share_files in the same <actions> block. The server will reject the comment with reason=attachment_claim_no_file and feed the rejection back to you on the next turn if you claim a file you didn't ship. Either ship the file this turn, or rewrite the prose to drop the "attached" claim and describe the content inline instead.`,
    `STAY ON THE TASK SURFACE. When you're working on a task (anything in the MY TASKS block), follow-ups belong on the task card via task_comment / share_to_task — NOT in DMs to whoever asked for it. DMs scatter the work and humans lose the thread. Only DM if the topic is genuinely off-task (a personal nudge, a 1:1 coordination question that doesn't belong in the task history). When in doubt: if a teammate could later ask "what happened with task X?", every relevant message should be findable on task X's card.`,
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
    const historyLine =
      t.historySummary && String(t.historySummary).trim()
        ? `\nEarlier in this thread (summary of older comments):\n${String(t.historySummary).trim()}`
        : "";
    const commentsLine = (t.recentComments || []).length
      ? `\nRecent comments:\n${t.recentComments.map((c) => `  @${c.memberHandle}: ${String(c.bodyMd).slice(0, 200)}`).join("\n")}`
      : "";
    const sourceLine = t.conversationName ? `From channel: #${t.conversationName}` : null;
    // Pre-computed quality verdict (review entry). Gives a reviewing manager a
    // concrete signal — flip done on a pass, send back on a fail — instead of
    // reviewing cold or rubber-stamping.
    let verdictLine = null;
    if (t.latestVerdict && t.latestVerdict.verdict) {
      const v = t.latestVerdict;
      const sc = typeof v.score === "number" ? ` (${Math.round(v.score * 100)}%)` : "";
      verdictLine =
        v.verdict === "pass"
          ? `AUTO-VERIFIER: ✅ pass${sc} — ${v.rationale || "deliverable meets the acceptance criteria"}. If you're the reviewer and you agree, flip this task to status:"done".`
          : `AUTO-VERIFIER: ⚠️ fail${sc} — ${v.rationale || "deliverable does not meet the acceptance criteria"}. Do NOT mark done; comment what's missing and set status:"in_progress" so the maker fixes the real artifact.`;
    }
    // The "why" chain: mission ▸ project ▸ goal ▸ … ▸ the goal this task
    // serves. Lets the agent judge scope/trade-offs against the real objective
    // instead of optimizing a bare title. Mission comes from the workspace.
    const chain = Array.isArray(t.goalAncestry) ? t.goalAncestry : [];
    let whyLine = null;
    if (chain.length || (packet.workspace && packet.workspace.mission)) {
      const parts = [];
      if (packet.workspace && packet.workspace.mission) parts.push(`Mission: ${packet.workspace.mission}`);
      for (const g of chain) parts.push(`${g.kind === "project" ? "Project" : "Goal"} “${g.title}”`);
      whyLine = `Why this matters (chain): ${parts.join(" ▸ ")}`;
    }
    taskBlock = [
      ``,
      `TASK (id ${t.id}) — status: ${t.status}${t.progress ? ` · progress ${t.progress}%` : ""}${t.dueAt ? ` · due ${t.dueAt.slice(0, 10)}` : ""}`,
      `Title: ${t.title}`,
      whyLine,
      verdictLine,
      t.bodyMd ? `Description: ${t.bodyMd}` : null,
      sourceLine,
      t.labels?.length ? `Labels: ${t.labels.join(", ")}` : null,
      assignLine,
      subsLine ? subsLine.trimStart() : null,
      historyLine ? historyLine.trimStart() : null,
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
          `  • {"type":"share_to_task","task_id":"task_…","body_md":"what I just did","files":[{"url":"…"}|{"path":"/workspace/…"}]}  — attach an artifact (screenshot, PDF, data, written-out answer)`,
          `  • {"type":"task_comment","task_id":"task_…","body_md":"specific, concrete update"}  — narrate progress concretely (NOT "still working on it")`,
          `  • {"type":"update_task","task_id":"task_…","progress":<0-100>,"status":"in_progress|blocked|review|done"}  — bump progress or flip status when you hit a milestone (on your own tasks, "review" is your finish line — a reviewer flips done)`,
          ``,
          `Pick the most-stale task above that's ACTUALLY IN YOUR LANE and do one concrete thing on it right now. A good turn produces at least one share_to_task OR task_comment with a specific deliverable attached or named. "I will look into X" is not a turn — "attached Q3 competitor table (pdf) pulled from tracker" is.`,
          ``,
          `If no task in the list is in your lane, or you genuinely have nothing to add on any of them, reply with exactly "HEARTBEAT_OK" — empty prose with no action is the worst possible output.`,
          `NEVER emit post_message or any conversation-bound action in task-only mode — there is no conversation.`,
        ]
      : [
          ``,
          `On a quiet heartbeat with open tasks, you have TWO equal options — pick whichever you have material for: (A) SHIP AN ARTIFACT — share_to_task with a real deliverable (screenshot, PDF, written research, code, data) plus a caption. update_task bumps progress at milestones. Bare task_comment is only for clarifying questions, blockers, or replies; narration without a file is filler. (B) POST IN CHAT FOR COLLABORATION — chat is where the team coordinates: announce a task you just shipped ("RFC ready for review: <link>"), ask a colleague a question you hit while working (@-mention them), share_files into the channel when you found something broadly useful (so files land where humans see them, not just on a card), or react to recent teammate activity. If you have neither artifact nor proactive chat contribution this turn, HEARTBEAT_OK. Don't post filler ("hey team", generic "what I'm working on") and don't narrate task progress without a file.`,
        ];
    myTasksBlock = [
      ``,
      `YOUR OPEN TASKS (${mt.length} assigned, not done — freshest first):`,
      ...lines,
      ...tail,
    ].join("\n");
  }

  // Active goals — what the team is driving toward. A goal with 0 tasks is
  // unplanned: a lead can decompose_goal it to fan it out into a task tree.
  let goalsBlock = "";
  const gs = Array.isArray(packet.goals) ? packet.goals : [];
  if (gs.length) {
    const byId = new Map(gs.map((g) => [g.id, g]));
    const lines = gs.slice(0, 10).flatMap((g) => {
      const c = g.taskCounts || { total: 0, done: 0, inProgress: 0 };
      const tally = c.total ? ` · ${c.done}/${c.total} done` : ` · UNPLANNED — decompose_goal to fan it out`;
      const kindTag = g.kind === "project" ? "PROJECT " : "";
      const parent = g.parentGoalId ? byId.get(g.parentGoalId) : null;
      const underLine = parent ? ` · under “${parent.title}”` : "";
      const head = `  ◆ ${g.id} [${kindTag}${g.status}${tally}] ${g.title}${underLine}`;
      // GOAL LEDGER — the externalized plan/facts/dead-ends/progress. Read it
      // before acting; don't re-derive the goal from chat history.
      const led = g.ledger;
      if (!led) return [head];
      const sub = [];
      if (led.plan) sub.push(`      Plan:\n${led.plan.split("\n").map((l) => `        ${l}`).join("\n")}`);
      if (led.facts && led.facts.length)
        sub.push(`      Facts: ${led.facts.slice(-8).map((f) => `• ${f}`).join("  ")}`);
      if (led.triedDeadEnds && led.triedDeadEnds.length)
        sub.push(`      Dead-ends (do NOT repeat): ${led.triedDeadEnds.slice(-6).map((d) => `• ${d}`).join("  ")}`);
      if (led.recentProgress && led.recentProgress.length)
        sub.push(`      Recent progress: ${led.recentProgress.map((p) => `• ${p}`).join("  ")}`);
      // Typed per-round progress signal from the sweeper. A loop warning is
      // high-priority: the team keeps repeating a step without advancing, so
      // tell the agent to change approach instead of spinning.
      if (led.progress && led.progress.isInLoop)
        sub.push(`      ⚠️ LOOP DETECTED — the team has repeated the same step without progress. ${led.progress.nextStep || "Change approach or escalate to the goal owner."}`);
      else if (led.progress && led.progress.nextStep)
        sub.push(`      ▸ Next step: ${led.progress.nextStep}`);
      return [head, ...sub];
    });
    goalsBlock = [
      ``,
      `YOUR ACTIVE GOALS (what the team is driving toward) — each goal carries a LEDGER (plan, facts, dead-ends, progress). Read the ledger before acting. When you learn a durable fact, finish a step, or hit a dead-end, record it with a ledger_update action ({"type":"ledger_update","goal_id":"goal_…","facts":["…"],"progress_note":"…","dead_end":"…"}) instead of only saying it in chat — the ledger is what your teammates and your next wake actually read.`,
      ...lines,
    ].join("\n");
  }

  // Pending approvals — actions of this agent parked awaiting a human
  // decision. Surfaced so the agent doesn't re-emit the gated action or
  // re-request approval every wake (the server also dedupes, but the agent
  // should KNOW it's waiting, not discover it via a rejection).
  // Failure continuity: if the agent's previous run died (crash, gateway
  // error, reaped after a worker death), say so — otherwise the agent has
  // amnesia about its own dead run and silently drops in-flight work.
  let prevFailBlock = "";
  if (packet.previousRunFailure && packet.previousRunFailure.errorText) {
    const pf = packet.previousRunFailure;
    prevFailBlock = [
      ``,
      `⚠ YOUR PREVIOUS RUN FAILED (${String(pf.errorText).slice(0, 200)}${pf.finishedAt ? `, at ${pf.finishedAt}` : ""}).`,
      `Anything you were doing that turn may not have completed — no actions were applied. Check the task you were working on (its comments/artifacts show what actually landed) and redo the lost step rather than assuming it happened.`,
    ].join("\n");
  }

  // One-shot loop-break directive (run-level stuck detector). High priority —
  // the agent has been repeating itself; tell it to break the pattern.
  let stuckBreakBlock = "";
  if (packet.stuckBreak && typeof packet.stuckBreak === "string") {
    stuckBreakBlock = `\n${packet.stuckBreak.trim()}`;
  }

  // One-shot result of a run_code action the agent issued last turn (the
  // sandbox runs after the turn ends, so its output arrives here next turn).
  let codeResultBlock = "";
  if (packet.lastCodeResult && typeof packet.lastCodeResult === "string") {
    codeResultBlock = `\nRESULT of the code you ran last turn:\n${packet.lastCodeResult.trim()}\nUse this output to take the next step — don't re-run the same code.`;
  }

  let approvalsBlock = "";
  const aps = Array.isArray(packet.openApprovals) ? packet.openApprovals : [];
  if (aps.length) {
    const lines = aps.slice(0, 10).map((ap) => {
      const when = ap.createdAt ? ` · requested ${String(ap.createdAt).slice(0, 10)}` : "";
      const whose = ap.mine === false && ap.agentHandle ? ` · filed by @${ap.agentHandle}` : "";
      return `  ⏳ ${ap.id} [${ap.scope}${when}${whose}] ${ap.action}`;
    });
    approvalsBlock = [
      ``,
      `TEAM PENDING APPROVALS (${aps.length} awaiting a human decision — yours AND your teammates'):`,
      ...lines,
      `These actions are PARKED until a human approves or denies them. Do NOT emit the same action again, do NOT open a new request_approval for the same OR an equivalent thing (rephrasing it counts — the server matches by similarity and will drop it), and do NOT ask about them in chat every wake. If a teammate already filed it, it covers the whole team — one human decision, one card. You'll be woken with trigger:"approval_response" when a decision on YOUR card lands. Treat work that depends on any of these as blocked: set that task's status to "blocked" and pick different work.`,
    ].join("\n");
  }

  // Memory block: render scoped memory the agent has previously written.
  // Global is always shown. Per-conversation memory appears only for
  // conversations in this packet's inbox; per-task memory only for tasks
  // in YOUR OPEN TASKS or the active task. Empty buckets are omitted.
  let memoryBlock = "";
  const mem = packet.memory || {};
  // Tolerate the legacy flat shape {key: value} from older API versions —
  // treat it as global so a downgraded API doesn't break agent operation.
  const memGlobal =
    mem && typeof mem === "object" && "global" in mem
      ? mem.global || {}
      : (mem && typeof mem === "object" ? mem : {});
  const memByConv = (mem && mem.byConversation) || {};
  const memByTask = (mem && mem.byTask) || {};
  const fmtKv = (obj) => {
    const keys = Object.keys(obj || {});
    if (!keys.length) return null;
    return keys
      .slice(0, 30)
      .map((k) => {
        let v;
        try { v = JSON.stringify(obj[k]); } catch { v = String(obj[k]); }
        if (v && v.length > 200) v = v.slice(0, 197) + "…";
        return `    ${k} = ${v}`;
      })
      .join("\n");
  };
  const memLines = [];
  const globalLines = fmtKv(memGlobal);
  if (globalLines) {
    memLines.push(`  global:`, globalLines);
  }
  for (const [cid, kv] of Object.entries(memByConv)) {
    const lines = fmtKv(kv);
    if (!lines) continue;
    const conv = (packet.inbox || []).find((c) => c.conversationId === cid);
    const label = conv
      ? conv.conversationKind === "dm"
        ? `DM ${cid}`
        : `#${conv.conversationName || cid}`
      : cid;
    memLines.push(`  conversation:${label}`, lines);
  }
  for (const [tid, kv] of Object.entries(memByTask)) {
    const lines = fmtKv(kv);
    if (!lines) continue;
    const t = (packet.myTasks || []).find((x) => x.id === tid);
    const label = t ? `${tid} — ${t.title}` : tid;
    memLines.push(`  task:${label}`, lines);
  }
  if (memLines.length) {
    memoryBlock = [
      ``,
      `YOUR MEMORY (your notes from prior runs — see set_memory/delete_memory in action types):`,
      ...memLines,
    ].join("\n");
  }

  // PROJECT BRIEF — the canonical, human-pinned source of truth (read fresh
  // from /workspace/BRIEF.md each run). Rendered prominently, near the top,
  // BEFORE the conversation history — weak models won't fetch it themselves and
  // the chat history (full of stale/wrong claims) otherwise wins. The brief
  // overrides anything in chat that contradicts it.
  let briefBlock = "";
  const briefText = packet.workspace && typeof packet.workspace.brief === "string" ? packet.workspace.brief.trim() : "";
  if (briefText) {
    briefBlock = [
      ``,
      `━━━━━━━━━━ PROJECT BRIEF (AUTHORITATIVE — overrides anything in chat that contradicts it) ━━━━━━━━━━`,
      briefText,
      `━━━━━━━━━━ END BRIEF ━━━━━━━━━━`,
    ].join("\n");
  }

  // MEMORY BLOCKS — Letta-style always-in-context prose the agent maintains.
  // `team` is shared across the workspace (the whiteboard); `notes` is private.
  // Rendered with each block's char budget so the model self-manages size.
  let memoryBlocksBlock = "";
  const mblocks =
    packet.memoryBlocks && Array.isArray(packet.memoryBlocks) ? packet.memoryBlocks : [];
  if (mblocks.length) {
    const lines = mblocks.map((b) => {
      const used = String(b.value || "").length;
      const scope = b.shared ? "SHARED across the team" : "private to you";
      return (
        `\n[${b.label}] (${scope}; ${used}/${b.charLimit} chars) — ${b.description}\n` +
        `${String(b.value || "").trim() || "(empty — fill this in as you learn things worth keeping)"}`
      );
    });
    memoryBlocksBlock = [
      ``,
      `MEMORY BLOCKS (always visible; edit with memory_append / memory_rethink — the SHARED block is how the team stays in sync):`,
      ...lines,
    ].join("\n");
  }

  // RELEVANT KNOWLEDGE — situational guidance whose triggers matched this run
  // (or always-on entries). Unlike the brief, these are injected only when
  // relevant, so workspace know-how doesn't bloat every prompt.
  let knowledgeBlock = "";
  const knEntries =
    packet.workspace && Array.isArray(packet.workspace.knowledge) ? packet.workspace.knowledge : [];
  if (knEntries.length) {
    knowledgeBlock = [
      ``,
      `RELEVANT KNOWLEDGE (workspace guidance that applies to what you're doing right now):`,
      ...knEntries.map((k) => `\n### ${k.name}\n${String(k.content || "").trim()}`),
    ].join("\n");
  }

  // WORKSPACE FILES — live manifest of /workspace so the agent builds on what
  // already exists instead of asking teammates in chat ("can you share the
  // component?") or rebuilding a file that's right there on disk.
  let filesBlock = "";
  const wsFiles = packet.workspace && Array.isArray(packet.workspace.files) ? packet.workspace.files : null;
  if (wsFiles && wsFiles.length) {
    const fmtSize = (n) => (n >= 1024 ? `${Math.round(n / 1024)}K` : `${n}B`);
    const fileLines = wsFiles.slice(0, 60).map((f) => `  ${f.path} (${fmtSize(f.size)})`);
    filesBlock = [
      ``,
      `WORKSPACE FILES (already on /workspace, freshest first — READ these before recreating anything; reference by exact path in share_to_task/share_files):`,
      ...fileLines,
      wsFiles.length > 60 ? `  …and ${wsFiles.length - 60} more` : null,
    ].filter(Boolean).join("\n");
  }

  const sections = taskOnly
    ? [
        identity,
        briefBlock,
        knowledgeBlock,
        ``,
        `You are currently in ${convLabel}.${colleaguesLine}${reportingLine}${memberIdBlock}`,
        filesBlock,
        myTasksBlock,
        goalsBlock,
        approvalsBlock,
        memoryBlock,
        memoryBlocksBlock,
        prevFailBlock,
        stuckBreakBlock,
        codeResultBlock,
        ``,
        triggerLine,
        toolBlock,
        ``,
        `Your reply body will be dropped — there is no conversation to post into. The ONLY valid output this turn is either (a) an <actions>[...]</actions> block doing real work on a task, or (b) exactly "HEARTBEAT_OK". No prose, no receipts, no "I will…".`,
      ]
    : [
        identity,
        briefBlock,
        knowledgeBlock,
        ``,
        `You are currently in ${convLabel}.${topicLine}${othersLine}${colleaguesLine}${reportingLine}${memberIdBlock}`,
        filesBlock,
        threadBlock,
        taskBlock,
        myTasksBlock,
        goalsBlock,
        approvalsBlock,
        memoryBlock,
        memoryBlocksBlock,
        prevFailBlock,
        stuckBreakBlock,
        codeResultBlock,
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
      const modelOverride =
        MODEL_IMPORTANT && IMPORTANT_TRIGGERS.has(trigger) ? MODEL_IMPORTANT : undefined;
      const { stdout, stderr } = isOpenClaw
        ? await callOpenClaw(prompt, entry.openclawHome, entry.token)
        : await callHermes(prompt, entry.hermesHome, entry.token, modelOverride);
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
      // Final suppression: if the remaining body is nothing but machinery
      // (tool-call syntax, leftover JSON, diff/boot/spinner noise), don't post
      // it as a chat message — let any side-actions carry the turn. Without
      // this, a leaked `session_search(...)` or raw `{"type":...}` would land
      // in a channel as a garbage message.
      const postBody = body && body.trim() && !isOnlyArtifact(body) ? body : "";
      if (body && body.trim() && !postBody) {
        console.log(`[${entry.handle}] ${trigger} → body was tool-call/artifact-only; suppressing post (sideActions=${sideActions.length})`);
      }
      // Only emit a post_message if there's something to say AND we have a
      // conversation to post into. In task-only mode (scheduled wake with
      // empty inbox + open tasks), conv is undefined — the agent's prose
      // would have nowhere to land, so we drop it and let the side-actions
      // (task_comment / share_to_task / update_task) carry the work.
      if (postBody && conv) {
        actions.push({
          type: "post_message",
          conversation_id: conv.conversationId,
          body_md: postBody,
          ...(replyTo ? { reply_to: replyTo } : {}),
          ...(attachments.length ? { attachments } : {}),
        });
      } else if (postBody && !conv) {
        // Task-only mode and the agent wrote prose but no actions block.
        // Don't drop the work — auto-wrap as a task_comment on the agent's
        // most-stale assigned task so the prose lands SOMEWHERE useful. If
        // the agent already emitted any task-targeting side action, the
        // prose probably belongs alongside it, so attach to that task.
        const targetTaskId =
          sideActions.find((sa) => sa && typeof sa.task_id === "string")?.task_id ||
          (Array.isArray(p.myTasks) && p.myTasks[0]?.id) ||
          null;
        if (targetTaskId) {
          console.log(`[${entry.handle}] task-only: auto-wrapping ${postBody.length}-char prose into task_comment on ${targetTaskId}`);
          actions.push({
            type: "task_comment",
            task_id: targetTaskId,
            body_md: postBody,
          });
        } else {
          console.log(`[${entry.handle}] task-only: dropping ${postBody.length}-char prose (no conv and no task to wrap into)`);
        }
      }
      for (const a of sideActions) actions.push(a);
      console.log(
        `[${entry.handle}] replying, len=${postBody.length}, att=${attachments.length}${sideActions.length ? `, actions=${sideActions.length} (${sideActions.map((a) => a.type).join("+")})` : ""}`,
      );
      if (actions.length === 0) return reply({ status: "HEARTBEAT_OK" });
      reply({
        actions,
        trace: [`${entry.handle} responded, len=${postBody.length}${attachments.length ? `, att=${attachments.length}` : ""}${sideActions.length ? `, actions=${sideActions.length}` : ""}`],
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
