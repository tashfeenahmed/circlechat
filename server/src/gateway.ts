// SPDX-License-Identifier: AGPL-3.0-only
// The tool gateway. Every agent gets one MCP endpoint (/mcp/<token>) and reaches
// every tool through it: chat tools, connected apps (GitHub, any HTTP API) and
// proxied MCP servers. The gateway checks grants (who may use what), applies
// Allow / Ask / Block policies, turns "Ask" into an approval card, injects
// credentials from the vault (agents never see keys) and logs every call.
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { DB } from "./db.ts";
import { json, now } from "./db.ts";
import { id, token, Vault } from "./crypto.ts";
import { appendToolCall } from "./toollog.ts";
import { connectionHeaders, formEncode } from "./apps.ts";
import type { Services, Agent } from "./services.ts";

export type Decision = "allow" | "ask" | "block" | "off";
type Category = "core" | "read" | "write" | "danger";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: any;
  category: Category;
  resource?: { type: "connection" | "mcp"; id: string; name: string; identity: string };
  run(args: any, ctx: CallContext): Promise<string>;
}

export interface CallContext {
  agent: Agent;
  chatId: string;
  /** who asked for the current turn: a user id, an agent id, or a trigger */
  requester: { type: string; id: string };
}

interface TokenInfo {
  agentId: string;
  chatId: string;
  requester: { type: string; id: string };
  /** agent-wide token: chat + requester come from the agent's current turn */
  dynamic?: boolean;
}

const S = (props: Record<string, any>, required: string[] = []) => ({ type: "object", properties: props, required, additionalProperties: false });
const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });

export class Gateway {
  private tokens = new Map<string, TokenInfo>();
  private mcpClients = new Map<string, Client>();
  private waiters = new Map<string, (ap: any) => void>();
  publicUrl = "http://127.0.0.1:0"; // set by the http server once it listens
  agentReachableUrl = ""; // url agents in docker use (host.docker.internal)

  private db: DB;

  private svc: Services;

  private vault: Vault;

  private opts: { approvalTimeoutMs?: number };

  constructor(db: DB, svc: Services, vault: Vault, opts: { approvalTimeoutMs?: number } = {}) {
    this.db = db;

    this.svc = svc;

    this.vault = vault;

    this.opts = opts;
    // resolve waiters when an approval is decided anywhere (UI, API, expiry)
    svc.bus.onEvent((e) => {
      if (e.type !== "approval") return;
      const ap: any = e.approval;
      if (ap.state !== "pending") {
        this.waiters.get(ap.id)?.(ap);
        this.waiters.delete(ap.id);
      }
    });
  }

  /** set by the runtime: what the agent is working on right now */
  /** set by the runtime: show that an agent is waiting on a person */
  onWaiting: (agentId: string, waiting: boolean, detail: string) => void = () => {};
  resolveContext: (agentId: string) => { chatId: string; requester: { type: string; id: string } } | undefined = () => undefined;

  // ------------------------------------------------------------ tokens
  issueAgentToken(agentId: string): string {
    const t = token(24);
    this.tokens.set(t, { agentId, chatId: "", requester: { type: "system", id: "" }, dynamic: true });
    return t;
  }
  agentMcpUrl(t: string, docker: boolean): string {
    const base = docker && this.agentReachableUrl ? this.agentReachableUrl : this.publicUrl;
    return `${base}/mcp/${t}`;
  }
  issueToken(agentId: string, chatId: string, requester: { type: string; id: string }): string {
    const t = token(24);
    this.tokens.set(t, { agentId, chatId, requester });
    return t;
  }
  updateRequester(t: string, requester: { type: string; id: string }): void {
    const info = this.tokens.get(t);
    if (info) info.requester = requester;
  }
  revoke(t: string): void {
    this.tokens.delete(t);
  }
  mcpServerEntry(t: string, docker: boolean): any {
    const base = docker && this.agentReachableUrl ? this.agentReachableUrl : this.publicUrl;
    return { type: "http", name: "circlechat", url: `${base}/mcp/${t}`, headers: [] };
  }

