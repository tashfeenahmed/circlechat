// SPDX-License-Identifier: AGPL-3.0-only
// Things a hosted (or any internet-facing) install needs:
//   - knowing whether the browser's request was https when a TLS proxy sits in front
//   - a seed file that creates the owner, workspace, model provider and starter agents on first boot
//   - a full data export and a workspace delete (GDPR: access and erasure)
//   - an address on the docker bridge where agent containers can reach the tool gateway
import { existsSync, readFileSync, rmSync, mkdtempSync, writeFileSync, mkdirSync, readdirSync, cpSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import type { App } from "./app.ts";
import { now, setSetting, getSetting, json } from "./db.ts";
import { id, hashPassword, hmac, safeEqual, token as randomToken } from "./crypto.ts";
import { ENGINES, agentDirs } from "./agents/engines.ts";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------- proxy trust

/**
 * Was the original request https? Without proxy trust only the request URL counts.
 * With trust on (CIRCLECHAT_TRUST_PROXY=1, only safe when the server is reachable
 * through the proxy alone) X-Forwarded-Proto from the proxy decides.
 */
export function requestIsHttps(url: string, header: (name: string) => string | undefined, trustProxy: boolean): boolean {
  if (url.startsWith("https:")) return true;
  if (!trustProxy) return false;
  const proto = (header("x-forwarded-proto") ?? "").split(",")[0].trim().toLowerCase();
  return proto === "https";
}

/** The host the browser used, honouring X-Forwarded-Host only with proxy trust on. */
export function requestHost(url: string, header: (name: string) => string | undefined, trustProxy: boolean): string {
  if (trustProxy) {
    const h = (header("x-forwarded-host") ?? "").split(",")[0].trim();
    if (h) return h;
  }
  return header("host") ?? new URL(url).host;
}

// ---------------------------------------------------------------- seed file

export interface SeedFile {
  workspace?: string;
  owner: { email: string; name: string; passwordHash?: string; password?: string };
  providers?: { id: string; kind: "openai-compatible" | "anthropic" | "openai"; baseUrl: string; apiKey?: string; models: string[]; label?: string }[];
  agents?: { name: string; handle?: string; engine?: string; model?: string; roleTitle?: string; instructions?: string; sandbox?: "docker" | "local" }[];
  /** hosted installs: where the control plane is, this instance's id there, and the shared secret */
  hosting?: { consoleUrl: string; instanceId: string; secret: string };
  /** name of a group chat with the owner and every seeded agent; "" = none */
  chat?: string;
  welcome?: string;
}

const PASS_HASH = /^scrypt\$[A-Za-z0-9_-]{16,}\$[A-Za-z0-9_-]{32,}$/;

/**
 * Apply a seed file once. Runs only while there are no users, so a restart (or a
 * file left behind) can never overwrite a workspace someone is already using.
 * The file is deleted after success: it may hold a model key.
 * Returns what happened, for the log.
 */
export function applySeedFile(app: App, path: string, opts: { keepFile?: boolean } = {}): "applied" | "skipped" | "missing" {
  if (!existsSync(path)) return "missing";
  const users = (app.db.prepare("SELECT COUNT(*) AS n FROM users").get() as any).n;
  if (users > 0) {
    if (!opts.keepFile) rmSync(path, { force: true });
    return "skipped";
  }
  const seed = JSON.parse(readFileSync(path, "utf8")) as SeedFile;
  applySeed(app, seed);
  if (!opts.keepFile) rmSync(path, { force: true });
  return "applied";
}

export function applySeed(app: App, seed: SeedFile): { ownerId: string; agentIds: string[]; chatId: string } {
  const { db, svc } = app;
  const email = String(seed.owner?.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error("seed: owner email is missing or wrong");
  let passHash = seed.owner.passwordHash ?? "";
  if (!passHash && seed.owner.password) passHash = hashPassword(seed.owner.password);
  if (!PASS_HASH.test(passHash)) throw new Error("seed: owner passwordHash must be an scrypt hash");

  const ownerId = id("u_");
  const agentIds: string[] = [];
  let chatId = "";
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO users(id, email, name, pass_hash, role, created_at) VALUES(?,?,?,?, 'owner', ?)").run(
      ownerId,
      email,
      String(seed.owner.name || email.split("@")[0]).slice(0, 60),
      passHash,
      now(),
    );
    setSetting(db, "workspace_name", String(seed.workspace || "My team").slice(0, 60));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  if (seed.hosting?.consoleUrl && seed.hosting.instanceId && seed.hosting.secret) setHosting(app, seed.hosting);
  for (const p of seed.providers ?? []) {
    app.upsertProvider({ id: p.id.replace(/[^a-z0-9_-]/gi, "").toLowerCase(), kind: p.kind, baseUrl: p.baseUrl, apiKey: p.apiKey ?? "", models: p.models ?? [], label: p.label });
  }
  const STYLES = ["classic", "twin", "curly", "spring", "heart", "leafy", "bulb", "trio", "stubby", "halo", "nightlight", "huggy", "feelers"];
  const COLOURS = ["coral", "peach", "butter", "mint", "green", "sky", "lilac", "pink", "cloud", "midnight"];
  const start = Math.floor(Math.random() * STYLES.length * COLOURS.length); // a different look per workspace
  for (const [i, a] of (seed.agents ?? []).entries()) {
    const engine = ENGINES.some((e) => e.id === a.engine) ? a.engine! : "hermes";
    let handle = String(a.handle ?? a.name)
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "")
      .slice(0, 30);
    if (!/^[a-z][a-z0-9_-]{1,29}$/.test(handle)) handle = `agent${i + 1}`;
    while (svc.agent(handle)) handle = (handle + "2").slice(0, 30);
    const aid = id("a_");
    db.prepare(
      `INSERT INTO agents(id, handle, name, role_title, style, colour, engine, model, instructions, autonomy, sandbox, email, budget_cents, created_by, created_at)
       VALUES(?,?,?,?,?,?,?,?,?, 'act', ?, ?, 0, ?, ?)`,
    ).run(
      aid,
      handle,
      String(a.name).slice(0, 40),
      String(a.roleTitle ?? "").slice(0, 60),
      STYLES[(i + start) % STYLES.length],
      COLOURS[(i * 3 + start) % COLOURS.length],
      engine,
      String(a.model ?? "").slice(0, 120),
      String(a.instructions ?? "").slice(0, 20000),
      a.sandbox === "local" ? "local" : "docker",
      `${handle}@agents.local`,
      ownerId,
      now(),
    );
    agentDirs(app.cfg.dataDir, aid);
    agentIds.push(aid);
  }
  const hello = (cid: string, aid: string, others: string) => {
    // the first agent says hello itself, in plain words, so a new owner knows what to do next
    const first = svc.agent(aid)!;
    const who = String(seed.owner.name || "").trim().split(/\s+/)[0];
    db.prepare("INSERT INTO messages(id, chat_id, author_type, author_id, kind, body, meta, ts) VALUES(?,?, 'agent', ?, 'text', ?, ?, ?)").run(
      id("m_"),
      cid,
      first.id,
      `Hi${who ? " " + who : ""}! I'm ${first.name}, your first agent. I can look things up, write, plan and use the tools you connect. ` +
        `Just type below and I'll answer.${others} Not sure where to start? Pick one of the ideas below.`,
      JSON.stringify({ onboarding: true }),
      now(),
    );
  };
  if (seed.chat === "dm" && agentIds.length) {
    // one to one chats: the owner starts talking to the first agent straight away
    for (const aid of agentIds.slice(1).reverse()) svc.dmWith(ownerId, aid);
    chatId = svc.dmWith(ownerId, agentIds[0]);
    hello(chatId, agentIds[0], "");
  } else if (seed.chat !== "") {
    chatId = svc.createChat("group", String(seed.chat || "General").slice(0, 60), ownerId, [
      { type: "user", id: ownerId },
      ...agentIds.map((a) => ({ type: "agent" as const, id: a })),
    ]);
    if (agentIds.length) {
      hello(chatId, agentIds[0], agentIds.length > 1 ? " The others here can help too: mention one with @ to ask them." : "");
    } else if (seed.welcome) {
      db.prepare("INSERT INTO messages(id, chat_id, author_type, author_id, kind, body, meta, ts) VALUES(?,?, 'system', '', 'text', ?, '{}', ?)").run(
        id("m_"),
        chatId,
        String(seed.welcome).slice(0, 4000),
        now(),
      );
    }
  }
  return { ownerId, agentIds, chatId };
}

