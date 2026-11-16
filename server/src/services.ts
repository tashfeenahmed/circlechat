// SPDX-License-Identifier: AGPL-3.0-only
// Chats, messages, routing, approvals, memory, tasks, usage. Pure data + events;
// the agent runtime and the tool gateway build on top of this.
import type { DB } from "./db.ts";
import { json, now, getSetting } from "./db.ts";
import { id } from "./crypto.ts";
import type { Bus } from "./bus.ts";

export const MAX_HOPS = 5;

export interface Message {
  id: string;
  chatId: string;
  authorType: "user" | "agent" | "system";
  authorId: string;
  kind: "text" | "plan" | "approval" | "handoff" | "memory" | "system" | "error" | "trigger";
  body: string;
  meta: Record<string, any>;
  ts: number;
}

export function rowToMessage(r: any): Message {
  return { id: r.id, chatId: r.chat_id, authorType: r.author_type, authorId: r.author_id, kind: r.kind, body: r.body, meta: json(r.meta, {}), ts: r.ts };
}

export interface Agent {
  id: string;
  handle: string;
  name: string;
  roleTitle: string;
  style: string;
  colour: string;
  engine: string;
  model: string;
  instructions: string;
  autonomy: "ask" | "act" | "auto";
  sandbox: "docker" | "local";
  email: string;
  budgetCents: number;
  createdBy: string;
  archived: boolean;
  createdAt: number;
}
export function rowToAgent(r: any): Agent {
  return {
    id: r.id,
    handle: r.handle,
    name: r.name,
    roleTitle: r.role_title,
    style: r.style,
    colour: r.colour,
    engine: r.engine,
    model: r.model,
    instructions: r.instructions,
    autonomy: r.autonomy,
    sandbox: r.sandbox,
    email: r.email,
    budgetCents: r.budget_cents,
    createdBy: r.created_by ?? "",
    archived: !!r.archived,
    createdAt: r.created_at,
  };
}

export interface Delivery {
  id: string;
  agentId: string;
  chatId: string;
  fromType: "user" | "agent" | "trigger" | "system";
  fromId: string;
  text: string;
  hop: number;
  goalId: string;
  state: string;
  createdAt: number;
}
export function rowToDelivery(r: any): Delivery {
  return {
    id: r.id,
    agentId: r.agent_id,
    chatId: r.chat_id,
    fromType: r.from_type,
    fromId: r.from_id,
    text: r.text,
    hop: r.hop,
    goalId: r.goal_id,
    state: r.state,
    createdAt: r.created_at,
  };
}

/** Called whenever a delivery is queued, so the runtime can wake the agent. */
export type DeliveryListener = (d: Delivery) => void;

export class Services {
  private deliveryListeners: DeliveryListener[] = [];
  db: DB;
  bus: Bus;
  constructor(db: DB, bus: Bus) {
    this.db = db;
    this.bus = bus;
  }

  onDelivery(fn: DeliveryListener): void {
    this.deliveryListeners.push(fn);
  }

  // ---------------------------------------------------------------- agents
  agent(idOrHandle: string): Agent | undefined {
    const r = this.db.prepare("SELECT * FROM agents WHERE (id = ? OR handle = ?) AND archived = 0").get(idOrHandle, idOrHandle.toLowerCase());
    return r ? rowToAgent(r) : undefined;
  }
  agents(): Agent[] {
    return (this.db.prepare("SELECT * FROM agents WHERE archived = 0 ORDER BY created_at").all() as any[]).map(rowToAgent);
  }

