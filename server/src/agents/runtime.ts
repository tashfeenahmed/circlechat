// SPDX-License-Identifier: AGPL-3.0-only
// Agent runtime: one long-lived CLI agent process per agent, talked to over ACP.
// Sessions are per chat and survive restarts (session/load where supported).
// Messages arrive through a delivery queue and run one turn at a time.
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DB } from "../db.ts";
import { now, getSetting, json } from "../db.ts";
import { AcpConnection, type PermissionRequest, type PermissionOutcome } from "./acp.ts";
import { engineById, agentDirs, sandboxMemory, type ModelProvider } from "./engines.ts";
import type { Services, Agent, Delivery } from "../services.ts";
import { MENTION_ALL, mentions } from "../services.ts";
import type { Gateway } from "../gateway.ts";
import type { Bus, AgentStatus, ActivityEntry, AgentState } from "../bus.ts";
import { appendToolCall } from "../toollog.ts";

const execFileP = promisify(execFile);

export interface RuntimeOptions {
  dataDir: string;
  idleSleepMs: number; // stop the process after this long with nothing to do (0 = never)
  turnTimeoutMs: number; // hard cap on one turn
  providers(): ModelProvider[];
  workspaceName(): string;
}

interface SessionInfo {
  sessionId: string;
  token: string;
  primed: boolean; // has the agent been given its briefing in this session?
  lastSeenTs: number;
}

const AUTO_KINDS = new Set(["read", "search", "think", "fetch", "switch_mode"]);
const SANDBOX_KINDS = new Set(["edit", "execute", "move", "other"]);

export class AgentWorker {
  status: AgentStatus = { state: "stopped", detail: "", since: now(), heartbeat: 0 };
  private proc?: ChildProcessWithoutNullStreams;
  private conn?: AcpConnection;
  private starting?: Promise<void>;
  private sessions = new Map<string, SessionInfo>(); // chatId -> session
  private opening = new Map<string, Promise<SessionInfo>>(); // chatId -> session being opened
  private running = false;
  private stopping = false;
  private idleTimer?: NodeJS.Timeout;
  private replyBuf = new Map<string, string>(); // sessionId -> reply text
  private activeSession?: string;
  private activeChat?: string;
  private activity: ActivityEntry[] = [];
  private restarts = 0;
  private containerName = "";
  private agentToken = "";
  currentRequester?: { type: string; id: string };
  get currentChat(): string | undefined {
    return this.activeChat;
  }
  logPath: string;

  agentId: string;

  private rt: AgentRuntime;

  constructor(agentId: string, rt: AgentRuntime) {
    this.agentId = agentId;

    this.rt = rt;
    const { home } = agentDirs(rt.opts.dataDir, agentId);
    this.logPath = join(home, "..", "session.log.jsonl");
  }

  private get svc() {
    return this.rt.svc;
  }
  private agent(): Agent {
    const a = this.svc.agent(this.agentId);
    if (!a) throw new Error("agent not found");
    return a;
  }