// ---------------------------------------------------------------- export

// Tables whose rows are exported as JSON. Secrets are exported by name only:
// their values are vault-encrypted and the key is not part of the export.
const EXPORT_TABLES = [
  "settings",
  "users",
  "agents",
  "chats",
  "chat_members",
  "messages",
  "tasks",
  "memories",
  "approvals",
  "tool_calls",
  "triggers",
  "trigger_runs",
  "connections",
  "mcp_servers",
  "grants",
  "policies",
  "usage",
  "bridges",
  "deliveries",
];

/**
 * Everything the workspace holds, as a gzipped tar stream:
 *   workspace.json   every table as JSON (password hashes and secret values left out)
 *   circlechat.db    a consistent copy of the database (VACUUM INTO), secret values still encrypted
 *   agents/<id>/     each agent's home folder (memory, skills, work files)
 */
export async function exportWorkspace(app: App): Promise<{ stream: ReadableStream; filename: string; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "cc-export-"));
  const root = join(dir, "circlechat-export");
  mkdirSync(root);
  const data: Record<string, unknown[]> = {};
  for (const t of EXPORT_TABLES) {
    let rows = app.db.prepare(`SELECT * FROM ${t}`).all() as any[];
    if (t === "users") rows = rows.map(({ pass_hash: _p, ...r }) => r);
    data[t] = rows;
  }
  data.secrets = (app.db.prepare("SELECT id, name, created_at FROM secrets").all() as any[]).map((s) => ({ ...s, value: "(encrypted, not exported)" }));
  writeFileSync(
    join(root, "workspace.json"),
    JSON.stringify({ format: "circlechat-export/1", exportedAt: new Date().toISOString(), workspace: getSetting(app.db, "workspace_name") ?? "", tables: data }, null, 1),
  );
  app.db.exec(`VACUUM INTO '${join(root, "circlechat.db").replace(/'/g, "''")}'`);
  const agentsDir = join(app.cfg.dataDir, "agents");
  if (existsSync(agentsDir)) cpSync(agentsDir, join(root, "agents"), { recursive: true, dereference: false, filter: (src) => !/\/node_modules(\/|$)/.test(src) });
  writeFileSync(
    join(root, "README.txt"),
    "CircleChat workspace export.\n\nworkspace.json: all chats, messages, tasks, memories, agents, people and settings as JSON.\n" +
      "circlechat.db: a copy of the SQLite database. Stored keys stay encrypted.\nagents/: each agent's home folder.\n",
  );
  const tar = spawn("tar", ["-czf", "-", "-C", dir, "circlechat-export"], { stdio: ["ignore", "pipe", "pipe"] });
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  tar.on("close", cleanup);
  const stamp = new Date().toISOString().slice(0, 10);
  return { stream: Readable.toWeb(tar.stdout) as unknown as ReadableStream, filename: `circlechat-export-${stamp}.tar.gz`, cleanup };
}