  // ------------------------------------------------------------ secrets
  putSecret(name: string, value: string): string {
    const sid = id("sec_");
    const box = this.vault.seal(value);
    this.db.prepare("INSERT INTO secrets(id, name, iv, tag, data, created_at) VALUES(?,?,?,?,?,?)").run(sid, name, box.iv, box.tag, box.data, now());
    return sid;
  }
  getSecret(sid: string): string {
    const r = this.db.prepare("SELECT * FROM secrets WHERE id = ?").get(sid) as any;
    if (!r) throw new Error("secret not found");
    return this.vault.open(r);
  }
  deleteSecret(sid: string): void {
    this.db.prepare("DELETE FROM secrets WHERE id = ?").run(sid);
  }

  // ------------------------------------------------------------ grants + policies
  /** A resource is usable only where it was explicitly granted. New = off everywhere. */
  granted(type: "connection" | "mcp", rid: string, agentId: string, chatId: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM grants WHERE resource_type = ? AND resource_id = ? AND (target_type = 'workspace' OR (target_type = 'chat' AND target_id = ?) OR (target_type = 'agent' AND target_id = ?))`,
      )
      .get(type, rid, chatId, agentId);
  }
  setGrants(type: "connection" | "mcp", rid: string, targets: { type: "workspace" | "chat" | "agent"; id?: string }[]): void {
    this.db.prepare("DELETE FROM grants WHERE resource_type = ? AND resource_id = ?").run(type, rid);
    const ins = this.db.prepare("INSERT OR IGNORE INTO grants(resource_type, resource_id, target_type, target_id) VALUES(?,?,?,?)");
    for (const t of targets) ins.run(type, rid, t.type, t.id ?? "");
  }
  grants(type: string, rid: string): any[] {
    return this.db.prepare("SELECT target_type AS type, target_id AS id FROM grants WHERE resource_type = ? AND resource_id = ?").all(type, rid);
  }
  setPolicy(type: string, rid: string, tool: string, decision: Decision): void {
    this.db
      .prepare("INSERT INTO policies(resource_type, resource_id, tool, decision) VALUES(?,?,?,?) ON CONFLICT DO UPDATE SET decision = excluded.decision")
      .run(type, rid, tool, decision);
  }
  policies(type: string, rid: string): Record<string, Decision> {
    const out: Record<string, Decision> = {};
    for (const r of this.db.prepare("SELECT tool, decision FROM policies WHERE resource_type = ? AND resource_id = ?").all(type, rid) as any[])
      out[r.tool] = r.decision;
    return out;
  }
  decide(t: ToolDef, chatId: string): Decision {
    if (t.category === "core" || !t.resource) return "allow";
    const p = this.db
      .prepare("SELECT tool, decision FROM policies WHERE resource_type = ? AND resource_id = ? AND tool IN (?, ?)")
      .all(t.resource.type, t.resource.id, t.name, `${t.name}@chat:${chatId}`) as any[];
    const chatScoped = p.find((r) => r.tool.includes("@chat:"));
    if (chatScoped) return chatScoped.decision;
    if (p[0]) return p[0].decision;
    if (t.resource.type === "mcp") return "off"; // MCP tools stay off until reviewed
    return t.category === "read" ? "allow" : t.category === "write" ? "ask" : "block";
  }

  // ------------------------------------------------------------ tool catalogue
  async toolsFor(ctx: CallContext): Promise<ToolDef[]> {
    const tools: ToolDef[] = [...this.coreTools()];
    const conns = this.db.prepare("SELECT * FROM connections WHERE status != 'disabled'").all() as any[];
    for (const c of conns) {
      if (!this.granted("connection", c.id, ctx.agent.id, ctx.chatId)) continue;
      // personal connections act "as you": only usable on that person's own requests
      if (c.identity === "user" && !(ctx.requester.type === "user" && ctx.requester.id === c.owner_user_id)) continue;
      tools.push(...connectionTools(c, this));
    }
    const servers = this.db.prepare("SELECT * FROM mcp_servers WHERE status = 'ok'").all() as any[];
    for (const s of servers) {
      if (!this.granted("mcp", s.id, ctx.agent.id, ctx.chatId)) continue;
      for (const t of json<any[]>(s.tools, [])) {
        const name = `${s.name}__${t.name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
        tools.push({
          name,
          description: t.description ?? "",
          inputSchema: t.inputSchema ?? S({}),
          category: "write",
          resource: { type: "mcp", id: s.id, name: s.name, identity: "agent" },
          run: async (args) => this.callMcp(s, t.name, args),
        });
      }
    }
    return tools.filter((t) => this.decide(t, ctx.chatId) !== "off");
  }

  private coreTools(): ToolDef[] {
    const svc = this.svc;
    return [
      {
        name: "chat_history",
        category: "core",
        description: "Read recent messages in this chat (newest last).",
        inputSchema: S({ limit: num("how many, max 100") }),
        run: async (a, ctx) =>
          svc
            .messages(ctx.chatId, undefined, Math.min(Number(a.limit) || 30, 100))
            .map((m) => `[${new Date(m.ts).toISOString()}] ${this.authorName(m.authorType, m.authorId)}: ${m.body}`)
            .join("\n") || "(no messages)",
      },
      {
        name: "chat_post",
        category: "core",
        description: "Post a short progress update in this chat now (your final answer is posted automatically).",
        inputSchema: S({ text: str("message") }, ["text"]),
        run: async (a, ctx) => {
          svc.insertMessage({
            chatId: ctx.chatId,
            authorType: "agent",
            authorId: ctx.agent.id,
            kind: "text",
            body: String(a.text).slice(0, 8000),
            meta: { interim: true },
          });
          return "posted";
        },
      },
      {
        name: "list_agents",
        category: "core",
        description: "List the agents in this chat and what they do.",
        inputSchema: S({}),
        run: async (_a, ctx) =>
          svc
            .chatAgents(ctx.chatId)
            .map((x) => `@${x.handle}: ${x.name}, ${x.roleTitle}`)
            .join("\n"),
      },
      {
        name: "handoff",
        category: "core",
        description: "Hand a piece of work to another agent. They get your message in their own session and reply in the visible agents chat.",
        inputSchema: S({ agent: str("handle of the agent, e.g. pip"), message: str("what you need, with context") }, ["agent", "message"]),
        run: async (a, ctx) => {
          const target = svc.agent(String(a.agent).replace(/^@/, ""));
          if (!target) return `No agent called @${a.agent}`;
          if (target.id === ctx.agent.id) return "You can't hand off to yourself.";
          const hop = this.currentHop(ctx) + 1;
          const backChat = svc.agentsChat(ctx.agent.id, target.id);
          svc.insertMessage({
            chatId: ctx.chatId,
            authorType: "system",
            authorId: "",
            kind: "handoff",
            body: `${ctx.agent.name} asked ${target.name}: ${a.message}`,
            meta: { from: ctx.agent.id, to: target.id, hop, agentsChat: backChat },
          });
          svc.insertMessage({
            chatId: backChat,
            authorType: "agent",
            authorId: ctx.agent.id,
            kind: "text",
            body: String(a.message),
            meta: { handoff: true, originChat: ctx.chatId },
          });
          const d = svc.deliver({
            agentId: target.id,
            chatId: backChat,
            fromType: "agent",
            fromId: ctx.agent.id,
            text: String(a.message),
            hop,
            goalId: this.currentGoal(ctx),
          });
          return d
            ? `Handed to @${target.handle} (hop ${hop} of 5). Their reply will appear in the agents chat.`
            : "Hand-off limit reached. A person needs to decide what happens next.";
        },
      },
      {
        name: "remember",
        category: "core",
        description: "Save a fact for later. scope: team (everyone), chat (this chat only) or agent (only you).",
        inputSchema: S({ text: str("the fact, one sentence"), scope: { type: "string", enum: ["team", "chat", "agent"] } }, ["text"]),
        run: async (a, ctx) => {
          const scope = (a.scope ?? "chat") as "team" | "chat" | "agent";
          const m = svc.remember({
            scope,
            scopeId: scope === "chat" ? ctx.chatId : scope === "agent" ? ctx.agent.id : "",
            text: String(a.text),
            source: `${ctx.agent.name} in chat`,
            byType: "agent",
            byId: ctx.agent.id,
          });
          svc.insertMessage({
            chatId: ctx.chatId,
            authorType: "system",
            authorId: "",
            kind: "memory",
            body: m.text,
            meta: { memoryId: m.id, scope, by: ctx.agent.id },
          });
          return `Saved to ${scope} memory.`;
        },
      },
      {
        name: "recall",
        category: "core",
        description: "Look up what the team, this chat and you remember.",
        inputSchema: S({ query: str("optional words to search for") }),
        run: async (a, ctx) => {
          const q = String(a.query ?? "").toLowerCase();
          const all = svc.memoriesFor(ctx.agent.id, ctx.chatId).filter((m) => !q || m.text.toLowerCase().includes(q));
          return all.map((m) => `- (${m.scope}) ${m.text}`).join("\n") || "(nothing remembered)";
        },
      },
      {
        name: "propose_plan",
        category: "core",
        description: "Post a plan as a checklist in this chat. Each step becomes a task. Use before multi-step work.",
        inputSchema: S(
          { title: str("plan title"), steps: { type: "array", items: S({ title: str("step"), assignee: str("agent handle or empty") }, ["title"]) } },
          ["title", "steps"],
        ),
        run: async (a, ctx) => {
          const planId = id("plan_");
          const steps = (a.steps ?? []).slice(0, 20).map((s: any) => {
            const ag = s.assignee ? svc.agent(String(s.assignee).replace(/^@/, "")) : undefined;
            return svc.createTask({
              chatId: ctx.chatId,
              title: String(s.title),
              assigneeType: ag ? "agent" : "",
              assigneeId: ag?.id ?? "",
              planId,
              createdBy: ctx.agent.id,
            });
          });
          svc.insertMessage({ chatId: ctx.chatId, authorType: "agent", authorId: ctx.agent.id, kind: "plan", body: String(a.title), meta: { planId, steps } });
          return `Plan posted with ${steps.length} steps. Task ids: ${steps.map((s: any) => s.id).join(", ")}`;
        },
      },
      {
        name: "task_update",
        category: "core",
        description: "Update a task: status todo | working | needs_you | checking | done.",
        inputSchema: S({ id: str("task id"), status: { type: "string", enum: ["todo", "working", "needs_you", "checking", "done"] } }, ["id", "status"]),
        run: async (a) => {
          const t = svc.updateTask(String(a.id), { status: String(a.status) });
          return `Task "${t.title}" is now ${t.status}.`;
        },
      },
      {
        name: "task_create",
        category: "core",
        description: "Add a task to this chat's list.",
        inputSchema: S({ title: str("task"), assignee: str("agent handle, optional") }, ["title"]),
        run: async (a, ctx) => {
          const ag = a.assignee ? svc.agent(String(a.assignee).replace(/^@/, "")) : undefined;
          const t = svc.createTask({
            chatId: ctx.chatId,
            title: String(a.title),
            assigneeType: ag ? "agent" : "",
            assigneeId: ag?.id ?? "",
            createdBy: ctx.agent.id,
          });
          return `Task ${t.id} created.`;
        },
      },
    ];
  }

  private currentHop(ctx: CallContext): number {
    const r = this.db.prepare("SELECT hop FROM deliveries WHERE agent_id = ? AND state = 'injected' ORDER BY updated_at DESC LIMIT 1").get(ctx.agent.id) as any;
    return r?.hop ?? 0;
  }
  private currentGoal(ctx: CallContext): string {
    const r = this.db
      .prepare("SELECT goal_id FROM deliveries WHERE agent_id = ? AND state = 'injected' ORDER BY updated_at DESC LIMIT 1")
      .get(ctx.agent.id) as any;
    return r?.goal_id || id("goal_");
  }
  authorName(type: string, aid: string): string {
    if (type === "system") return "CircleChat";
    if (type === "agent") return this.svc.agent(aid)?.name ?? "agent";
    const u = this.db.prepare("SELECT name FROM users WHERE id = ?").get(aid) as any;
    return u?.name ?? "someone";
  }

  // ------------------------------------------------------------ calling a tool
  async call(name: string, args: any, ctx: CallContext): Promise<{ text: string; isError: boolean }> {
    const tools = await this.toolsFor(ctx);
    const t = tools.find((x) => x.name === name);
    if (!t) {
      appendToolCall(this.db, { agentId: ctx.agent.id, chatId: ctx.chatId, tool: name, args, status: "blocked", approval: "not available here" });
      return { text: `Tool ${name} is not available to you in this chat.`, isError: true };
    }
    const identity = t.resource ? (t.resource.identity === "user" ? "as the person who asked" : `${t.resource.name} (agent identity)`) : "";
    let decision = this.decide(t, ctx.chatId);
    let approvalNote = decision === "allow" ? (t.category === "core" ? "" : "allowed by rule") : "";
    if (decision === "block") {
      appendToolCall(this.db, {
        agentId: ctx.agent.id,
        chatId: ctx.chatId,
        tool: name,
        args,
        asIdentity: identity,
        approval: "blocked by rule",
        status: "blocked",
      });
      return { text: `Blocked: the workspace rules don't allow ${name}. Ask a person to do it, or ask an admin to change the rule.`, isError: true };
    }
    if (decision === "ask") {
      const ap = await this.askApproval(t, args, ctx, identity);
      if (ap.state !== "approved") {
        appendToolCall(this.db, {
          agentId: ctx.agent.id,
          chatId: ctx.chatId,
          tool: name,
          args,
          asIdentity: identity,
          approval: ap.state === "expired" ? "no answer, timed out" : `denied${ap.reason ? ": " + ap.reason : ""}`,
          status: "denied",
        });
        return {
          text:
            ap.state === "expired"
              ? `No one approved ${name} in time, so it was not done.`
              : `A person said no to ${name}${ap.reason ? `: ${ap.reason}` : "."}`,
          isError: true,
        };
      }
      approvalNote = `${this.authorName("user", ap.decidedBy)} approved`;
      if (ap.decision === "allow_always" && t.resource) this.setPolicy(t.resource.type, t.resource.id, `${t.name}@chat:${ctx.chatId}`, "allow");
    }
    try {
      const text = await t.run(args ?? {}, ctx);
      appendToolCall(this.db, {
        agentId: ctx.agent.id,
        chatId: ctx.chatId,
        tool: name,
        args,
        asIdentity: identity,
        approval: approvalNote,
        status: "ok",
        result: text.slice(0, 500),
      });
      return { text, isError: false };
    } catch (e) {
      const msg = (e as Error).message;
      appendToolCall(this.db, {
        agentId: ctx.agent.id,
        chatId: ctx.chatId,
        tool: name,
        args,
        asIdentity: identity,
        approval: approvalNote,
        status: "error",
        result: msg,
      });
      return { text: `Error: ${msg}`, isError: true };
    }
  }

  private askApproval(t: ToolDef, args: any, ctx: CallContext, identity: string): Promise<any> {
    const ap = this.svc.createApproval({
      agentId: ctx.agent.id,
      chatId: ctx.chatId,
      source: "gateway",
      title: `${ctx.agent.name} wants to use ${t.name}`,
      detail: { tool: t.name, args, identity, resource: t.resource?.name ?? "", category: t.category, requester: ctx.requester },
      options: [
        { id: "allow_once", label: "Approve once" },
        { id: "allow_always", label: "Always in this chat" },
        { id: "deny", label: "Deny" },
      ],
      ttlMs: this.opts.approvalTimeoutMs,
    });
    this.svc.insertMessage({ chatId: ctx.chatId, authorType: "system", authorId: "", kind: "approval", body: ap.title, meta: { approvalId: ap.id } });
    this.onWaiting(ctx.agent.id, true, t.name);
    return new Promise((resolve) => {
      this.waiters.set(ap.id, (v: any) => {
        this.onWaiting(ctx.agent.id, false, t.name);
        resolve(v);
      });
      const ms = Math.max(0, ap.expiresAt - Date.now());
      setTimeout(() => {
        if (this.waiters.has(ap.id)) resolve(this.svc.decideApproval(ap.id, "expired", "", "system"));
      }, ms).unref();
    });
  }

  // ------------------------------------------------------------ MCP servers we proxy
  private async mcpClient(s: any): Promise<Client> {
    const cached = this.mcpClients.get(s.id);
    if (cached) return cached;
    const env: Record<string, string> = {};
    for (const [k, sid] of Object.entries(json<Record<string, string>>(s.env_secrets, {}))) env[k] = this.getSecret(sid);
    const client = new Client({ name: "circlechat-gateway", version: "2.0.0" });
    if (s.transport === "stdio") {
      const transport = new StdioClientTransport({
        command: s.command,
        args: json<string[]>(s.args, []),
        env: { PATH: process.env.PATH ?? "", ...env },
        stderr: "ignore",
      });
      await client.connect(transport);
    } else {
      const headers: Record<string, string> = {};
      if (env.AUTHORIZATION) headers.Authorization = env.AUTHORIZATION;
      await client.connect(new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers } }));
    }
    this.mcpClients.set(s.id, client);
    return client;
  }
  async closeAll(): Promise<void> {
    await Promise.all([...this.mcpClients.keys()].map((k) => this.closeMcp(k)));
    this.tokens.clear();
  }
  async closeMcp(sid: string): Promise<void> {
    const c = this.mcpClients.get(sid);
    this.mcpClients.delete(sid);
    await c?.close().catch(() => {});
  }
  /** Connect, list tools, store a snapshot. Tools that are new since the last snapshot stay "off" until reviewed. */
  async refreshMcp(sid: string): Promise<{ tools: any[]; added: string[] }> {
    const s = this.db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(sid) as any;
    if (!s) throw new Error("no such MCP server");
    try {
      await this.closeMcp(sid);
      const client = await this.mcpClient(s);
      const res = await client.listTools();
      const before = new Set(json<any[]>(s.tools, []).map((t) => t.name));
      const tools = res.tools.map((t: any) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema,
        annotations: t.annotations ?? {},
      }));
      const added = tools.filter((t: any) => !before.has(t.name)).map((t: any) => t.name);
      const pol = this.policies("mcp", sid);
      for (const n of added)
        if (!pol[`${s.name}__${n}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)])
          this.setPolicy("mcp", sid, `${s.name}__${n}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64), "off");
      this.db.prepare("UPDATE mcp_servers SET tools = ?, status = 'ok', error = '' WHERE id = ?").run(JSON.stringify(tools), sid);
      return { tools, added };
    } catch (e) {
      this.db.prepare("UPDATE mcp_servers SET status = 'error', error = ? WHERE id = ?").run((e as Error).message.slice(0, 500), sid);
      throw e;
    }
  }
  private async callMcp(s: any, tool: string, args: any): Promise<string> {
    const client = await this.mcpClient(s);
    const r: any = await client.callTool({ name: tool, arguments: args ?? {} });
    const text = (r.content ?? []).map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
    if (r.isError) throw new Error(text || "tool failed");
    return text;
  }

  // ------------------------------------------------------------ the MCP endpoint agents talk to
  async handleMcp(req: IncomingMessage, res: ServerResponse, tok: string, body: unknown): Promise<void> {
    const info = this.tokens.get(tok);
    if (!info) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid token" }));
      return;
    }
    const agent = this.svc.agent(info.agentId);
    if (!agent) {
      res.writeHead(404).end();
      return;
    }
    const live = info.dynamic ? this.resolveContext(info.agentId) : undefined;
    const ctx: CallContext = { agent, chatId: live?.chatId ?? info.chatId, requester: live?.requester ?? info.requester };
    const server = new Server({ name: "circlechat", version: "2.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: (await this.toolsFor(ctx)).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => {
      const out = await this.call(r.params.name, r.params.arguments ?? {}, ctx);
      return { content: [{ type: "text", text: out.text }], isError: out.isError };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req as any, res, body);
  }
}