  // ---------------------------------------------------------------- status + activity
  markWaiting(waiting: boolean, detail: string): void {
    if (waiting) this.setState("waiting_approval", detail, this.activeChat);
    else if (this.status.state === "waiting_approval") this.setState("working", detail, this.activeChat);
  }
  private setState(state: AgentState, detail = "", chatId?: string): void {
    this.status = { state, detail, since: now(), heartbeat: now(), chatId };
    this.svc.bus.emitEvent({ type: "agent_status", agentId: this.agentId, status: this.status });
  }
  /** Streamed text arrives a few tokens at a time. Consecutive chunks of the same kind become one entry. */
  private streaming: { e: ActivityEntry; chatId: string } | null = null;
  private chunk(kind: "message" | "thought", text: string): void {
    const chatId = this.activeChat ?? "";
    const s = this.streaming;
    if (s && s.e.kind === kind && s.chatId === chatId && s.e.text.length + text.length <= 4000) {
      s.e.text += text;
      this.status.heartbeat = now();
      this.svc.bus.emitEvent({ type: "agent_activity", agentId: this.agentId, chatId, entry: { ...s.e, text }, append: true });
      return;
    }
    this.flushStream();
    const e: ActivityEntry = { ts: now(), kind, text };
    this.status.heartbeat = e.ts;
    this.activity.push(e);
    if (this.activity.length > 500) this.activity.splice(0, this.activity.length - 500);
    this.streaming = { e, chatId };
    this.svc.bus.emitEvent({ type: "agent_activity", agentId: this.agentId, chatId, entry: e });
  }
  private flushStream(): void {
    const s = this.streaming;
    if (!s) return;
    this.streaming = null;
    try {
      appendFileSync(this.logPath, JSON.stringify({ ...s.e, chatId: s.chatId }) + "\n");
    } catch {}
  }
  private log(entry: Omit<ActivityEntry, "ts">, chatId = this.activeChat ?? ""): void {
    this.flushStream();
    const e: ActivityEntry = { ts: now(), ...entry, text: entry.text.slice(0, 4000) };
    this.status.heartbeat = e.ts;
    this.activity.push(e);
    if (this.activity.length > 500) this.activity.splice(0, this.activity.length - 500);
    try {
      appendFileSync(this.logPath, JSON.stringify({ ...e, chatId }) + "\n");
    } catch {}
    this.svc.bus.emitEvent({ type: "agent_activity", agentId: this.agentId, chatId, entry: e });
  }
  recentActivity(limit = 200): ActivityEntry[] {
    if (this.activity.length) return this.activity.slice(-limit);
    if (!existsSync(this.logPath)) return [];
    try {
      const size = statSync(this.logPath).size;
      const text = readFileSync(this.logPath, "utf8").slice(Math.max(0, size - 400_000));
      return text
        .trim()
        .split("\n")
        .slice(-limit)
        .map((l) => json<ActivityEntry>(l, { ts: 0, kind: "error", text: "?" }));
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------- process lifecycle
  async ensureStarted(): Promise<void> {
    if (this.conn && !this.conn.isClosed) return;
    if (!this.starting) this.starting = this.start().finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async start(): Promise<void> {
    const a = this.agent();
    const engine = engineById(a.engine);
    if (!engine) throw new Error(`unknown engine ${a.engine}`);
    this.setState("starting", `starting ${engine.name}`);
    this.stopping = false;
    const { home, work } = agentDirs(this.rt.opts.dataDir, a.id);
    const provider = pickProvider(this.rt.opts.providers(), engine.providerKinds, a.model);
    const modelName = a.model.includes(":") ? a.model.split(/:(.*)/s)[1] : a.model;
    let agentMcpUrl: string | undefined;
    if (engine.sessionMcp === false) {
      if (this.agentToken) this.rt.gateway.revoke(this.agentToken);
      this.agentToken = this.rt.gateway.issueAgentToken(a.id);
      agentMcpUrl = this.rt.gateway.agentMcpUrl(this.agentToken, a.sandbox === "docker");
    }
    const spec = engine.launch({ agentId: a.id, handle: a.handle, home, work, model: modelName, provider, sandbox: a.sandbox, agentMcpUrl });
    let proc: ChildProcessWithoutNullStreams;
    if (a.sandbox === "docker" && engine.image) {
      this.containerName = `cc-${a.handle}-${Math.random().toString(36).slice(2, 7)}`;
      const envArgs = Object.entries({ HOME: "/home/agent", ...spec.env }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      const args = [
        "run",
        "-i",
        "--rm",
        "--init",
        "--name",
        this.containerName,
        "--add-host",
        "host.docker.internal:host-gateway",
        "--memory",
        sandboxMemory(engine, getSetting(this.svc.db, "sandbox_memory")),
        "--cpus",
        getSetting(this.svc.db, "sandbox_cpus") ?? "2",
        "--label",
        "circlechat.agent=" + a.id,
        // least privilege: no Linux capabilities, no setuid escalation, bounded processes, not root
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "512",
        ...(typeof process.getuid === "function" ? ["--user", `${process.getuid()}:${process.getgid?.() ?? 0}`] : []),
        "-v",
        `${home}:/home/agent`,
        // engine state that needs a real Linux filesystem lives on a per-agent named volume
        ...(spec.volumes ?? []).flatMap((v) => ["-v", `cc-${a.id.toLowerCase().replace(/[^a-z0-9]/g, "")}-${v.name}:${v.target}`]),
        "-w",
        spec.cwd,
        ...envArgs,
        engine.image,
        spec.command,
        ...spec.args,
      ];
      proc = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    } else {
      proc = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
    }
    this.proc = proc;
    const conn = new AcpConnection(proc, {
      onUpdate: (sid, u) => this.onUpdate(sid, u),
      onPermission: (req) => this.onPermission(req),
      onStderr: (line) => this.log({ kind: "stderr", text: line }),
    });
    this.conn = conn;
    conn.on("close", (err: Error) => this.onClosed(conn, err));
    try {
      await conn.initialize();
    } catch (e) {
      this.log({ kind: "error", text: `could not start: ${(e as Error).message}` });
      this.kill();
      this.setState("crashed", (e as Error).message);
      throw e;
    }
    this.restarts = 0;
    this.log({
      kind: "lifecycle",
      text: `${engine.name} ready (${conn.agentInfo?.name ?? "agent"} ${conn.agentInfo?.version ?? ""}) in ${a.sandbox === "docker" ? "container " + this.containerName : "local folder"}`,
    });
    this.setState("idle");
  }

  private onClosed(conn: AcpConnection, err: Error): void {
    if (conn !== this.conn) return; // an old process we already let go of
    this.conn = undefined;
    this.proc = undefined;
    this.sessions.forEach((s) => this.rt.gateway.revoke(s.token));
    this.sessions.clear(); // engine session ids are kept in the db and re-loaded on restart
    if (this.stopping) {
      this.setState(this.status.state === "sleeping" ? "sleeping" : "stopped");
      return;
    }
    this.log({ kind: "error", text: `engine stopped: ${err.message}` });
    this.setState("crashed", err.message);
    // restart only when there is work waiting; back off on repeated crashes
    const delay = Math.min(60_000, 1000 * 2 ** this.restarts++);
    setTimeout(() => {
      if (this.svc.queued(this.agentId).length) void this.pump();
    }, delay).unref();
  }

  private kill(proc = this.proc): void {
    this.stopping = true;
    try {
      proc?.stdin.end();
      proc?.kill("SIGTERM");
    } catch {}
    if (this.containerName) {
      const name = this.containerName;
      this.containerName = "";
      execFileP("docker", ["rm", "-f", name]).catch(() => {});
    }
  }

  async stop(reason: "stopped" | "sleeping" = "stopped"): Promise<void> {
    clearTimeout(this.idleTimer);
    const conn = this.conn;
    const proc = this.proc;
    if (conn && this.activeSession) conn.cancel(this.activeSession);
    // let go of the process right away so the next message starts a fresh one
    this.conn = undefined;
    this.proc = undefined;
    this.sessions.forEach((s) => this.rt.gateway.revoke(s.token));
    this.sessions.clear();
    if (proc) this.kill(proc);
    this.setState(reason);
  }

  async newSession(chatId: string): Promise<void> {
    this.svc.db.prepare("DELETE FROM agent_sessions WHERE agent_id = ? AND scope = ?").run(this.agentId, chatId);
    const s = this.sessions.get(chatId);
    if (s) this.rt.gateway.revoke(s.token);
    this.sessions.delete(chatId);
    this.log({ kind: "lifecycle", text: "new session started, memory kept" }, chatId);
  }

  cancelTurn(): void {
    if (this.conn && this.activeSession) this.conn.cancel(this.activeSession);
  }

  // ---------------------------------------------------------------- sessions
  /**
   * Start the agent and open its session for a chat before a message arrives, so the first
   * reply doesn't wait for the engine to boot (Hermes loads its plugins on the first session,
   * which took ~7 s). Safe to call often: it does nothing when already warm or busy.
   */
  async warm(chatId?: string): Promise<void> {
    if (this.running || this.stopping) return;
    try {
      await this.ensureStarted();
      if (chatId && !this.sessions.has(chatId) && !this.running) {
        const owner = this.svc.db.prepare("SELECT id FROM users ORDER BY created_at LIMIT 1").get() as any;
        await this.sessionFor(chatId, { fromType: "user", fromId: owner?.id ?? "" } as Delivery);
      }
    } catch {
      return; // a real message will retry and report the error in the chat
    }
    if (!this.running) this.armIdle();
  }

  private async sessionFor(chatId: string, d: Delivery): Promise<SessionInfo> {
    const requester = { type: d.fromType, id: d.fromId };
    const pending = this.opening.get(chatId);
    if (pending) await pending.catch(() => undefined);
    const existing = this.sessions.get(chatId);
    if (existing) {
      this.rt.gateway.updateRequester(existing.token, requester);
      return existing;
    }
    const p = this.openSession(chatId, requester);
    this.opening.set(chatId, p);
    try {
      return await p;
    } finally {
      this.opening.delete(chatId);
    }
  }

  private async openSession(chatId: string, requester: { type: string; id: string }): Promise<SessionInfo> {
    const a = this.agent();
    const conn = this.conn!;
    const tok = this.rt.gateway.issueToken(a.id, chatId, requester);
    const engineDef = engineById(a.engine);
    const mcp = engineDef?.sessionMcp === false ? [] : [this.rt.gateway.mcpServerEntry(tok, a.sandbox === "docker")];
    const cwd = a.sandbox === "docker" ? "/home/agent/work" : agentDirs(this.rt.opts.dataDir, a.id).work;
    const stored = this.svc.db.prepare("SELECT engine_session_id FROM agent_sessions WHERE agent_id = ? AND scope = ?").get(a.id, chatId) as any;
    let sessionId = "";
    let primed = false;
    if (stored && (await conn.loadSession(stored.engine_session_id, cwd, mcp))) {
      sessionId = stored.engine_session_id;
      primed = true;
      this.log({ kind: "lifecycle", text: "resumed earlier session" }, chatId);
    } else {
      sessionId = await conn.newSession(cwd, mcp);
      this.svc.db
        .prepare(
          "INSERT INTO agent_sessions(agent_id, scope, engine_session_id, updated_at) VALUES(?,?,?,?) ON CONFLICT DO UPDATE SET engine_session_id = excluded.engine_session_id, updated_at = excluded.updated_at",
        )
        .run(a.id, chatId, sessionId, now());
      if (stored) this.log({ kind: "lifecycle", text: "could not resume, started a fresh session with a summary" }, chatId);
    }
    const info: SessionInfo = { sessionId, token: tok, primed, lastSeenTs: primed ? 0 : now() };
    this.sessions.set(chatId, info);
    return info;
  }

  // ---------------------------------------------------------------- the work loop
  async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    clearTimeout(this.idleTimer);
    try {
      for (;;) {
        const next = this.svc.queued(this.agentId)[0];
        if (!next) break;
        await this.runDelivery(next);
      }
    } finally {
      this.running = false;
      this.armIdle();
    }
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    const ms = this.rt.opts.idleSleepMs;
    if (ms > 0 && this.conn) this.idleTimer = setTimeout(() => void this.stop("sleeping"), ms);
    this.idleTimer?.unref?.();
  }

  private async runDelivery(d: Delivery): Promise<void> {
    const a = this.agent();
    if (this.svc.overBudget(a.id)) {
      this.svc.setDeliveryState(d.id, "failed", "budget reached");
      this.svc.insertMessage({
        chatId: d.chatId,
        authorType: "system",
        authorId: "",
        kind: "system",
        body: `${a.name} has reached the spending limit for this month, so it did not start. An admin can raise the limit in Models and keys.`,
        meta: { reason: "budget", agentId: a.id },
      });
      this.setState("budget", "spending limit reached");
      return;
    }
    try {
      await this.ensureStarted();
    } catch (e) {
      this.svc.setDeliveryState(d.id, "failed", (e as Error).message);
      this.svc.insertMessage({
        chatId: d.chatId,
        authorType: "system",
        authorId: "",
        kind: "error",
        body: `${a.name} could not start: ${(e as Error).message}`,
        meta: { agentId: a.id },
      });
      return;
    }
    const conn = this.conn!;
    let session: SessionInfo;
    try {
      session = await this.sessionFor(d.chatId, d);
    } catch (e) {
      this.svc.setDeliveryState(d.id, "failed", (e as Error).message);
      this.svc.insertMessage({
        chatId: d.chatId,
        authorType: "system",
        authorId: "",
        kind: "error",
        body: `${a.name} could not open a session: ${(e as Error).message}`,
        meta: { agentId: a.id },
      });
      return;
    }
    this.svc.setDeliveryState(d.id, "injected");
    this.currentRequester = { type: d.fromType, id: d.fromId };
    this.activeSession = session.sessionId;
    this.activeChat = d.chatId;
    this.replyBuf.set(session.sessionId, "");
    this.setState("working", firstLine(d.text), d.chatId);
    this.svc.bus.emitEvent({ type: "typing", chatId: d.chatId, agentId: a.id, on: true });
    const text = this.compose(a, d, session);
    this.log({ kind: "prompt", text: `${this.rt.gateway.authorName(d.fromType === "trigger" ? "system" : d.fromType, d.fromId)}: ${d.text}` }, d.chatId);
    session.primed = true;
    session.lastSeenTs = now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const turn = conn.prompt(session.sessionId, text);
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => {
          conn.cancel(session.sessionId);
          rej(new Error("turn took too long and was stopped"));
        }, this.rt.opts.turnTimeoutMs);
      });
      const r = await Promise.race([turn, timeout]);
      const reply = (this.replyBuf.get(session.sessionId) ?? "").trim();
      if (r.stopReason === "cancelled") {
        this.svc.setDeliveryState(d.id, "failed", "cancelled");
        this.log({ kind: "lifecycle", text: "turn cancelled" });
      } else {
        if (reply)
          this.svc.post({
            chatId: d.chatId,
            authorType: "agent",
            authorId: a.id,
            body: reply,
            hop: d.hop,
            goalId: d.goalId,
            meta: { stopReason: r.stopReason },
          });
        this.svc.setDeliveryState(d.id, "answered");
      }
      this.svc.db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE agent_id = ? AND scope = ?").run(now(), a.id, d.chatId);
    } catch (e) {
      const msg = (e as Error).message;
      this.svc.setDeliveryState(d.id, "failed", msg);
      // Never retry a whole turn automatically: it may have had side effects.
      this.svc.insertMessage({
        chatId: d.chatId,
        authorType: "system",
        authorId: "",
        kind: "error",
        body: `${a.name} stopped before finishing (${msg}). Nothing was retried automatically. Ask again to retry.`,
        meta: { agentId: a.id, deliveryId: d.id },
      });
    } finally {
      clearTimeout(timer);
      this.flushStream();
      this.replyBuf.delete(session.sessionId);
      this.activeSession = undefined;
      this.svc.bus.emitEvent({ type: "typing", chatId: d.chatId, agentId: a.id, on: false });
      if (this.conn && !this.conn.isClosed) this.setState("idle");
      this.activeChat = undefined;
    }
  }

  /** What the CLI agent actually receives. The briefing goes in once per session. */
  private compose(a: Agent, d: Delivery, s: SessionInfo): string {
    const parts: string[] = [];
    const chat = this.svc.chat(d.chatId);
    if (!s.primed) {
      const people = (chat?.members ?? []).filter((m: any) => m.type === "user").map((m: any) => this.rt.gateway.authorName("user", m.id));
      const agents = this.svc
        .chatAgents(d.chatId)
        .filter((x) => x.id !== a.id)
        .map((x) => `@${x.handle} (${x.name}, ${x.roleTitle})`);
      const mem = this.svc
        .memoriesFor(a.id, d.chatId)
        .slice(0, 30)
        .map((m) => `- ${m.text}`);
      const autonomy = {
        ask: "Ask a person before doing anything that changes something outside this chat.",
        act: "Do the work, then say what you did. Risky actions will be sent to a person for approval automatically.",
        auto: "Work on your own. Rules set by admins still apply.",
      }[a.autonomy];
      parts.push(
        `You are ${a.name} (@${a.handle}), ${a.roleTitle || "an agent"} in the "${this.rt.opts.workspaceName()}" team on CircleChat, a group chat where people and AI agents work together.`,
        a.instructions ? `How you work:\n${a.instructions}` : "",
        [
          "Rules:",
          "- Your final reply each turn is posted to the chat for you. Keep it short, friendly and in plain words. Don't use emoji as decoration.",
          "- This conversation is your short-term memory. When asked about something said earlier, look back at the messages above first.",
          "- Use the circlechat tools: handoff (ask another agent), remember / recall (long-term notes that outlive this chat), propose_plan, task_update, chat_history (older messages you can't see).",
          "- Only @mention another agent when you really need them. Never reply just to say thanks or OK.",
          "- Some tools need a person's approval. If something is denied or blocked, say so briefly and stop.",
          "- Never ask for, store or repeat passwords or keys.",
          `- ${autonomy}`,
        ].join("\n"),
        `Chat: ${chat?.name ?? ""} (${chat?.kind === "dm" ? "one to one" : chat?.kind === "agents" ? "agents only, people can read it" : "group"}).`,
        people.length ? `People here: ${people.join(", ")}.` : "",
        agents.length ? `Other agents here: ${agents.join(", ")}.` : "",
        mem.length ? `What you remember:\n${mem.join("\n")}` : "",
      );
    } else {
      // Show what happened in the chat since the agent last looked, so it isn't blind to others.
      const since = this.svc
        .messages(d.chatId, undefined, 30)
        .filter((m) => m.ts > s.lastSeenTs && !(m.authorType === "agent" && m.authorId === a.id) && m.body !== d.text);
      if (since.length)
        parts.push(
          "Since your last turn:\n" +
            since
              .slice(-15)
              .map((m) => `${this.rt.gateway.authorName(m.authorType, m.authorId)}: ${firstLine(m.body, 300)}`)
              .join("\n"),
        );
    }
    const from =
      d.fromType === "trigger"
        ? `trigger "${d.fromId}"`
        : `${this.rt.gateway.authorName(d.fromType, d.fromId)} (${d.fromType === "agent" ? "an agent" : "a person"})`;
    if (d.fromType === "user" && mentions(d.text).some((h) => MENTION_ALL.has(h)) && this.svc.chatAgents(d.chatId).length > 1)
      parts.push("This message went to every agent in the chat at once. Answer only the part that fits your job, keep it short, and don't repeat what the others will say.");
    parts.push(`<<<MESSAGE>>>\nFrom ${from}:\n${d.text}\n<<<END>>>`);
    return parts.filter(Boolean).join("\n\n");
  }

  // ---------------------------------------------------------------- engine events
  private onUpdate(sessionId: string, u: any): void {
    if (!u) return;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content?.type === "text") {
          this.replyBuf.set(sessionId, (this.replyBuf.get(sessionId) ?? "") + u.content.text);
          this.chunk("message", u.content.text);
        }
        break;
      case "agent_thought_chunk":
        if (u.content?.type === "text") this.chunk("thought", u.content.text);
        break;
      case "tool_call":
        this.log({ kind: "tool", text: u.title ?? "tool", status: u.status ?? "pending", toolCallId: u.toolCallId, toolKind: u.kind });
        if (this.status.state === "working") this.setState("working", u.title ?? this.status.detail, this.activeChat);
        break;
      case "tool_call_update":
        this.log({ kind: "tool", text: u.title ?? "", status: u.status ?? "", toolCallId: u.toolCallId, toolKind: u.kind });
        break;
      case "plan":
        this.log({
          kind: "plan",
          text: (u.entries ?? []).map((e: any) => `${e.status === "completed" ? "[x]" : e.status === "in_progress" ? "[~]" : "[ ]"} ${e.content}`).join("\n"),
        });
        break;
      case "usage_update": {
        const amount = Number(u.cost?.amount ?? 0);
        if (amount > 0) this.rt.svc.addUsage(this.agentId, 0, Math.round(amount * 1_000_000));
        this.log({ kind: "usage", text: `${u.used ?? 0} / ${u.size ?? 0} tokens${amount ? ` · $${amount.toFixed(4)}` : ""}` });
        break;
      }
      default:
        break;
    }
  }

  /** Permission requests from inside the sandbox. External actions are gated separately by the gateway. */
  private async onPermission(req: PermissionRequest): Promise<PermissionOutcome> {
    const a = this.agent();
    const kind = req.toolCall?.kind ?? "other";
    const title = req.toolCall?.title ?? kind;
    const pick = (kinds: string[]) => req.options.find((o) => kinds.includes(o.kind));
    const allowOnce = pick(["allow_once"]) ?? pick(["allow_always"]);
    const chatId = this.activeChat ?? "";
    let auto = false;
    if (AUTO_KINDS.has(kind)) auto = true;
    else if (a.autonomy === "auto") auto = true;
    else if (a.autonomy === "act" && a.sandbox === "docker" && SANDBOX_KINDS.has(kind)) auto = true; // contained in its own sandbox
    if (auto && allowOnce) {
      appendToolCall(this.svc.db, { agentId: a.id, chatId, tool: `sandbox.${kind}`, args: { title }, approval: "auto (sandbox)", status: "ok" });
      return { outcome: "selected", optionId: allowOnce.optionId };
    }
    this.setState("waiting_approval", title, chatId);
    const ap = this.svc.createApproval({
      agentId: a.id,
      chatId,
      source: "acp",
      title: `${a.name} wants to: ${title}`,
      detail: { kind, title, rawInput: req.toolCall?.rawInput ?? null, sandbox: a.sandbox },
      options: [
        { id: "allow_once", label: "Approve once" },
        { id: "allow_always", label: "Always for this agent" },
        { id: "deny", label: "Deny" },
      ],
      ttlMs: this.rt.approvalTtlMs,
    });
    if (chatId) this.svc.insertMessage({ chatId, authorType: "system", authorId: "", kind: "approval", body: ap.title, meta: { approvalId: ap.id } });
    const decided: any = await this.rt.waitForApproval(ap.id, ap.expiresAt);
    this.setState("working", title, chatId);
    let opt;
    if (decided.state === "approved") opt = decided.decision === "allow_always" ? (pick(["allow_always"]) ?? allowOnce) : allowOnce;
    else opt = pick(["reject_once"]) ?? pick(["reject_always"]);
    appendToolCall(this.svc.db, {
      agentId: a.id,
      chatId,
      tool: `sandbox.${kind}`,
      args: { title },
      approval: decided.state === "approved" ? `${this.rt.gateway.authorName("user", decided.decidedBy)} approved` : decided.state,
      status: decided.state === "approved" ? "ok" : "denied",
    });
    return opt ? { outcome: "selected", optionId: opt.optionId } : { outcome: "cancelled" };
  }
}