// ---------------------------------------------------------------- erase

/**
 * Delete everything in the workspace: stop agents, remove their containers and
 * volumes, wipe every table and every agent folder. The server keeps running
 * and is back at first-run setup afterwards.
 */
export async function eraseWorkspace(app: App): Promise<void> {
  const agentIds = (app.db.prepare("SELECT id FROM agents").all() as any[]).map((r) => r.id as string);
  await app.runtime.shutdown();
  for (const b of app.bridges.values()) b.stop();
  app.bridges.clear();
  await app.gateway.closeAll();
  // containers are removed when their process stops; named volumes stay unless removed
  for (const aid of agentIds) {
    const prefix = `cc-${aid.toLowerCase().replace(/[^a-z0-9]/g, "")}-`;
    try {
      const { stdout } = await execFileP("docker", ["volume", "ls", "-q", "--filter", `name=${prefix}`], { timeout: 10_000 });
      const vols = stdout.split("\n").filter(Boolean);
      if (vols.length) await execFileP("docker", ["volume", "rm", "-f", ...vols], { timeout: 30_000 });
    } catch {}
  }
  const tables = (app.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as any[]).map((r) => r.name);
  app.db.exec("PRAGMA foreign_keys = OFF");
  app.db.exec("BEGIN");
  for (const t of tables) app.db.exec(`DELETE FROM ${t}`);
  app.db.exec("COMMIT");
  app.db.exec("PRAGMA foreign_keys = ON");
  app.db.exec("VACUUM");
  const agentsDir = join(app.cfg.dataDir, "agents");
  if (existsSync(agentsDir)) for (const f of readdirSync(agentsDir)) rmSync(join(agentsDir, f), { recursive: true, force: true });
}

// ---------------------------------------------------------------- docker bridge listener