  // ---------------------------------------------------------------- chats
  createChat(kind: "group" | "dm" | "agents", name: string, createdBy: string, members: { type: "user" | "agent"; id: string }[]): string {
    const cid = id("c_");
    this.db.prepare("INSERT INTO chats(id, kind, name, created_by, created_at) VALUES(?,?,?,?,?)").run(cid, kind, name, createdBy, now());
    const ins = this.db.prepare("INSERT OR IGNORE INTO chat_members(chat_id, member_type, member_id) VALUES(?,?,?)");
    for (const m of members) ins.run(cid, m.type, m.id);
    this.bus.emitEvent({ type: "chat", chat: this.chat(cid) });
    return cid;
  }
  chat(cid: string): any {
    const c = this.db.prepare("SELECT * FROM chats WHERE id = ?").get(cid) as any;
    if (!c) return undefined;
    const members = this.db.prepare("SELECT member_type AS type, member_id AS id FROM chat_members WHERE chat_id = ?").all(cid);
    return { id: c.id, kind: c.kind, name: c.name, createdAt: c.created_at, members };
  }
  isMember(cid: string, type: "user" | "agent", mid: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM chat_members WHERE chat_id = ? AND member_type = ? AND member_id = ?").get(cid, type, mid);
  }
  addMember(cid: string, type: "user" | "agent", mid: string): void {
    this.db.prepare("INSERT OR IGNORE INTO chat_members(chat_id, member_type, member_id) VALUES(?,?,?)").run(cid, type, mid);
    this.bus.emitEvent({ type: "chat", chat: this.chat(cid) });
  }
  removeMember(cid: string, type: "user" | "agent", mid: string): void {
    this.db.prepare("DELETE FROM chat_members WHERE chat_id = ? AND member_type = ? AND member_id = ?").run(cid, type, mid);
    this.bus.emitEvent({ type: "chat", chat: this.chat(cid) });
  }
  chatAgents(cid: string): Agent[] {
    return (
      this.db
        .prepare("SELECT a.* FROM agents a JOIN chat_members m ON m.member_id = a.id AND m.member_type = 'agent' WHERE m.chat_id = ? AND a.archived = 0")
        .all(cid) as any[]
    ).map(rowToAgent);
  }
  /** The chats a user can see. Agent-only chats are readable by everyone in the workspace (transparency). */
  chatsForUser(uid: string): any[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM chats c WHERE c.kind = 'agents' OR EXISTS (SELECT 1 FROM chat_members m WHERE m.chat_id = c.id AND m.member_type = 'user' AND m.member_id = ?)
       ORDER BY COALESCE((SELECT MAX(ts) FROM messages WHERE chat_id = c.id), c.created_at) DESC`,
      )
      .all(uid) as any[];
    return rows.map((c) => {
      const last = this.db.prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY ts DESC LIMIT 1").get(c.id) as any;
      const mem = this.db.prepare("SELECT ts AS last_read_ts FROM chat_reads WHERE chat_id = ? AND user_id = ?").get(c.id, uid) as any;
      const unread = (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND ts > ? AND NOT (author_type = 'user' AND author_id = ?)")
          .get(c.id, mem?.last_read_ts ?? 0, uid) as any
      ).n;
      return { ...this.chat(c.id), last: last ? rowToMessage(last) : null, unread };
    });
  }
  /** Find or create the 1:1 chat between a user and an agent. */
  dmWith(uid: string, agentId: string): string {
    const r = this.db
      .prepare(
        `SELECT c.id FROM chats c WHERE c.kind = 'dm'
       AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id = c.id AND member_type='user' AND member_id = ?)
       AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id = c.id AND member_type='agent' AND member_id = ?)`,
      )
      .get(uid, agentId) as any;
    if (r) return r.id;
    const a = this.agent(agentId)!;
    return this.createChat("dm", a.name, uid, [
      { type: "user", id: uid },
      { type: "agent", id: agentId },
    ]);
  }
  /** The visible chat where two agents talk to each other. */
  agentsChat(a: string, b: string): string {
    const r = this.db
      .prepare(
        `SELECT c.id FROM chats c WHERE c.kind = 'agents'
       AND (SELECT COUNT(*) FROM chat_members WHERE chat_id = c.id) = 2
       AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id = c.id AND member_type='agent' AND member_id = ?)
       AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id = c.id AND member_type='agent' AND member_id = ?)`,
      )
      .get(a, b) as any;
    if (r) return r.id;
    const A = this.agent(a)!,
      B = this.agent(b)!;
    return this.createChat("agents", `${A.name} and ${B.name}`, "", [
      { type: "agent", id: a },
      { type: "agent", id: b },
    ]);
  }
  markRead(cid: string, uid: string): void {
    this.db.prepare("INSERT INTO chat_reads(chat_id, user_id, ts) VALUES(?,?,?) ON CONFLICT DO UPDATE SET ts = excluded.ts").run(cid, uid, now());
  }

  // ---------------------------------------------------------------- messages
  messages(cid: string, before?: number, limit = 100): Message[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE chat_id = ? AND ts < ? ORDER BY ts DESC LIMIT ?")
      .all(cid, before ?? Number.MAX_SAFE_INTEGER, limit) as any[];
    return rows.reverse().map(rowToMessage);
  }
  message(mid: string): Message | undefined {
    const r = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(mid);
    return r ? rowToMessage(r) : undefined;
  }
  insertMessage(m: Omit<Message, "id" | "ts"> & { ts?: number }): Message {
    const msg: Message = { id: id("m_"), ts: m.ts ?? now(), ...m } as Message;
    // keep timestamps strictly increasing per chat so ordering is stable
    const last = this.db.prepare("SELECT MAX(ts) AS t FROM messages WHERE chat_id = ?").get(msg.chatId) as any;
    if (last?.t && msg.ts <= last.t) msg.ts = last.t + 1;
    this.db
      .prepare("INSERT INTO messages(id, chat_id, author_type, author_id, kind, body, meta, ts) VALUES(?,?,?,?,?,?,?,?)")
      .run(msg.id, msg.chatId, msg.authorType, msg.authorId, msg.kind, msg.body, JSON.stringify(msg.meta ?? {}), msg.ts);
    this.bus.emitEvent({ type: "message", chatId: msg.chatId, message: msg });
    return msg;
  }
  updateMessageMeta(mid: string, patch: Record<string, any>): void {
    const m = this.message(mid);
    if (!m) return;
    const meta = { ...m.meta, ...patch };
    this.db.prepare("UPDATE messages SET meta = ? WHERE id = ?").run(JSON.stringify(meta), mid);
    this.bus.emitEvent({ type: "message_updated", chatId: m.chatId, message: { ...m, meta } });
  }

  /**
   * Post a message and route it. Rules (no idle chatter, ever):
   *  - in a DM with an agent, every human message goes to that agent
   *  - in a group, only @mentioned agents get it
   *  - an agent @mentioning another agent is a hand-off: hop + 1, capped at MAX_HOPS per goal
   */
  post(input: {
    chatId: string;
    authorType: "user" | "agent" | "system";
    authorId: string;
    body: string;
    kind?: Message["kind"];
    meta?: Record<string, any>;
    hop?: number;
    goalId?: string;
  }): Message {
    const msg = this.insertMessage({
      chatId: input.chatId,
      authorType: input.authorType,
      authorId: input.authorId,
      kind: input.kind ?? "text",
      body: input.body,
      meta: input.meta ?? {},
    });
    if (input.authorType === "system" || (input.kind && input.kind !== "text")) return msg;
    const chat = this.chat(input.chatId);
    if (!chat) return msg;
    const agentsHere = this.chatAgents(input.chatId);
    const targets = new Set<string>();
    if (chat.kind === "dm" && input.authorType === "user") for (const a of agentsHere) targets.add(a.id);
    // a group with just one agent: that agent answers every message from a person, no @ needed
    if (chat.kind === "group" && input.authorType === "user" && agentsHere.length === 1) targets.add(agentsHere[0].id);
    const named = mentions(input.body);
    // @all (or @everyone, @agents, @here) from a person: every agent in the chat answers.
    // Agents can't use it, so they can't start a pile-on.
    if (input.authorType === "user" && chat.kind !== "dm" && named.some((h) => MENTION_ALL.has(h))) for (const a of agentsHere) targets.add(a.id);
    for (const h of named) {
      const a = agentsHere.find((x) => x.handle === h);
      if (a && !(input.authorType === "agent" && a.id === input.authorId)) targets.add(a.id);
    }
    // A group with several agents and no @: the agent that spoke last carries on the conversation.
    if (!targets.size && chat.kind === "group" && input.authorType === "user" && agentsHere.length > 1) {
      const last = this.db
        .prepare("SELECT author_id FROM messages WHERE chat_id = ? AND author_type = 'agent' AND kind = 'text' AND id != ? ORDER BY ts DESC LIMIT 1")
        .get(input.chatId, msg.id) as any;
      const a = last && agentsHere.find((x) => x.id === last.author_id);
      if (a) targets.add(a.id);
    }
    const hop = input.authorType === "agent" ? (input.hop ?? 0) + 1 : 0;
    const goalId = input.goalId || (input.authorType === "user" ? msg.id : "");
    for (const t of targets)
      this.deliver({
        agentId: t,
        chatId: input.chatId,
        fromType: input.authorType,
        fromId: input.authorId,
        text: input.body,
        hop,
        goalId: goalId || msg.id,
        sourceMessageId: msg.id,
      });
    return msg;
  }

  deliver(d: {
    agentId: string;
    chatId: string;
    fromType: Delivery["fromType"];
    fromId: string;
    text: string;
    hop: number;
    goalId: string;
    idem?: string;
    sourceMessageId?: string;
  }): Delivery | null {
    if (d.hop > MAX_HOPS) {
      const guardian = this.agents().find((a) => a.roleTitle.toLowerCase() === "guardian");
      this.insertMessage({
        chatId: d.chatId,
        authorType: guardian ? "agent" : "system",
        authorId: guardian?.id ?? "",
        kind: "system",
        body: `Stopped a hand-off chain after ${MAX_HOPS} hops. Someone needs to decide what happens next.`,
        meta: { reason: "hop_limit", goalId: d.goalId },
      });
      return null;
    }
    const did = id("d_");
    try {
      this.db
        .prepare(
          "INSERT INTO deliveries(id, agent_id, chat_id, from_type, from_id, text, hop, goal_id, state, idem, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?, 'queued', ?, ?, ?)",
        )
        .run(did, d.agentId, d.chatId, d.fromType, d.fromId, d.text, d.hop, d.goalId, d.idem ?? null, now(), now());
    } catch (e) {
      if (String((e as Error).message).includes("UNIQUE")) return null; // idempotent re-delivery
      throw e;
    }
    const delivery = this.delivery(did)!;
    this.bus.emitEvent({ type: "delivery", delivery });
    for (const fn of this.deliveryListeners) fn(delivery);
    return delivery;
  }
  delivery(did: string): Delivery | undefined {
    const r = this.db.prepare("SELECT * FROM deliveries WHERE id = ?").get(did);
    return r ? rowToDelivery(r) : undefined;
  }
  setDeliveryState(did: string, state: Delivery["state"], error = ""): void {
    this.db.prepare("UPDATE deliveries SET state = ?, error = ?, updated_at = ? WHERE id = ?").run(state, error, now(), did);
    const d = this.delivery(did);
    if (d) this.bus.emitEvent({ type: "delivery", delivery: d });
  }
  queued(agentId: string): Delivery[] {
    return (this.db.prepare("SELECT * FROM deliveries WHERE agent_id = ? AND state = 'queued' ORDER BY created_at").all(agentId) as any[]).map(rowToDelivery);
  }

  // ---------------------------------------------------------------- approvals
  createApproval(a: { agentId: string; chatId: string; source: "acp" | "gateway"; title: string; detail: any; options: any[]; ttlMs?: number }): any {
    const aid = id("ap_");
    const ttl = a.ttlMs ?? Number(getSetting(this.db, "approval_ttl_ms") ?? 24 * 3600 * 1000);
    this.db
      .prepare(
        "INSERT INTO approvals(id, agent_id, chat_id, source, title, detail, options, state, created_at, expires_at) VALUES(?,?,?,?,?,?,?, 'pending', ?, ?)",
      )
      .run(aid, a.agentId, a.chatId, a.source, a.title, JSON.stringify(a.detail ?? {}), JSON.stringify(a.options ?? []), now(), now() + ttl);
    const ap = this.approval(aid);
    this.bus.emitEvent({ type: "approval", approval: ap });
    return ap;
  }
  approval(aid: string): any {
    const r = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(aid) as any;
    if (!r) return undefined;
    return {
      id: r.id,
      agentId: r.agent_id,
      chatId: r.chat_id,
      source: r.source,
      title: r.title,
      detail: json(r.detail, {}),
      options: json(r.options, []),
      state: r.state,
      decision: r.decision,
      decidedBy: r.decided_by,
      reason: r.reason,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    };
  }
  approvals(state?: string): any[] {
    const rows = state
      ? this.db.prepare("SELECT id FROM approvals WHERE state = ? ORDER BY created_at DESC").all(state)
      : this.db.prepare("SELECT id FROM approvals ORDER BY created_at DESC LIMIT 200").all();
    return (rows as any[]).map((r) => this.approval(r.id));
  }
  decideApproval(aid: string, state: "approved" | "denied" | "expired" | "cancelled", decision: string, by: string, reason = ""): any {
    const res = this.db
      .prepare("UPDATE approvals SET state = ?, decision = ?, decided_by = ?, reason = ? WHERE id = ? AND state = 'pending'")
      .run(state, decision, by, reason, aid);
    const ap = this.approval(aid);
    if (res.changes) this.bus.emitEvent({ type: "approval", approval: ap });
    return ap;
  }

  // ---------------------------------------------------------------- memory
  memoryPaused(): boolean {
    return getSetting(this.db, "memory_paused") === "1";
  }
  remember(m: { scope: "team" | "chat" | "agent"; scopeId: string; text: string; source: string; byType: "user" | "agent"; byId: string }): any {
    if (this.memoryPaused()) throw new Error("Memory is paused by an admin");
    if (looksSecret(m.text)) throw new Error("That looks like a password or key. It was not saved. Use the vault instead.");
    const mid = id("mem_");
    this.db
      .prepare("INSERT INTO memories(id, scope, scope_id, text, source, by_type, by_id, created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(mid, m.scope, m.scopeId, m.text.slice(0, 2000), m.source, m.byType, m.byId, now());
    const mem = this.memory(mid);
    this.bus.emitEvent({ type: "memory", memory: mem });
    return mem;
  }
  memory(mid: string): any {
    const r = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(mid) as any;
    return (
      r && {
        id: r.id,
        scope: r.scope,
        scopeId: r.scope_id,
        text: r.text,
        source: r.source,
        byType: r.by_type,
        byId: r.by_id,
        createdAt: r.created_at,
        forgottenAt: r.forgotten_at,
        forgottenBy: r.forgotten_by,
      }
    );
  }
  /** What an agent may see while working in a chat: team + that chat + its own notes. */
  memoriesFor(agentId: string, chatId: string, includeForgotten = false): any[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM memories WHERE (scope = 'team' OR (scope = 'chat' AND scope_id = ?) OR (scope = 'agent' AND scope_id = ?)) ${includeForgotten ? "" : "AND forgotten_at IS NULL"} ORDER BY created_at DESC LIMIT 200`,
      )
      .all(chatId, agentId) as any[];
    return rows.map((r) => this.memory(r.id));
  }
  forget(mid: string, by: string): void {
    this.db.prepare("UPDATE memories SET forgotten_at = ?, forgotten_by = ? WHERE id = ?").run(now(), by, mid);
    this.bus.emitEvent({ type: "memory", memory: this.memory(mid) });
  }
  restore(mid: string): void {
    this.db.prepare("UPDATE memories SET forgotten_at = NULL, forgotten_by = NULL WHERE id = ?").run(mid);
    this.bus.emitEvent({ type: "memory", memory: this.memory(mid) });
  }

  // ---------------------------------------------------------------- tasks
  createTask(t: { chatId: string; title: string; assigneeType?: string; assigneeId?: string; status?: string; planId?: string; createdBy: string }): any {
    const tid = id("t_");
    this.db
      .prepare(
        "INSERT INTO tasks(id, chat_id, title, assignee_type, assignee_id, status, plan_id, created_by, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(tid, t.chatId, t.title.slice(0, 500), t.assigneeType ?? "", t.assigneeId ?? "", t.status ?? "todo", t.planId ?? "", t.createdBy, now(), now());
    const task = this.task(tid);
    this.bus.emitEvent({ type: "task", chatId: t.chatId, task });
    return task;
  }
  task(tid: string): any {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(tid) as any;
    return (
      r && {
        id: r.id,
        chatId: r.chat_id,
        title: r.title,
        assigneeType: r.assignee_type,
        assigneeId: r.assignee_id,
        status: r.status,
        planId: r.plan_id,
        createdBy: r.created_by,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }
    );
  }
  tasks(chatId?: string): any[] {
    const rows = chatId
      ? this.db.prepare("SELECT id FROM tasks WHERE chat_id = ? ORDER BY created_at").all(chatId)
      : this.db.prepare("SELECT id FROM tasks ORDER BY created_at").all();
    return (rows as any[]).map((r) => this.task(r.id));
  }
  updateTask(tid: string, patch: { status?: string; title?: string; assigneeType?: string; assigneeId?: string }): any {
    const t = this.task(tid);
    if (!t) throw new Error("no such task");
    this.db
      .prepare("UPDATE tasks SET status = ?, title = ?, assignee_type = ?, assignee_id = ?, updated_at = ? WHERE id = ?")
      .run(patch.status ?? t.status, patch.title ?? t.title, patch.assigneeType ?? t.assigneeType, patch.assigneeId ?? t.assigneeId, now(), tid);
    const task = this.task(tid);
    this.bus.emitEvent({ type: "task", chatId: task.chatId, task });
    if (t.planId) this.refreshPlanCard(t.planId);
    return task;
  }
  /** Plan cards in chat mirror their tasks. */
  refreshPlanCard(planId: string): void {
    const msg = this.db.prepare("SELECT id FROM messages WHERE kind = 'plan' AND json_extract(meta, '$.planId') = ?").get(planId) as any;
    if (!msg) return;
    const steps = (this.db.prepare("SELECT id FROM tasks WHERE plan_id = ? ORDER BY created_at").all(planId) as any[]).map((r) => this.task(r.id));
    this.updateMessageMeta(msg.id, { steps });
  }

  // ---------------------------------------------------------------- usage + budgets
  addUsage(agentId: string, tokens: number, costMicros: number): void {
    const day = new Date().toISOString().slice(0, 10);
    this.db
      .prepare(
        "INSERT INTO usage(agent_id, day, tokens, cost_micros) VALUES(?,?,?,?) ON CONFLICT(agent_id, day) DO UPDATE SET tokens = tokens + excluded.tokens, cost_micros = cost_micros + excluded.cost_micros",
      )
      .run(agentId, day, tokens, costMicros);
  }
  monthCostMicros(agentId?: string): number {
    const month = new Date().toISOString().slice(0, 7);
    const r = agentId
      ? (this.db.prepare("SELECT COALESCE(SUM(cost_micros),0) AS c FROM usage WHERE agent_id = ? AND day LIKE ?").get(agentId, month + "%") as any)
      : (this.db.prepare("SELECT COALESCE(SUM(cost_micros),0) AS c FROM usage WHERE day LIKE ?").get(month + "%") as any);
    return r.c;
  }
  overBudget(agentId: string): boolean {
    const a = this.agent(agentId);
    const workspaceCap = Number(getSetting(this.db, "monthly_limit_cents") ?? 0);
    if (workspaceCap > 0 && this.monthCostMicros() >= workspaceCap * 10_000) return true;
    return !!a && a.budgetCents > 0 && this.monthCostMicros(agentId) >= a.budgetCents * 10_000;
  }
}

/** Mentions that reach every agent in a chat. Agents can't take these as handles. */
export const MENTION_ALL = new Set(["all", "everyone", "agents", "here"]);

export function mentions(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(^|[^\w@])@([a-z][a-z0-9_-]{1,30})/gi)) out.add(m[2].toLowerCase());
  return [...out];
}

export function looksSecret(text: string): boolean {
  return /(gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abpr]-|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bpassword\s*[:=]\s*\S{4,})/i.test(
    text,
  );
}