export class AgentRuntime {
  private workers = new Map<string, AgentWorker>();
  private approvalWaiters = new Map<string, (ap: any) => void>();
  approvalTtlMs?: number;

  db: DB;

  svc: Services;

  gateway: Gateway;

  bus: Bus;

  opts: RuntimeOptions;

  constructor(db: DB, svc: Services, gateway: Gateway, bus: Bus, opts: RuntimeOptions) {
    this.db = db;

    this.svc = svc;

    this.gateway = gateway;

    this.bus = bus;

    this.opts = opts;
    svc.onDelivery((d) => void this.worker(d.agentId).pump());
    gateway.onWaiting = (agentId, waiting, detail) => {
      const w = this.workers.get(agentId);
      if (w && w.status.state !== "stopped") w.markWaiting(waiting, detail);
    };
    gateway.resolveContext = (agentId) => {
      const w = this.workers.get(agentId);
      return w?.currentChat && w.currentRequester ? { chatId: w.currentChat, requester: w.currentRequester } : undefined;
    };
    bus.onEvent((e) => {
      if (e.type === "approval") {
        const ap: any = e.approval;
        if (ap.state !== "pending") {
          this.approvalWaiters.get(ap.id)?.(ap);
          this.approvalWaiters.delete(ap.id);
        }
      }
    });
  }