/**
 * Where agent containers reach the gateway on Linux. `host.docker.internal`
 * (host-gateway) is the docker bridge address, but the main server binds
 * 127.0.0.1, so CIRCLECHAT_AGENT_LISTEN names a second address (an IP, or an
 * interface name such as docker0) that serves /mcp/* only.
 */
export function resolveListenAddress(spec: string): string | null {
  if (!spec) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(spec) || spec.includes(":")) return spec;
  const nic = networkInterfaces()[spec];
  return nic?.find((a) => a.family === "IPv4")?.address ?? null;
}

// ---------------------------------------------------------------- hosted installs
//
// A hosted workspace knows its control plane (consoleUrl), its id there and a
// shared secret, all from the seed. The secret sits in the vault and never
// reaches a browser. It signs one-time sign-in tokens (the control plane's
// "Open workspace" button) and authenticates this server's calls to the
// control plane for Settings > Hosting.

export interface HostingConfig {
  consoleUrl: string;
  instanceId: string;
  secret: string;
}

export function setHosting(app: App, h: HostingConfig): void {
  const old = json<{ secretId?: string }>(getSetting(app.db, "hosting") ?? "", {});
  if (old.secretId) app.gateway.deleteSecret(old.secretId);
  const secretId = app.gateway.putSecret("hosting", h.secret);
  setSetting(app.db, "hosting", JSON.stringify({ consoleUrl: h.consoleUrl.replace(/\/+$/, ""), instanceId: h.instanceId, secretId }));
}

export function hosting(app: App): HostingConfig | null {
  const h = json<{ consoleUrl?: string; instanceId?: string; secretId?: string }>(getSetting(app.db, "hosting") ?? "", {});
  if (!h.consoleUrl || !h.instanceId || !h.secretId) return null;
  try {
    return { consoleUrl: h.consoleUrl, instanceId: h.instanceId, secret: app.gateway.getSecret(h.secretId) };
  } catch {
    return null;
  }
}

export const SSO_MAX_AGE_MS = 2 * 60_000;

/** Same format the control plane mints: base64url(JSON {i, e, x, n}) "." hex HMAC-SHA256. */
export function signSsoToken(secret: string, p: { i: string; e: string; x: number; n?: string }): string {
  const payload = Buffer.from(JSON.stringify({ ...p, n: p.n ?? randomToken(12) })).toString("base64url");
  return `${payload}.${hmac(secret, payload)}`;
}

/**
 * Check a one-time sign-in token: right signature, for this instance, not
 * expired (and never valid for more than 2 minutes), not used before, and for
 * the workspace owner. Returns the owner's user id.
 */
export function useSsoToken(app: App, tok: string): { userId: string } | { error: string } {
  const h = hosting(app);
  if (!h) return { error: "not a hosted workspace" };
  const [payload, sig] = String(tok || "").split(".");
  if (!payload || !sig || !safeEqual(hmac(h.secret, payload), sig)) return { error: "bad signature" };
  let p: { i?: string; e?: string; x?: number; n?: string };
  try {
    p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { error: "bad token" };
  }
  const t = Date.now();
  if (p.i !== h.instanceId) return { error: "wrong workspace" };
  if (!p.x || p.x < t || p.x > t + SSO_MAX_AGE_MS + 5_000) return { error: "expired" };
  if (!p.n || p.n.length < 8) return { error: "bad token" };
  app.db.prepare("DELETE FROM sso_used WHERE expires_at < ?").run(t);
  try {
    app.db.prepare("INSERT INTO sso_used(nonce, expires_at) VALUES(?, ?)").run(p.n, p.x);
  } catch {
    return { error: "already used" };
  }
  const u = app.db.prepare("SELECT id, role FROM users WHERE email = ?").get(String(p.e ?? "").toLowerCase()) as any;
  if (!u || u.role !== "owner") return { error: "not the owner" };
  return { userId: u.id };
}

/** Forward a Settings > Hosting call to the control plane, adding the secret server side. */
export async function hostingFetch(app: App, path: string, init: { method: string; body?: string; contentType?: string }): Promise<Response> {
  const h = hosting(app);
  if (!h) throw new Error("not a hosted workspace");
  const clean = path.replace(/^\/+/, "").replace(/\.\.+/g, "");
  return fetch(`${h.consoleUrl}/api/hosted/${encodeURIComponent(h.instanceId)}/${clean}`, {
    method: init.method,
    headers: { authorization: `Bearer ${h.secret}`, ...(init.body ? { "content-type": init.contentType ?? "application/json" } : {}) },
    body: init.body,
    signal: AbortSignal.timeout(60_000),
  });
}
