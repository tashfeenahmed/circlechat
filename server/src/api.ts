// SPDX-License-Identifier: AGPL-3.0-only
// JSON API used by the web and desktop apps.
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { App } from "./app.ts";
import { now, getSetting, setSetting, json } from "./db.ts";
import { id, token, hashPassword, verifyPassword } from "./crypto.ts";
import { verifyChain } from "./toollog.ts";
import { ENGINES, agentDirs } from "./agents/engines.ts";
import { inspectAgentFolder, copySkills } from "./importer.ts";
import { slug } from "./gateway.ts";
import { MENTION_ALL } from "./services.ts";
import { APP_CATALOG, preset, presetConfig, checkPreset } from "./apps.ts";
import { requestIsHttps, exportWorkspace, eraseWorkspace, hosting, useSsoToken, hostingFetch } from "./hosting.ts";

type Role = "owner" | "admin" | "builder" | "member";
interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
}
type Env = { Variables: { user: User } };

const STYLES = ["classic", "twin", "curly", "spring", "heart", "leafy", "bulb", "trio", "stubby", "halo", "nightlight", "huggy", "feelers"];
const COLOURS = ["coral", "peach", "butter", "mint", "green", "sky", "lilac", "pink", "cloud", "midnight"];
const RANK: Record<Role, number> = { member: 0, builder: 1, admin: 2, owner: 3 };

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const bad = (m: string) => new HttpError(400, m);
const need = (v: any, name: string) => {
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) throw bad(`${name} is required`);
  return typeof v === "string" ? v.trim() : v;
};

/** Counts wrong passwords in a sliding window. In memory: a restart forgives, which is fine. */
export class FailureLimiter {
  private hits = new Map<string, number[]>();
  private limits: Record<string, number>; // key prefix -> failures allowed per window
  private windowMs: number;
  constructor(limits: Record<string, number>, windowMs = 15 * 60_000) {
    this.limits = limits;
    this.windowMs = windowMs;
  }
  private recent(k: string, now: number): number[] {
    const l = (this.hits.get(k) ?? []).filter((t) => now - t < this.windowMs);
    if (l.length) this.hits.set(k, l);
    else this.hits.delete(k);
    return l;
  }
  /** ms until the caller may try again, or 0 */
  blocked(keys: string[], now = Date.now()): number {
    let wait = 0;
    for (const k of keys) {
      const max = this.limits[k.split(":")[0]] ?? Infinity;
      const l = this.recent(k, now);
      if (l.length >= max) wait = Math.max(wait, l[l.length - max] + this.windowMs - now);
    }
    return wait;
  }
  fail(keys: string[], now = Date.now()): void {
    for (const k of keys) this.hits.set(k, [...this.recent(k, now), now]);
    if (this.hits.size > 50_000) this.hits.clear(); // never grow without bound
  }
  clear(k: string): void {
    this.hits.delete(k);
  }
}