  worker(agentId: string): AgentWorker {
    let w = this.workers.get(agentId);
    if (!w) {
      w = new AgentWorker(agentId, this);
      this.workers.set(agentId, w);
    }
    return w;
  }
  statusOf(agentId: string): AgentStatus {
    return this.workers.get(agentId)?.status ?? { state: "sleeping", detail: "", since: 0, heartbeat: 0 };
  }

  waitForApproval(aid: string, expiresAt: number): Promise<any> {
    return new Promise((resolve) => {
      this.approvalWaiters.set(aid, resolve);
      setTimeout(
        () => {
          if (this.approvalWaiters.has(aid)) resolve(this.svc.decideApproval(aid, "expired", "", "system"));
        },
        Math.max(0, expiresAt - Date.now()),
      ).unref();
    });
  }

  /** On boot: pick up anything that was queued or in flight when the server stopped. */
  resume(): void {
    this.db.prepare("UPDATE deliveries SET state = 'failed', error = 'server restarted mid-turn' WHERE state = 'injected'").run();
    const rows = this.db.prepare("SELECT DISTINCT agent_id FROM deliveries WHERE state = 'queued'").all() as any[];
    for (const r of rows) void this.worker(r.agent_id).pump();
  }

  /** Warm every agent in a chat (called when someone opens or starts typing in it). */
  warmChat(chatId: string): void {
    for (const a of this.svc.chatAgents(chatId)) void this.worker(a.id).warm(chatId);
  }

