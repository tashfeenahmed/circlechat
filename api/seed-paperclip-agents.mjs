// Seed CircleChat with every Paperclip agent found on the local box.
//   1. login as admin
//   2. switch session into the target workspace (CC_WORKSPACE_HANDLE/_ID)
//   3. GET /api/companies/<cid>/agents on the local Paperclip API
//   4. for each, POST /api/agents on CircleChat (idempotent — skips if handle taken)
//   5. write bridge-config.json so hermes-multi-bridge.mjs can start them all
//
// Usage:
//   cd circlechat-mvp/api
//   CC_URL=http://localhost:3300 CC_EMAIL=… CC_PASSWORD=… \
//     CC_WORKSPACE_HANDLE=<your-workspace> \
//     PAPERCLIP_URL=http://localhost:3199 PAPERCLIP_COMPANY=<company-id> \
//     node seed-paperclip-agents.mjs
//
// A missing CC_WORKSPACE_HANDLE is fatal — seeding at "the user's default
// workspace" silently dumped agents into whatever workspace login happened
// to pick, which is exactly the bug we don't want.
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const CC_URL = process.env.CC_URL ?? "http://localhost:3300";
const CC_EMAIL = process.env.CC_EMAIL;
const CC_PASSWORD = process.env.CC_PASSWORD;
const CC_WORKSPACE_HANDLE = process.env.CC_WORKSPACE_HANDLE;
const CC_WORKSPACE_ID = process.env.CC_WORKSPACE_ID;
const PAPERCLIP_URL = process.env.PAPERCLIP_URL ?? "http://localhost:3199";
const PAPERCLIP_COMPANY = process.env.PAPERCLIP_COMPANY;
const BRIDGE_CONFIG_PATH = process.env.CC_BRIDGE_CONFIG ?? path.resolve("./bridge-config.json");

if (!CC_EMAIL || !CC_PASSWORD || !PAPERCLIP_COMPANY) {
  console.error("Missing CC_EMAIL / CC_PASSWORD / PAPERCLIP_COMPANY");
  process.exit(1);
}
if (!CC_WORKSPACE_HANDLE && !CC_WORKSPACE_ID) {
  console.error(
    "Missing CC_WORKSPACE_HANDLE (or CC_WORKSPACE_ID). Seeding without an explicit workspace is disabled.",
  );
  process.exit(1);
}

const jar = new Map();
function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function ingestSetCookies(headers) {
  const raw = headers.getSetCookie?.() ?? [];
  for (const line of raw) {
    const [kv] = line.split(";");
    const [k, ...rest] = kv.split("=");
    jar.set(k.trim(), rest.join("=").trim());
  }
}

async function cc(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${CC_URL}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}),
      cookie: cookieHeader(),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  ingestSetCookies(res.headers);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`${method} ${path} → ${res.status} ${t.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

async function paperclip(p) {
  const r = await fetch(`${PAPERCLIP_URL}${p}`);
  if (!r.ok) throw new Error(`paperclip ${p} → ${r.status}`);
  return r.json();
}

// 1. login
await cc("/api/auth/login", { method: "POST", body: { email: CC_EMAIL, password: CC_PASSWORD } });
console.log("[seed] logged in");

// 1b. resolve and switch into the target workspace. Login lands in whichever
// workspace the user happened to be bound to last; we don't trust that.
const { workspaces } = await cc("/api/workspaces");
const target = CC_WORKSPACE_ID
  ? workspaces.find((w) => w.id === CC_WORKSPACE_ID)
  : workspaces.find((w) => w.handle === CC_WORKSPACE_HANDLE);
if (!target) {
  const avail = workspaces.map((w) => `@${w.handle}`).join(", ");
  console.error(
    `[seed] user does not belong to workspace ${CC_WORKSPACE_HANDLE ?? CC_WORKSPACE_ID}. Available: ${avail}`,
  );
  process.exit(1);
}
await cc(`/api/workspaces/${target.id}/switch`, { method: "POST" });
console.log(`[seed] switched into workspace @${target.handle} (${target.id})`);

// 2. existing CircleChat agents
const existing = await cc("/api/agents");
const existingByHandle = new Map(existing.agents.map((a) => [a.handle, a]));
console.log(`[seed] existing circlechat agents: ${existing.agents.length}`);

// 3. general channel
const convs = await cc("/api/conversations");
const generalId = (convs.conversations.find((c) => c.name === "general") ?? convs.conversations[0])?.id;
if (!generalId) throw new Error("no channel to auto-join agents into");
console.log(`[seed] auto-joining new agents to: ${generalId}`);

// 4. paperclip agents
const pAgents = await paperclip(`/api/companies/${PAPERCLIP_COMPANY}/agents`);
console.log(`[seed] paperclip agents: ${pAgents.length}`);

const cfgEntries = [];
for (const a of pAgents) {
  const handle = a.name.toLowerCase().replace(/[^a-z0-9._-]/g, "");
  const title = a.title ?? "";
  const hermesHome = a.adapterConfig?.env?.HERMES_HOME?.value || a.adapterConfig?.env?.HERMES_HOME || null;
  const nameSafe = a.name;

  let row = existingByHandle.get(handle);
  if (row) {
    // patch title if missing/different
    if ((row.title ?? "") !== title && title) {
      try {
        await cc(`/api/agents/${row.id}`, { method: "PATCH", body: { title } });
        console.log(`[seed] patched title for @${handle}`);
      } catch (e) {
        console.warn(`[seed] couldn't patch @${handle}: ${e.message}`);
      }
    }
  } else {
    try {
      const brief = `${title}. Uses local Hermes at ${hermesHome ?? "default"}.`;
      const created = await cc("/api/agents", {
        method: "POST",
        body: {
          name: nameSafe,
          handle,
          kind: "hermes",
          adapter: "socket",
          title,
          brief,
          heartbeatIntervalSec: 600,
          channelIds: [generalId],
        },
      });
      console.log(`[seed] provisioned @${handle} (${title})`);
      row = {
        id: created.id,
        handle: created.handle,
        botToken: created.botToken,
        title,
      };
    } catch (e) {
      console.warn(`[seed] failed @${handle}: ${e.message}`);
      continue;
    }
  }

  // We need the full bot token for bridge config. Re-read from PATH.
  // /api/agents masks token — fall back to DB read only when we just created.
  const token = row.botToken && row.botToken.startsWith("cc_") ? row.botToken : null;
  if (!token) {
    console.warn(`[seed] @${handle} already existed; need raw bot token — fetch from DB manually.`);
    continue;
  }
  cfgEntries.push({
    handle,
    name: nameSafe,
    title,
    token,
    hermesHome,
    agentId: row.id,
  });
}

// Merge with any pre-existing config so we don't clobber other entries.
let merged = cfgEntries;
if (existsSync(BRIDGE_CONFIG_PATH)) {
  try {
    const prev = JSON.parse(readFileSync(BRIDGE_CONFIG_PATH, "utf8"));
    const byHandle = new Map(prev.map((e) => [e.handle, e]));
    for (const e of cfgEntries) byHandle.set(e.handle, e);
    merged = Array.from(byHandle.values());
  } catch {
    // ignore parse errors — we'll overwrite with fresh config
  }
}

writeFileSync(BRIDGE_CONFIG_PATH, JSON.stringify(merged, null, 2));
console.log(`[seed] wrote bridge config (${merged.length} agents) → ${BRIDGE_CONFIG_PATH}`);