export function buildApi(app: App): Hono<Env> {
  const loginLimiter = new FailureLimiter({ ip: 20, acct: 10 });
  const { db, svc, gateway } = app;
  const api = new Hono<Env>();

  api.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as any);
    console.error(err);
    return c.json({ error: err.message || "server error" }, 500);
  });

  // ---------------------------------------------------------------- auth
  const userById = (uid: string): User | undefined => db.prepare("SELECT id, email, name, role FROM users WHERE id = ?").get(uid) as any;
  const sessionUser = (c: Context): User | undefined => {
    const t = getCookie(c, "cc_session") ?? c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!t) return undefined;
    const s = db.prepare("SELECT user_id, expires_at FROM sessions WHERE token = ?").get(t) as any;
    if (!s || s.expires_at < now()) return undefined;
    return userById(s.user_id);
  };
  const isHttps = (c: Context) => requestIsHttps(c.req.url, (n) => c.req.header(n), !!app.cfg.trustProxy);
  const login = (c: Context, uid: string) => {
    const t = token();
    db.prepare("INSERT INTO sessions(token, user_id, expires_at) VALUES(?,?,?)").run(t, uid, now() + 30 * 86400_000);
    setCookie(c, "cc_session", t, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 30 * 86400, secure: isHttps(c) });
    return t;
  };
  const requireRole = (u: User, role: Role) => {
    if (RANK[u.role] < RANK[role]) throw new HttpError(403, `Only ${role}s and above can do that`);
  };

  api.get("/api/state", (c) => {
    const users = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as any).n;
    const u = sessionUser(c);
    const h = hosting(app);
    return c.json({
      setupNeeded: users === 0,
      workspace: getSetting(db, "workspace_name") ?? "",
      user: u ?? null,
      version: "2.0.0",
      // hosted installs: where to sign in (the control plane), never the secret
      hosted: h ? { signInUrl: `${h.consoleUrl}/login` } : null,
    });
  });

  api.post("/api/setup", async (c) => {
    if ((db.prepare("SELECT COUNT(*) AS n FROM users").get() as any).n > 0) throw new HttpError(409, "already set up");
    const b = await c.req.json();
    const email = String(need(b.email, "email")).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw bad("that email doesn't look right");
    if (String(b.password ?? "").length < 8) throw bad("password needs at least 8 characters");
    const uid = id("u_");
    db.prepare("INSERT INTO users(id, email, name, pass_hash, role, created_at) VALUES(?,?,?,?, 'owner', ?)").run(
      uid,
      email,
      need(b.name, "name"),
      hashPassword(b.password),
      now(),
    );
    setSetting(db, "workspace_name", String(b.workspace ?? "My team").slice(0, 60));
    login(c, uid);
    return c.json({ user: userById(uid) });
  });

  // Hosted: the control plane's "Open workspace" lands here with a one-time token.
  api.get("/sso", (c) => {
    const r = useSsoToken(app, c.req.query("token") ?? "");
    if ("error" in r) {
      console.warn(`[sso] refused: ${r.error}`);
      return c.redirect("/?signin=expired", 302);
    }
    login(c, r.userId);
    return c.redirect("/", 302);
  });

  // Wrong passwords are limited per address and per account, so nobody can guess at speed.
  // A spread-out attack on one account trips the account limit even from many addresses.
  const clientIp = (c: Context): string => {
    if (app.cfg.trustProxy) {
      const f = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
      if (f) return f;
    }
    return (c.env as any)?.incoming?.socket?.remoteAddress ?? "unknown";
  };
  api.post("/api/login", async (c) => {
    const b = await c.req.json();
    const email = String(b.email ?? "").toLowerCase();
    const keys = [`ip:${clientIp(c)}`, `acct:${email}`];
    const wait = loginLimiter.blocked(keys);
    if (wait) throw new HttpError(429, `Too many wrong tries. Wait ${Math.ceil(wait / 60_000)} minutes and try again.`);
    const r = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as any;
    if (!r || !verifyPassword(String(b.password ?? ""), r.pass_hash)) {
      loginLimiter.fail(keys);
      throw new HttpError(401, "Wrong email or password");
    }
    loginLimiter.clear(`acct:${email}`);
    login(c, r.id);
    return c.json({ user: userById(r.id) });
  });
  api.post("/api/logout", (c) => {
    const t = getCookie(c, "cc_session");
    if (t) db.prepare("DELETE FROM sessions WHERE token = ?").run(t);
    deleteCookie(c, "cc_session", { path: "/" });
    return c.json({ ok: true });
  });

  // everything below needs a session
  api.use("/api/*", async (c, next) => {
    const u = sessionUser(c);
    if (!u) throw new HttpError(401, "Please sign in");
    c.set("user", u);
    await next();
  });

  api.get("/api/me", (c) => c.json({ user: c.get("user") }));
  api.patch("/api/me", async (c) => {
    const u = c.get("user");
    const b = await c.req.json();
    if (b.name) db.prepare("UPDATE users SET name = ? WHERE id = ?").run(String(b.name).slice(0, 60), u.id);
    if (b.password !== undefined) {
      const row = db.prepare("SELECT pass_hash FROM users WHERE id = ?").get(u.id) as any;
      if (!verifyPassword(String(b.currentPassword ?? ""), row.pass_hash)) throw new HttpError(403, "Your current password is wrong");
      if (String(b.password).length < 8) throw bad("password needs at least 8 characters");
      db.prepare("UPDATE users SET pass_hash = ? WHERE id = ?").run(hashPassword(String(b.password)), u.id);
      // sign out other sessions
      const current = getCookie(c, "cc_session") ?? "";
      db.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?").run(u.id, current);
    }
    return c.json({ user: userById(u.id) });
  });

  // ---------------------------------------------------------------- people
  api.get("/api/users", (c) => c.json({ users: db.prepare("SELECT id, email, name, role, created_at AS createdAt FROM users ORDER BY created_at").all() }));
  api.post("/api/users", async (c) => {
    requireRole(c.get("user"), "admin");
    const b = await c.req.json();
    const role: Role = ["admin", "builder", "member"].includes(b.role) ? b.role : "member";
    const pw = b.password || token(9);
    const uid = id("u_");
    try {
      db.prepare("INSERT INTO users(id, email, name, pass_hash, role, created_at) VALUES(?,?,?,?,?,?)").run(
        uid,
        String(need(b.email, "email")).toLowerCase(),
        need(b.name, "name"),
        hashPassword(pw),
        role,
        now(),
      );
    } catch {
      throw bad("someone with that email already exists");
    }
    return c.json({ user: userById(uid), tempPassword: b.password ? undefined : pw });
  });
  api.patch("/api/users/:id", async (c) => {
    const me = c.get("user");
    requireRole(me, "admin");
    const b = await c.req.json();
    const target = userById(c.req.param("id"));
    if (!target) throw new HttpError(404, "not found");
    if (target.role === "owner") throw bad("the owner's role can't be changed");
    if (b.role && ["admin", "builder", "member"].includes(b.role)) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(b.role, target.id);
    return c.json({ user: userById(target.id) });
  });

  // ---------------------------------------------------------------- agents
  const agentOut = (a: any) => ({ ...a, status: app.runtime.statusOf(a.id), monthCostMicros: svc.monthCostMicros(a.id) });
  api.get("/api/agents", (c) => c.json({ agents: svc.agents().map(agentOut) }));
  api.get("/api/agents/:id", (c) => {
    const a = svc.agent(c.req.param("id"));
    if (!a) throw new HttpError(404, "no such agent");
    const chats = (db.prepare("SELECT chat_id FROM chat_members WHERE member_type = 'agent' AND member_id = ?").all(a.id) as any[]).map((r) =>
      svc.chat(r.chat_id),
    );
    return c.json({
      agent: agentOut(a),
      chats,
      memories: svc
        .memoriesFor(a.id, "")
        .filter((m: any) => m.scope === "agent" || m.byId === a.id)
        .slice(0, 50),
    });
  });
  const validAgentFields = (b: any, partial: boolean) => {
    const out: any = {};
    if (!partial || b.name !== undefined) out.name = String(need(b.name, "name")).slice(0, 40);
    if (b.handle !== undefined || !partial) {
      const h = String(b.handle ?? b.name ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "")
        .slice(0, 30);
      if (!/^[a-z][a-z0-9_-]{1,29}$/.test(h)) throw bad("handle must start with a letter and be 2-30 characters");
      if (MENTION_ALL.has(h)) throw bad(`@${h} is kept for mentioning every agent in a chat. Pick another handle.`);
      out.handle = h;
    }
    if (b.roleTitle !== undefined) out.role_title = String(b.roleTitle).slice(0, 60);
    if (b.style !== undefined) {
      if (!STYLES.includes(b.style)) throw bad("unknown style");
      out.style = b.style;
    }
    if (b.colour !== undefined) {
      if (!COLOURS.includes(b.colour)) throw bad("unknown colour");
      out.colour = b.colour;
    }
    if (b.engine !== undefined) {
      if (!ENGINES.some((e) => e.id === b.engine)) throw bad("unknown engine");
      out.engine = b.engine;
    }
    if (b.model !== undefined) out.model = String(b.model).slice(0, 120);
    if (b.instructions !== undefined) out.instructions = String(b.instructions).slice(0, 20000);
    if (b.autonomy !== undefined) {
      if (!["ask", "act", "auto"].includes(b.autonomy)) throw bad("autonomy must be ask, act or auto");
      out.autonomy = b.autonomy;
    }
    if (b.sandbox !== undefined) {
      if (!["docker", "local"].includes(b.sandbox)) throw bad("sandbox must be docker or local");
      out.sandbox = b.sandbox;
    }
    if (b.budgetCents !== undefined) out.budget_cents = Math.max(0, Math.round(Number(b.budgetCents) || 0));
    return out;
  };
  api.post("/api/agents", async (c) => {
    const u = c.get("user");
    requireRole(u, "builder");
    const b = await c.req.json();
    const f = validAgentFields(b, false);
    if (svc.agent(f.handle)) throw bad(`@${f.handle} is taken`);
    const aid = id("a_");
    const style = f.style ?? STYLES[Math.floor(Math.random() * STYLES.length)];
    const colour = f.colour ?? COLOURS[Math.floor(Math.random() * COLOURS.length)]; // new agents get a random colour
    db.prepare(
      `INSERT INTO agents(id, handle, name, role_title, style, colour, engine, model, instructions, autonomy, sandbox, email, budget_cents, created_by, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      aid,
      f.handle,
      f.name,
      f.role_title ?? "",
      style,
      colour,
      f.engine ?? "hermes",
      f.model ?? "",
      f.instructions ?? "",
      f.autonomy ?? "act",
      f.sandbox ?? "docker",
      `${f.handle}@agents.local`,
      f.budget_cents ?? 0,
      u.id,
      now(),
    );
    agentDirs(app.cfg.dataDir, aid);
    for (const cid of b.chats ?? []) if (svc.chat(cid)) svc.addMember(cid, "agent", aid);
    return c.json({ agent: agentOut(svc.agent(aid)) });
  });
  api.patch("/api/agents/:id", async (c) => {
    requireRole(c.get("user"), "builder");
    const a = svc.agent(c.req.param("id"));
    if (!a) throw new HttpError(404, "no such agent");
    const f = validAgentFields(await c.req.json(), true);
    if (f.handle && f.handle !== a.handle && svc.agent(f.handle)) throw bad(`@${f.handle} is taken`);
    const keys = Object.keys(f);
    if (keys.length) db.prepare(`UPDATE agents SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => f[k]), a.id);
    // engine, model or sandbox changes need a fresh process
    if (f.engine || f.model !== undefined || f.sandbox) await app.runtime.worker(a.id).stop();
    return c.json({ agent: agentOut(svc.agent(a.id)) });
  });
  api.delete("/api/agents/:id", async (c) => {
    requireRole(c.get("user"), "admin");
    const a = svc.agent(c.req.param("id"));
    if (!a) throw new HttpError(404, "no such agent");
    await app.runtime.worker(a.id).stop();
    db.prepare("UPDATE agents SET archived = 1, handle = handle || '-archived-' || ? WHERE id = ?").run(Date.now(), a.id);
    return c.json({ ok: true });
  });
  api.post("/api/agents/:id/:action{pause|wake|restart|cancel}", async (c) => {
    const a = svc.agent(c.req.param("id"));
    if (!a) throw new HttpError(404, "no such agent");
    const w = app.runtime.worker(a.id);
    const action = c.req.param("action");
    if (action === "pause") await w.stop();
    if (action === "cancel") w.cancelTurn();
    if (action === "wake") await w.ensureStarted();
    if (action === "restart") {
      await w.stop();
      await w.ensureStarted();
    }
    return c.json({ status: app.runtime.statusOf(a.id) });
  });
  api.post("/api/agents/:id/new-session", async (c) => {
    const a = svc.agent(c.req.param("id"));
    if (!a) throw new HttpError(404, "no such agent");
    const chatId = (await c.req.json()).chatId;
    const scopes = chatId ? [String(chatId)] : (db.prepare("SELECT scope FROM agent_sessions WHERE agent_id = ?").all(a.id) as any[]).map((r) => r.scope);
    for (const s of scopes) await app.runtime.worker(a.id).newSession(s);
    return c.json({ ok: true });
  });
  api.get("/api/agents/:id/activity", (c) => {
    const a = svc.agent(c.req.param("id"));
    if (!a) throw new HttpError(404, "no such agent");
    return c.json({
      status: app.runtime.statusOf(a.id),
      activity: app.runtime.worker(a.id).recentActivity(Number(c.req.query("limit") ?? 300)),
      queued: svc.queued(a.id),
    });
  });
  api.post("/api/agents/import/inspect", async (c) => {
    requireRole(c.get("user"), "builder");
    const b = await c.req.json();
    try {
      return c.json({ found: inspectAgentFolder(String(need(b.path, "path"))) });
    } catch (e) {
      throw bad((e as Error).message);
    }
  });
  api.post("/api/agents/import", async (c) => {
    const u = c.get("user");
    requireRole(u, "builder");
    const b = await c.req.json();
    let found;
    try {
      found = inspectAgentFolder(String(need(b.path, "path")));
    } catch (e) {
      throw bad((e as Error).message);
    }
    const handle =
      String(b.handle ?? found.name)
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "")
        .slice(0, 30) || "imported";
    if (MENTION_ALL.has(handle)) throw bad(`@${handle} is kept for mentioning every agent in a chat. Pick another handle.`);
    if (svc.agent(handle)) throw bad(`@${handle} is taken`);
    const aid = id("a_");
    db.prepare(
      `INSERT INTO agents(id, handle, name, role_title, style, colour, engine, model, instructions, autonomy, sandbox, email, created_by, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      aid,
      handle,
      b.name ?? found.name,
      b.roleTitle ?? "",
      STYLES[Math.floor(Math.random() * STYLES.length)],
      COLOURS[Math.floor(Math.random() * COLOURS.length)],
      b.engine ?? found.kind,
      b.model ?? "",
      found.instructions,
      "act",
      b.sandbox ?? "docker",
      `${handle}@agents.local`,
      u.id,
      now(),
    );
    const { home } = agentDirs(app.cfg.dataDir, aid);
    const skills = found.skillsDir ? copySkills(found.skillsDir, home) : 0;
    let mems = 0;
    for (const m of found.memories) {
      try {
        svc.remember({ scope: "agent", scopeId: aid, text: m, source: `imported from ${found.kind}`, byType: "user", byId: u.id });
        mems++;
      } catch {}
    }
    return c.json({ agent: agentOut(svc.agent(aid)), imported: { memories: mems, skills } });
  });

  // ---------------------------------------------------------------- chats + messages
  const canSee = (u: User, cid: string) => {
    const chat = svc.chat(cid);
    if (!chat) throw new HttpError(404, "no such chat");
    if (chat.kind === "agents" || svc.isMember(cid, "user", u.id)) return chat;
    throw new HttpError(403, "You're not in that chat");
  };
  api.get("/api/chats", (c) => c.json({ chats: svc.chatsForUser(c.get("user").id) }));
  api.post("/api/chats", async (c) => {
    const u = c.get("user");
    const b = await c.req.json();
    if (b.dmAgent) return c.json({ chat: svc.chat(svc.dmWith(u.id, String(b.dmAgent))) });
    const members = [{ type: "user" as const, id: u.id }];
    for (const uid of b.users ?? []) if (userById(uid)) members.push({ type: "user", id: uid });
    for (const aid of b.agents ?? []) if (svc.agent(aid)) members.push({ type: "agent", id: svc.agent(aid)!.id } as any);
    const cid = svc.createChat("group", String(need(b.name, "name")).slice(0, 80), u.id, members);
    return c.json({ chat: svc.chat(cid) });
  });
  api.get("/api/chats/:id", (c) => {
    const chat = canSee(c.get("user"), c.req.param("id"));
    return c.json({ chat, agents: svc.chatAgents(chat.id).map(agentOut) });
  });
  api.patch("/api/chats/:id", async (c) => {
    const chat = canSee(c.get("user"), c.req.param("id"));
    const b = await c.req.json();
    if (b.name) db.prepare("UPDATE chats SET name = ? WHERE id = ?").run(String(b.name).slice(0, 80), chat.id);
    return c.json({ chat: svc.chat(chat.id) });
  });
  api.post("/api/chats/:id/members", async (c) => {
    const chat = canSee(c.get("user"), c.req.param("id"));
    const b = await c.req.json();
    const type = b.type === "agent" ? "agent" : "user";
    const mid = type === "agent" ? svc.agent(String(b.id))?.id : userById(String(b.id))?.id;
    if (!mid) throw bad("not found");
    if (b.remove) svc.removeMember(chat.id, type, mid);
    else svc.addMember(chat.id, type, mid);
    return c.json({ chat: svc.chat(chat.id) });
  });
  api.get("/api/chats/:id/messages", (c) => {
    const chat = canSee(c.get("user"), c.req.param("id"));
    const before = c.req.query("before") ? Number(c.req.query("before")) : undefined;
    return c.json({ messages: svc.messages(chat.id, before, Math.min(Number(c.req.query("limit") ?? 100), 200)) });
  });
  api.post("/api/chats/:id/messages", async (c) => {
    const u = c.get("user");
    const chat = canSee(u, c.req.param("id"));
    if (chat.kind === "agents" && !svc.isMember(chat.id, "user", u.id)) svc.addMember(chat.id, "user", u.id); // stepping in
    const b = await c.req.json();
    const body = String(need(b.body, "message")).slice(0, 20000);
    const m = svc.post({ chatId: chat.id, authorType: "user", authorId: u.id, body });
    svc.markRead(chat.id, u.id);
    return c.json({ message: m });
  });
  api.post("/api/chats/:id/warm", (c) => {
    const chat = canSee(c.get("user"), c.req.param("id"));
    app.runtime.warmChat(chat.id);
    return c.json({ ok: true });
  });
  api.post("/api/chats/:id/read", (c) => {
    const chat = canSee(c.get("user"), c.req.param("id"));
    svc.markRead(chat.id, c.get("user").id);
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- approvals ("Needs you")
  api.get("/api/approvals", (c) => c.json({ approvals: svc.approvals(c.req.query("state") ?? undefined) }));
  api.post("/api/approvals/:id/decide", async (c) => {
    const u = c.get("user");
    const ap = svc.approval(c.req.param("id"));
    if (!ap) throw new HttpError(404, "no such approval");
    if (ap.state !== "pending") throw new HttpError(409, `already ${ap.state}`);
    // who may answer: admins, or the person whose request led to this
    const requester = ap.detail?.requester;
    if (RANK[u.role] < RANK.admin && !(requester?.type === "user" && requester.id === u.id) && !(ap.chatId && svc.isMember(ap.chatId, "user", u.id)))
      throw new HttpError(403, "You can't answer this one");
    const b = await c.req.json();
    const decision = String(b.decision);
    if (!["allow_once", "allow_always", "deny"].includes(decision)) throw bad("decision must be allow_once, allow_always or deny");
    const out = svc.decideApproval(ap.id, decision === "deny" ? "denied" : "approved", decision, u.id, String(b.reason ?? "").slice(0, 500));
    // reflect the answer on the approval card in chat
    const card = db.prepare("SELECT id FROM messages WHERE kind = 'approval' AND json_extract(meta, '$.approvalId') = ?").get(ap.id) as any;
    if (card) svc.updateMessageMeta(card.id, { state: out.state, decidedBy: u.id, decision });
    return c.json({ approval: out });
  });

  // ---------------------------------------------------------------- memory
  api.get("/api/memories", (c) => {
    const scope = c.req.query("scope");
    const scopeId = c.req.query("scopeId") ?? "";
    const rows = scope
      ? db.prepare("SELECT id FROM memories WHERE scope = ? AND (? = '' OR scope_id = ?) ORDER BY created_at DESC LIMIT 300").all(scope, scopeId, scopeId)
      : db.prepare("SELECT id FROM memories ORDER BY created_at DESC LIMIT 300").all();
    return c.json({ memories: (rows as any[]).map((r) => svc.memory(r.id)), paused: svc.memoryPaused() });
  });
  api.post("/api/memories", async (c) => {
    const u = c.get("user");
    const b = await c.req.json();
    try {
      return c.json({
        memory: svc.remember({
          scope: b.scope ?? "team",
          scopeId: b.scopeId ?? "",
          text: String(need(b.text, "text")),
          source: "added by hand",
          byType: "user",
          byId: u.id,
        }),
      });
    } catch (e) {
      throw bad((e as Error).message);
    }
  });
  api.patch("/api/memories/:id", async (c) => {
    const b = await c.req.json();
    const m = svc.memory(c.req.param("id"));
    if (!m) throw new HttpError(404, "not found");
    if (b.forget) svc.forget(m.id, c.get("user").id);
    if (b.restore) svc.restore(m.id);
    if (typeof b.text === "string" && b.text.trim()) db.prepare("UPDATE memories SET text = ? WHERE id = ?").run(b.text.trim().slice(0, 2000), m.id);
    return c.json({ memory: svc.memory(m.id) });
  });
  api.put("/api/memories/paused", async (c) => {
    requireRole(c.get("user"), "admin");
    setSetting(db, "memory_paused", (await c.req.json()).paused ? "1" : "0");
    return c.json({ paused: svc.memoryPaused() });
  });

  // ---------------------------------------------------------------- tasks
  api.get("/api/tasks", (c) => {
    const u = c.get("user");
    const chat = c.req.query("chat");
    if (chat) canSee(u, chat);
    const visible = new Set(svc.chatsForUser(u.id).map((x: any) => x.id));
    return c.json({ tasks: svc.tasks(chat ?? undefined).filter((t) => visible.has(t.chatId)) });
  });
  api.post("/api/tasks", async (c) => {
    const b = await c.req.json();
    canSee(c.get("user"), String(need(b.chatId, "chatId")));
    return c.json({
      task: svc.createTask({
        chatId: b.chatId,
        title: need(b.title, "title"),
        assigneeType: b.assigneeType,
        assigneeId: b.assigneeId,
        createdBy: c.get("user").id,
      }),
    });
  });
  api.patch("/api/tasks/:id", async (c) => {
    const b = await c.req.json();
    if (b.status && !["todo", "working", "needs_you", "checking", "done"].includes(b.status)) throw bad("bad status");
    try {
      return c.json({ task: svc.updateTask(c.req.param("id"), b) });
    } catch (e) {
      throw new HttpError(404, (e as Error).message);
    }
  });

  // ---------------------------------------------------------------- integrations: connections
  const connOut = (r: any) => ({
    id: r.id,
    app: r.app,
    name: r.name,
    identity: r.identity,
    ownerUserId: r.owner_user_id,
    hasSecret: !!r.secret_id,
    config: json(r.config, {}),
    status: r.status,
    createdAt: r.created_at,
    grants: gateway.grants("connection", r.id),
    policies: gateway.policies("connection", r.id),
  });
  // The app catalog for Settings > Apps (no secrets, no code: just what the form needs)
  api.get("/api/apps/catalog", (c) =>
    c.json({
      apps: APP_CATALOG.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        blurb: p.blurb,
        fields: (p.fields ?? []).map((f) => ({ key: f.key, label: f.label, placeholder: f.placeholder, hint: f.hint })),
        secretLabel: p.secretLabel,
        secretPlaceholder: p.secretPlaceholder,
        howTo: p.howTo,
        howToUrl: p.howToUrl,
      })),
    }),
  );
  api.get("/api/connections", (c) => c.json({ connections: (db.prepare("SELECT * FROM connections ORDER BY created_at").all() as any[]).map(connOut) }));
  api.post("/api/connections", async (c) => {
    const u = c.get("user");
    const b = await c.req.json();
    const p = b.preset ? preset(String(b.preset)) : undefined;
    if (b.preset && !p) throw bad("unknown app");
    const appKind = p ? "http" : String(need(b.app, "app"));
    if (!["github", "http"].includes(appKind)) throw bad("app must be github or http");
    const identity = b.identity === "user" ? "user" : "agent";
    if (identity === "agent") requireRole(u, "builder");
    const cfg: any = {};
    if (appKind === "github") {
      cfg.repos = (b.repos ?? []).map(String);
      if (b.apiBase) cfg.apiBase = String(b.apiBase);
    }
    if (p) {
      if (!b.secret) throw bad(`${p.secretLabel} is needed`);
      try {
        Object.assign(cfg, presetConfig(p, b.fields ?? {}, String(b.secret)));
      } catch (e) {
        throw bad((e as Error).message);
      }
    } else if (appKind === "http") {
      const base = String(need(b.baseUrl, "baseUrl"));
      let url: URL;
      try {
        url = new URL(base);
      } catch {
        throw bad("baseUrl must be a full URL");
      }
      if (!["https:", "http:"].includes(url.protocol)) throw bad("only http and https");
      cfg.baseUrl = base.replace(/\/+$/, "");
      if (b.authHeader) cfg.authHeader = String(b.authHeader);
      if (b.authScheme !== undefined) cfg.authScheme = String(b.authScheme);
    }
    const cid = id("conn_");
    const secretId = b.secret ? gateway.putSecret(`connection:${cid}`, String(b.secret)) : "";
    db.prepare("INSERT INTO connections(id, app, name, identity, owner_user_id, secret_id, config, created_at) VALUES(?,?,?,?,?,?,?,?)").run(
      cid,
      appKind,
      String(b.name || p?.name || need(b.name, "name")).slice(0, 60),
      identity,
      identity === "user" ? u.id : "",
      secretId,
      JSON.stringify(cfg),
      now(),
    );
    if (identity === "user") gateway.setGrants("connection", cid, [{ type: "workspace" }]); // personal: still only usable on the owner's own requests
    return c.json({ connection: connOut(db.prepare("SELECT * FROM connections WHERE id = ?").get(cid)) });
  });
  api.put("/api/connections/:id/grants", async (c) => {
    requireRole(c.get("user"), "builder");
    const r = db.prepare("SELECT * FROM connections WHERE id = ?").get(c.req.param("id")) as any;
    if (!r) throw new HttpError(404, "not found");
    gateway.setGrants(
      "connection",
      r.id,
      ((await c.req.json()).grants ?? []).filter((g: any) => ["workspace", "chat", "agent"].includes(g.type)),
    );
    return c.json({ connection: connOut(r) });
  });
  api.put("/api/connections/:id/policies", async (c) => {
    requireRole(c.get("user"), "builder");
    const r = db.prepare("SELECT * FROM connections WHERE id = ?").get(c.req.param("id")) as any;
    if (!r) throw new HttpError(404, "not found");
    for (const [tool, d] of Object.entries((await c.req.json()).policies ?? {}))
      if (["allow", "ask", "block"].includes(String(d))) gateway.setPolicy("connection", r.id, tool, d as any);
    return c.json({ connection: connOut(r) });
  });
  api.delete("/api/connections/:id", (c) => {
    requireRole(c.get("user"), "builder");
    const r = db.prepare("SELECT * FROM connections WHERE id = ?").get(c.req.param("id")) as any;
    if (!r) throw new HttpError(404, "not found");
    if (r.secret_id) gateway.deleteSecret(r.secret_id);
    db.prepare("DELETE FROM grants WHERE resource_type = 'connection' AND resource_id = ?").run(r.id);
    db.prepare("DELETE FROM policies WHERE resource_type = 'connection' AND resource_id = ?").run(r.id);
    db.prepare("DELETE FROM connections WHERE id = ?").run(r.id);
    return c.json({ ok: true });
  });
  api.patch("/api/connections/:id", async (c) => {
    const u = c.get("user");
    const r = db.prepare("SELECT * FROM connections WHERE id = ?").get(c.req.param("id")) as any;
    if (!r) throw new HttpError(404, "not found");
    if (r.identity === "user" ? r.owner_user_id !== u.id : RANK[u.role] < RANK.builder) throw new HttpError(403, "You can't change this connection");
    const b = await c.req.json();
    const cfg = json<any>(r.config, {});
    if (b.name) db.prepare("UPDATE connections SET name = ? WHERE id = ?").run(String(b.name).slice(0, 60), r.id);
    if (r.app === "github" && Array.isArray(b.repos)) cfg.repos = b.repos.map(String);
    if (r.app === "http" && b.baseUrl) {
      // a catalog app's address is fixed: its token only ever goes to that service
      if (cfg.preset) throw bad("The address of a catalog app can't be changed. Remove it and connect again.");
      let url: URL;
      try { url = new URL(String(b.baseUrl)); } catch { throw bad("baseUrl must be a full URL"); }
      if (!["https:", "http:"].includes(url.protocol)) throw bad("only http and https");
      // moving a stored token to another host needs the token typed again
      const oldHost = (() => { try { return new URL(cfg.baseUrl).host; } catch { return ""; } })();
      if (url.host !== oldHost && r.secret_id && !(typeof b.secret === "string" && b.secret)) throw bad("Enter the token again when you change the address to another host.");
      cfg.baseUrl = String(b.baseUrl).replace(/\/+$/, "");
    }
    db.prepare("UPDATE connections SET config = ? WHERE id = ?").run(JSON.stringify(cfg), r.id);
    if (typeof b.secret === "string" && b.secret) {
      if (r.secret_id) gateway.deleteSecret(r.secret_id);
      db.prepare("UPDATE connections SET secret_id = ?, status = 'ok' WHERE id = ?").run(gateway.putSecret(`connection:${r.id}`, b.secret), r.id);
    }
    if (b.enabled !== undefined) db.prepare("UPDATE connections SET status = ? WHERE id = ?").run(b.enabled ? "ok" : "disabled", r.id);
    return c.json({ connection: connOut(db.prepare("SELECT * FROM connections WHERE id = ?").get(r.id)) });
  });
  api.post("/api/connections/:id/test", async (c) => {
    const r = db.prepare("SELECT * FROM connections WHERE id = ?").get(c.req.param("id")) as any;
    if (!r) throw new HttpError(404, "not found");
    const cfg = json<any>(r.config, {});
    try {
      if (r.app === "github") {
        const res = await fetch((cfg.apiBase || "https://api.github.com") + "/user", {
          headers: { authorization: `Bearer ${gateway.getSecret(r.secret_id)}`, "user-agent": "circlechat" },
        });
        return c.json({ ok: res.ok, detail: res.ok ? `Signed in as ${(await res.json()).login}` : `GitHub said ${res.status}` });
      }
      const p = cfg.preset ? preset(cfg.preset) : undefined;
      if (p) return c.json(await checkPreset(p, cfg, r.secret_id ? gateway.getSecret(r.secret_id) : ""));
      const res = await fetch(cfg.baseUrl, {
        method: "GET",
        headers: r.secret_id ? { [cfg.authHeader || "Authorization"]: (cfg.authScheme ?? "Bearer ") + gateway.getSecret(r.secret_id) } : {},
      });
      return c.json({ ok: res.status < 500, detail: `${res.status} from ${new URL(cfg.baseUrl).host}` });
    } catch (e) {
      return c.json({ ok: false, detail: (e as Error).message });
    }
  });

  // ---------------------------------------------------------------- integrations: MCP servers
  const mcpOut = (r: any) => ({
    id: r.id,
    name: r.name,
    transport: r.transport,
    url: r.url,
    command: r.command,
    args: json(r.args, []),
    secrets: Object.keys(json(r.env_secrets, {})),
    tools: json(r.tools, []),
    status: r.status,
    error: r.error,
    grants: gateway.grants("mcp", r.id),
    policies: gateway.policies("mcp", r.id),
  });
  api.get("/api/mcp", (c) => c.json({ servers: (db.prepare("SELECT * FROM mcp_servers ORDER BY created_at").all() as any[]).map(mcpOut) }));
  api.post("/api/mcp", async (c) => {
    requireRole(c.get("user"), "builder");
    const b = await c.req.json();
    const name = slug(String(need(b.name, "name")));
    const transport = b.transport === "stdio" ? "stdio" : "http";
    if (transport === "http") {
      try {
        new URL(String(need(b.url, "url")));
      } catch {
        throw bad("url must be a full URL");
      }
    }
    if (transport === "stdio") need(b.command, "command");
    const sid = id("mcp_");
    const envSecrets: Record<string, string> = {};
    for (const [k, v] of Object.entries(b.secrets ?? {}))
      if (/^[A-Z_][A-Z0-9_]*$/.test(k) && v) envSecrets[k] = gateway.putSecret(`mcp:${sid}:${k}`, String(v));
    try {
      db.prepare("INSERT INTO mcp_servers(id, name, transport, url, command, args, env_secrets, created_at) VALUES(?,?,?,?,?,?,?,?)").run(
        sid,
        name,
        transport,
        b.url ?? "",
        b.command ?? "",
        JSON.stringify(b.args ?? []),
        JSON.stringify(envSecrets),
        now(),
      );
    } catch {
      throw bad("an MCP server with that name exists");
    }
    let refresh: any = null;
    try {
      refresh = await gateway.refreshMcp(sid);
    } catch (e) {
      refresh = { error: (e as Error).message };
    }
    return c.json({ server: mcpOut(db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(sid)), refresh });
  });
  api.post("/api/mcp/:id/refresh", async (c) => {
    try {
      const r = await gateway.refreshMcp(c.req.param("id"));
      return c.json({ ...r, server: mcpOut(db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(c.req.param("id"))) });
    } catch (e) {
      throw bad((e as Error).message);
    }
  });
  api.put("/api/mcp/:id/grants", async (c) => {
    requireRole(c.get("user"), "builder");
    const r = db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(c.req.param("id")) as any;
    if (!r) throw new HttpError(404, "not found");
    gateway.setGrants(
      "mcp",
      r.id,
      ((await c.req.json()).grants ?? []).filter((g: any) => ["workspace", "chat", "agent"].includes(g.type)),
    );
    return c.json({ server: mcpOut(r) });
  });
  api.put("/api/mcp/:id/policies", async (c) => {
    requireRole(c.get("user"), "builder");
    const r = db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(c.req.param("id")) as any;
    if (!r) throw new HttpError(404, "not found");
    for (const [tool, d] of Object.entries((await c.req.json()).policies ?? {}))
      if (["allow", "ask", "block", "off"].includes(String(d))) gateway.setPolicy("mcp", r.id, tool, d as any);
    return c.json({ server: mcpOut(r) });
  });
  api.delete("/api/mcp/:id", async (c) => {
    requireRole(c.get("user"), "builder");
    const r = db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(c.req.param("id")) as any;
    if (!r) throw new HttpError(404, "not found");
    await gateway.closeMcp(r.id);
    for (const sid of Object.values(json<Record<string, string>>(r.env_secrets, {}))) gateway.deleteSecret(sid);
    db.prepare("DELETE FROM grants WHERE resource_type = 'mcp' AND resource_id = ?").run(r.id);
    db.prepare("DELETE FROM policies WHERE resource_type = 'mcp' AND resource_id = ?").run(r.id);
    db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(r.id);
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- triggers
  const trgOut = (t: any) => ({ ...t, secret: undefined, hasSecret: !!t.secret, url: `/hooks/${t.id}`, runs: app.triggers.runs(t.id, 5) });
  api.get("/api/triggers", (c) => c.json({ triggers: app.triggers.list().map(trgOut) }));
  api.post("/api/triggers", async (c) => {
    requireRole(c.get("user"), "builder");
    const b = await c.req.json();
    try {
      const t = app.triggers.create({
        kind: b.kind === "schedule" ? "schedule" : "webhook",
        name: need(b.name, "name"),
        secret: b.secret ?? "",
        schedule: b.schedule ?? "",
        filter: b.filter ?? {},
        chatId: need(b.chatId, "chatId"),
        agentId: svc.agent(need(b.agentId, "agentId"))?.id ?? b.agentId,
        prompt: need(b.prompt, "prompt"),
        enabled: b.enabled,
      });
      return c.json({ trigger: trgOut(t) });
    } catch (e) {
      throw bad((e as Error).message);
    }
  });
  api.patch("/api/triggers/:id", async (c) => {
    requireRole(c.get("user"), "builder");
    try {
      return c.json({ trigger: trgOut(app.triggers.update(c.req.param("id"), await c.req.json())) });
    } catch (e) {
      throw bad((e as Error).message);
    }
  });
  api.delete("/api/triggers/:id", (c) => {
    requireRole(c.get("user"), "builder");
    app.triggers.remove(c.req.param("id"));
    return c.json({ ok: true });
  });
  api.get("/api/triggers/:id/runs", (c) => c.json({ runs: app.triggers.runs(c.req.param("id"), 50) }));
  api.post("/api/trigger-runs/:id/replay", (c) => {
    try {
      app.triggers.replay(c.req.param("id"));
      return c.json({ ok: true });
    } catch (e) {
      throw bad((e as Error).message);
    }
  });

  // ---------------------------------------------------------------- tool log
  api.get("/api/toollog", (c) => {
    const agent = c.req.query("agent");
    const only = c.req.query("only");
    let sql = "SELECT * FROM tool_calls WHERE 1=1";
    const args: any[] = [];
    if (agent) {
      sql += " AND agent_id = ?";
      args.push(agent);
    }
    if (only === "approval") sql += " AND (approval LIKE '%approved%' OR status = 'denied')";
    if (only === "failed") sql += " AND status IN ('error','blocked','denied')";
    sql += " ORDER BY seq DESC LIMIT 300";
    const rows = (db.prepare(sql).all(...args) as any[]).map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      chatId: r.chat_id,
      tool: r.tool,
      args: json(r.args, {}),
      asIdentity: r.as_identity,
      approval: r.approval,
      status: r.status,
      result: r.result,
      costMicros: r.cost_micros,
      ts: r.ts,
    }));
    return c.json({ calls: rows });
  });
  api.get("/api/toollog/verify", (c) => c.json(verifyChain(db)));

  // ---------------------------------------------------------------- engines, models, usage, settings
  api.get("/api/engines", async (c) => c.json({ engines: await app.engineStatus() }));
  api.post("/api/engines/:id/install", (c) => {
    requireRole(c.get("user"), "admin");
    try {
      app.installEngine(c.req.param("id"));
    } catch (e) {
      throw bad((e as Error).message);
    }
    return c.json({ ok: true });
  });
  // Hosted: "CircleChat models" (paid by AI credits) is built in. It can't be edited or removed here.
  const builtin = (pid: string) => pid === "circlechat" && !!hosting(app);
  const providersOut = () => (app.providers(false) as any[]).map((p) => ({ ...p, builtin: builtin(p.id) }));
  api.get("/api/providers", (c) => c.json({ providers: providersOut() }));
  api.put("/api/providers/:id", async (c) => {
    requireRole(c.get("user"), "admin");
    if (builtin(c.req.param("id"))) throw bad("CircleChat models are built in. Add your own provider instead.");
    const b = await c.req.json();
    if (!["openai-compatible", "anthropic", "openai"].includes(b.kind)) throw bad("kind must be openai-compatible, anthropic or openai");
    app.upsertProvider({
      id: c.req
        .param("id")
        .replace(/[^a-z0-9_-]/gi, "")
        .toLowerCase(),
      kind: b.kind,
      baseUrl: String(b.baseUrl ?? ""),
      apiKey: b.apiKey,
      models: (b.models ?? []).map(String),
      label: b.label,
    });
    return c.json({ providers: providersOut() });
  });
  api.delete("/api/providers/:id", (c) => {
    requireRole(c.get("user"), "admin");
    if (builtin(c.req.param("id"))) throw bad("CircleChat models are built in and can't be removed.");
    app.removeProvider(c.req.param("id"));
    return c.json({ providers: providersOut() });
  });
  api.post("/api/providers/:id/test", async (c) => {
    const p = (app.providers(true) as any[]).find((x) => x.id === c.req.param("id"));
    if (!p) throw new HttpError(404, "not found");
    try {
      if (p.kind === "anthropic") {
        const r = await fetch((p.baseUrl || "https://api.anthropic.com") + "/v1/models", {
          headers: { "x-api-key": p.apiKey, "anthropic-version": "2023-06-01" },
        });
        return c.json({ ok: r.ok, detail: `${r.status}` });
      }
      const r = await fetch((p.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "") + "/models", {
        headers: p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {},
      });
      const j: any = r.ok ? await r.json() : {};
      return c.json({ ok: r.ok, detail: r.ok ? `${(j.data ?? []).length} models` : `${r.status}`, models: (j.data ?? []).map((m: any) => m.id) });
    } catch (e) {
      return c.json({ ok: false, detail: (e as Error).message });
    }
  });
  api.get("/api/usage", (c) => {
    const month = new Date().toISOString().slice(0, 7);
    const rows = db
      .prepare("SELECT agent_id AS agentId, SUM(tokens) AS tokens, SUM(cost_micros) AS costMicros FROM usage WHERE day LIKE ? GROUP BY agent_id")
      .all(month + "%");
    return c.json({ month, total: svc.monthCostMicros(), limitCents: Number(getSetting(db, "monthly_limit_cents") ?? 0), byAgent: rows });
  });
  api.get("/api/settings", (c) =>
    c.json({
      workspace: getSetting(db, "workspace_name") ?? "",
      monthlyLimitCents: Number(getSetting(db, "monthly_limit_cents") ?? 0),
      memoryPaused: svc.memoryPaused(),
      sandboxMemory: getSetting(db, "sandbox_memory") ?? "2g",
    }),
  );
  api.put("/api/settings", async (c) => {
    requireRole(c.get("user"), "admin");
    const b = await c.req.json();
    if (b.workspace) setSetting(db, "workspace_name", String(b.workspace).slice(0, 60));
    if (b.monthlyLimitCents !== undefined) setSetting(db, "monthly_limit_cents", String(Math.max(0, Math.round(Number(b.monthlyLimitCents) || 0))));
    if (b.sandboxMemory && /^\d+[mg]$/.test(b.sandboxMemory)) setSetting(db, "sandbox_memory", b.sandboxMemory);
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- bridges
  api.get("/api/bridges", (c) =>
    c.json({
      bridges: (db.prepare("SELECT id, kind, chat_id AS chatId, external_id AS channel, enabled FROM bridges").all() as any[]).map((b) => ({
        ...b,
        status: app.bridges.get(b.id)?.status ?? "stopped",
        error: app.bridges.get(b.id)?.lastError ?? "",
      })),
    }),
  );
  api.post("/api/bridges", async (c) => {
    requireRole(c.get("user"), "admin");
    const b = await c.req.json();
    canSee(c.get("user"), String(need(b.chatId, "chatId")));
    const bid = id("br_");
    const sec = gateway.putSecret(`bridge:${bid}`, JSON.stringify({ botToken: need(b.botToken, "botToken"), appToken: need(b.appToken, "appToken") }));
    db.prepare("INSERT INTO bridges(id, kind, chat_id, external_id, secret_id, config, created_at) VALUES(?, 'slack', ?, ?, ?, ?, ?)").run(
      bid,
      b.chatId,
      need(b.channel, "channel"),
      sec,
      JSON.stringify(b.apiBase ? { apiBase: b.apiBase } : {}),
      now(),
    );
    try {
      await app.startBridge(bid);
    } catch (e) {
      return c.json({ id: bid, started: false, error: (e as Error).message });
    }
    return c.json({ id: bid, started: true });
  });

  api.delete("/api/bridges/:id", (c) => {
    requireRole(c.get("user"), "admin");
    const r = db.prepare("SELECT * FROM bridges WHERE id = ?").get(c.req.param("id")) as any;
    if (!r) throw new HttpError(404, "not found");
    app.bridges.get(r.id)?.stop();
    app.bridges.delete(r.id);
    if (r.secret_id) gateway.deleteSecret(r.secret_id);
    db.prepare("DELETE FROM bridges WHERE id = ?").run(r.id);
    return c.json({ ok: true });
  });
  api.patch("/api/bridges/:id", async (c) => {
    requireRole(c.get("user"), "admin");
    const r = db.prepare("SELECT * FROM bridges WHERE id = ?").get(c.req.param("id")) as any;
    if (!r) throw new HttpError(404, "not found");
    const on = !!(await c.req.json()).enabled;
    db.prepare("UPDATE bridges SET enabled = ? WHERE id = ?").run(on ? 1 : 0, r.id);
    if (on) await app.startBridge(r.id).catch(() => {});
    else app.bridges.get(r.id)?.stop();
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- your data (export, delete)
  api.get("/api/workspace/export", async (c) => {
    requireRole(c.get("user"), "owner");
    const out = await exportWorkspace(app);
    return new Response(out.stream, {
      headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="${out.filename}"`, "cache-control": "no-store" },
    });
  });
  api.post("/api/workspace/delete", async (c) => {
    const u = c.get("user");
    requireRole(u, "owner");
    // hosted: deleting must also stop the server and the subscription
    if (hosting(app)) throw bad("This workspace is hosted. Delete it from Settings, Hosting.");
    const b = await c.req.json();
    const row = db.prepare("SELECT pass_hash FROM users WHERE id = ?").get(u.id) as any;
    if (!verifyPassword(String(b.password ?? ""), row.pass_hash)) throw new HttpError(403, "Your password is wrong");
    const name = getSetting(db, "workspace_name") ?? "";
    if (String(b.confirm ?? "").trim() !== name) throw bad("type the workspace name to confirm");
    await eraseWorkspace(app);
    deleteCookie(c, "cc_session", { path: "/" });
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- hosting (hosted installs only)
  // Settings > Hosting: plan, billing, backups, server, domain, delete. This
  // server forwards to the control plane and adds the instance secret itself,
  // so the browser never sees it. Owners and admins only.
  api.all("/api/hosting/*", async (c) => {
    requireRole(c.get("user"), "admin");
    if (!hosting(app)) throw new HttpError(404, "This workspace isn't hosted by CircleChat");
    const rest = c.req.path.replace(/^\/api\/hosting\/?/, "");
    const body = ["GET", "HEAD"].includes(c.req.method) ? undefined : await c.req.text();
    let r: Response;
    try {
      r = await hostingFetch(app, rest, { method: c.req.method, body: body || undefined });
    } catch (e) {
      const cause = (e as any)?.cause?.code ?? (e as any)?.cause?.message ?? "";
      throw new HttpError(502, `Couldn't reach CircleChat Cloud: ${(e as Error).message}${cause ? ` (${cause})` : ""}`);
    }
    const headers: Record<string, string> = {};
    for (const k of ["content-type", "content-disposition", "cache-control"]) {
      const v = r.headers.get(k);
      if (v) headers[k] = v;
    }
    // The control plane refusing this workspace is not the browser's session
    // ending: never pass its 401/403 through, or the web app would sign out.
    if (r.status === 401 || r.status === 403) {
      await r.body?.cancel();
      throw new HttpError(502, "CircleChat Cloud didn't accept this workspace's request");
    }
    return new Response(r.body, { status: r.status, headers });
  });

  // ---------------------------------------------------------------- search
  api.get("/api/search", (c) => {
    const u = c.get("user");
    const q = String(c.req.query("q") ?? "").trim();
    if (q.length < 2) return c.json({ agents: [], chats: [], messages: [], tasks: [] });
    const like = `%${q.replace(/[%_]/g, "")}%`;
    const visible = new Set(svc.chatsForUser(u.id).map((x: any) => x.id));
    const messages = (db.prepare("SELECT * FROM messages WHERE body LIKE ? ORDER BY ts DESC LIMIT 100").all(like) as any[])
      .filter((m) => visible.has(m.chat_id))
      .slice(0, 30)
      .map((m) => ({ id: m.id, chatId: m.chat_id, authorType: m.author_type, authorId: m.author_id, body: m.body, ts: m.ts }));
    return c.json({
      agents: svc
        .agents()
        .filter((a) => (a.name + " " + a.handle + " " + a.roleTitle).toLowerCase().includes(q.toLowerCase()))
        .map(agentOut),
      chats: svc.chatsForUser(u.id).filter((x: any) => x.name.toLowerCase().includes(q.toLowerCase())),
      messages,
      tasks: svc.tasks().filter((t) => visible.has(t.chatId) && t.title.toLowerCase().includes(q.toLowerCase())),
    });
  });

  return api;
}

export function staticHandler(webDist: string) {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".woff2": "font/woff2",
    ".ico": "image/x-icon",
  };
  return (path: string): { body: Buffer; type: string } | null => {
    const clean = path.split("?")[0].replace(/\.\.+/g, "");
    let p = join(webDist, clean === "/" ? "index.html" : clean);
    if (!existsSync(p) || !p.startsWith(webDist)) p = join(webDist, "index.html"); // SPA fallback
    if (!existsSync(p)) return null;
    const ext = p.slice(p.lastIndexOf("."));
    return { body: readFileSync(p), type: types[ext] ?? "application/octet-stream" };
  };
}