  /**
   * On boot: warm the agents people talk to most recently, one after another, so the first
   * message after a (re)start doesn't wait for an engine to boot. At most `max` agents.
   */
  async warmRecent(max = 4): Promise<void> {
    const rows = this.db
      .prepare(
        `SELECT cm.member_id AS agent_id, m.chat_id, MAX(m.ts) AS last
           FROM chat_members cm JOIN messages m ON m.chat_id = cm.chat_id
          WHERE cm.member_type = 'agent'
          GROUP BY cm.member_id ORDER BY last DESC LIMIT ?`,
      )
      .all(max) as any[];
    for (const r of rows) {
      if (!this.svc.agent(r.agent_id)) continue;
      await this.worker(r.agent_id).warm(r.chat_id);
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.workers.values()].map((w) => w.stop()));
  }
}

function pickProvider(all: ModelProvider[], kinds: ModelProvider["kind"][], model: string): ModelProvider | undefined {
  // a model may be written as "<provider>:<model>" to pin a provider
  const [pid, m] = model.includes(":") ? model.split(/:(.*)/s) : ["", model];
  if (pid) {
    const p = all.find((x) => x.id === pid);
    if (p) return { ...p, models: m ? [m, ...p.models.filter((x) => x !== m)] : p.models };
  }
  return all.find((p) => kinds.includes(p.kind));
}

function firstLine(s: string, max = 120): string {
  const l = s.split("\n").find((x) => x.trim()) ?? "";
  return l.length > max ? l.slice(0, max - 1) + "…" : l;
}