// ---------------------------------------------------------------- connected apps
function connectionTools(c: any, gw: Gateway): ToolDef[] {
  const cfg = json<any>(c.config, {});
  const resource = { type: "connection" as const, id: c.id, name: c.name, identity: c.identity };
  const secret = () => (c.secret_id ? gw.getSecret(c.secret_id) : "");
  if (c.app === "github") {
    const api = (cfg.apiBase || "https://api.github.com").replace(/\/+$/, "");
    const repos: string[] = cfg.repos ?? [];
    const gh = async (method: string, path: string, body?: any) => {
      const r = await fetch(api + path, {
        method,
        headers: {
          authorization: `Bearer ${secret()}`,
          accept: "application/vnd.github+json",
          "user-agent": "circlechat",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`GitHub ${r.status}: ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : {};
    };
    const repoOk = (repo: string) => {
      if (repos.length && !repos.includes(repo)) throw new Error(`repo ${repo} is not connected (allowed: ${repos.join(", ")})`);
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("repo must look like owner/name");
      return repo;
    };
    const R = str("owner/name");
    return [
      {
        name: "github_list_issues",
        category: "read",
        resource,
        description: "List open issues in a repo.",
        inputSchema: S({ repo: R, state: { type: "string", enum: ["open", "closed", "all"] } }, ["repo"]),
        run: async (a) =>
          (await gh("GET", `/repos/${repoOk(a.repo)}/issues?state=${a.state ?? "open"}&per_page=30`)).map((i: any) => `#${i.number} ${i.title}`).join("\n") ||
          "(none)",
      },
      {
        name: "github_get_issue",
        category: "read",
        resource,
        description: "Read an issue or pull request with its body.",
        inputSchema: S({ repo: R, number: num("issue number") }, ["repo", "number"]),
        run: async (a) => {
          const i = await gh("GET", `/repos/${repoOk(a.repo)}/issues/${Number(a.number)}`);
          return `#${i.number} ${i.title}\n\n${i.body ?? ""}`;
        },
      },
      {
        name: "github_create_issue",
        category: "write",
        resource,
        description: "Open a new issue.",
        inputSchema: S({ repo: R, title: str("title"), body: str("body") }, ["repo", "title"]),
        run: async (a) => {
          const i = await gh("POST", `/repos/${repoOk(a.repo)}/issues`, { title: a.title, body: a.body ?? "" });
          return `Opened #${i.number}: ${i.html_url ?? ""}`;
        },
      },
      {
        name: "github_comment",
        category: "write",
        resource,
        description: "Comment on an issue or pull request.",
        inputSchema: S({ repo: R, number: num("issue or PR number"), body: str("comment") }, ["repo", "number", "body"]),
        run: async (a) => {
          const r = await gh("POST", `/repos/${repoOk(a.repo)}/issues/${Number(a.number)}/comments`, { body: a.body });
          return `Commented: ${r.html_url ?? "ok"}`;
        },
      },
      {
        name: "github_create_pull_request",
        category: "write",
        resource,
        description: "Open a pull request from a pushed branch.",
        inputSchema: S({ repo: R, title: str("title"), head: str("branch with changes"), base: str("target branch"), body: str("description") }, [
          "repo",
          "title",
          "head",
          "base",
        ]),
        run: async (a) => {
          const p = await gh("POST", `/repos/${repoOk(a.repo)}/pulls`, { title: a.title, head: a.head, base: a.base, body: a.body ?? "" });
          return `Opened PR #${p.number}: ${p.html_url ?? ""}`;
        },
      },
      {
        name: "github_merge_pull_request",
        category: "danger",
        resource,
        description: "Merge a pull request.",
        inputSchema: S({ repo: R, number: num("PR number") }, ["repo", "number"]),
        run: async (a) => {
          await gh("PUT", `/repos/${repoOk(a.repo)}/pulls/${Number(a.number)}/merge`, {});
          return "Merged.";
        },
      },
      {
        name: "github_delete_branch",
        category: "danger",
        resource,
        description: "Delete a branch.",
        inputSchema: S({ repo: R, branch: str("branch") }, ["repo", "branch"]),
        run: async (a) => {
          await gh("DELETE", `/repos/${repoOk(a.repo)}/git/refs/heads/${encodeURIComponent(a.branch)}`);
          return "Deleted.";
        },
      },
    ];
  }
  if (c.app === "http") {
    // Any HTTP API: the base URL is fixed per connection, the credential is injected here, never in the sandbox.
    const base = String(cfg.baseUrl ?? "").replace(/\/+$/, "");
    const host = (() => {
      try {
        return new URL(base).host;
      } catch {
        return "";
      }
    })();
    const form = cfg.bodyFormat === "form";
    const tool = (verb: string, cat: Category): ToolDef => ({
      name: `${slug(c.name)}_${verb.toLowerCase()}`,
      category: cat,
      resource,
      description: `${verb} a path on ${c.name} (${host}).${cfg.hint ? " " + cfg.hint : ""}`,
      inputSchema: S({ path: str("path starting with /, may include a query string"), body: { type: "object", description: "JSON body" } }, ["path"]),
      run: async (a) => {
        const path = String(a.path ?? "/");
        if (!path.startsWith("/") || path.startsWith("//")) throw new Error("path must start with a single /");
        const url = new URL(base + path);
        if (url.host !== host) throw new Error("requests must stay on " + host);
        const r = await fetch(url, {
          method: verb,
          headers: {
            ...connectionHeaders(cfg, c.secret_id ? secret() : ""),
            accept: "application/json",
            ...(a.body && verb !== "GET" ? { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" } : {}),
          },
          body: a.body && verb !== "GET" ? (form ? formEncode(a.body) : JSON.stringify(a.body)) : undefined,
          redirect: "manual",
        });
        const text = await r.text();
        return `${r.status} ${text.slice(0, 6000)}`;
      },
    });
    return [tool("GET", "read"), tool("POST", "write"), tool("PUT", "write"), tool("PATCH", "write"), tool("DELETE", "danger")];
  }
  return [];
}

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 30) || "app"
  );
}
