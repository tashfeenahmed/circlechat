// SPDX-License-Identifier: AGPL-3.0-only
// Triggers: things outside CircleChat that wake an agent.
//  - webhook: POST /hooks/<id>, optional HMAC signature (GitHub-style), optional filter
//  - schedule: 5-field cron ("30 8 * * 1-5")
import type { DB } from "./db.ts";
import { json, now } from "./db.ts";
import { id, hmac, safeEqual } from "./crypto.ts";
import type { Services } from "./services.ts";

export interface Trigger {
  id: string;
  kind: "webhook" | "schedule";
  name: string;
  secret: string;
  schedule: string;
  filter: Record<string, any>;
  chatId: string;
  agentId: string;
  prompt: string;
  enabled: boolean;
  createdAt: number;
}
function row(r: any): Trigger {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    secret: r.secret,
    schedule: r.schedule,
    filter: json(r.filter, {}),
    chatId: r.chat_id,
    agentId: r.agent_id,
    prompt: r.prompt,
    enabled: !!r.enabled,
    createdAt: r.created_at,
  };
}

export class Triggers {
  private timer?: NodeJS.Timeout;
  private db: DB;
  private svc: Services;
  constructor(db: DB, svc: Services) {
    this.db = db;
    this.svc = svc;
  }

  list(): Trigger[] {
    return (this.db.prepare("SELECT * FROM triggers ORDER BY created_at").all() as any[]).map(row);
  }
  get(tid: string): Trigger | undefined {
    const r = this.db.prepare("SELECT * FROM triggers WHERE id = ?").get(tid);
    return r ? row(r) : undefined;
  }
  create(t: Omit<Trigger, "id" | "createdAt" | "enabled"> & { enabled?: boolean }): Trigger {
    if (t.kind === "schedule") parseCron(t.schedule); // throws if invalid
    if (!this.svc.agent(t.agentId)) throw new Error("unknown agent");
    if (!this.svc.chat(t.chatId)) throw new Error("unknown chat");
    if (!this.svc.isMember(t.chatId, "agent", t.agentId)) throw new Error("that agent is not in that chat");
    const tid = id("trg_");
    this.db
      .prepare("INSERT INTO triggers(id, kind, name, secret, schedule, filter, chat_id, agent_id, prompt, enabled, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        tid,
        t.kind,
        t.name,
        t.secret ?? "",
        t.schedule ?? "",
        JSON.stringify(t.filter ?? {}),
        t.chatId,
        t.agentId,
        t.prompt,
        t.enabled === false ? 0 : 1,
        now(),
      );
    return this.get(tid)!;
  }
  update(tid: string, patch: Partial<Trigger>): Trigger {
    const t = this.get(tid);
    if (!t) throw new Error("no such trigger");
    const n = { ...t, ...patch };
    if (n.kind === "schedule") parseCron(n.schedule);
    this.db
      .prepare("UPDATE triggers SET name = ?, secret = ?, schedule = ?, filter = ?, chat_id = ?, agent_id = ?, prompt = ?, enabled = ? WHERE id = ?")
      .run(n.name, n.secret, n.schedule, JSON.stringify(n.filter ?? {}), n.chatId, n.agentId, n.prompt, n.enabled ? 1 : 0, tid);
    return this.get(tid)!;
  }
  remove(tid: string): void {
    this.db.prepare("DELETE FROM triggers WHERE id = ?").run(tid);
  }
  runs(tid: string, limit = 20): any[] {
    return (this.db.prepare("SELECT * FROM trigger_runs WHERE trigger_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?").all(tid, limit) as any[]).map((r) => ({
      id: r.id,
      status: r.status,
      summary: r.summary,
      ts: r.ts,
      payload: json(r.payload, null),
    }));
  }

  /** Verify + filter + fire. Returns an HTTP-ish status. */
  handleWebhook(tid: string, rawBody: string, headers: Record<string, string | undefined>): { status: number; body: string } {
    const t = this.get(tid);
    if (!t || t.kind !== "webhook") return { status: 404, body: "not found" };
    if (!t.enabled) return { status: 409, body: "trigger is off" };
    if (t.secret) {
      const sig = headers["x-hub-signature-256"] ?? headers["x-circlechat-signature"] ?? "";
      const want = "sha256=" + hmac(t.secret, rawBody);
      if (!sig || !safeEqual(sig, want)) {
        this.record(tid, "rejected", "bad signature", null);
        return { status: 401, body: "bad signature" };
      }
    }
    let payload: any = null;
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      payload = { text: rawBody };
    }
    const event = headers["x-github-event"];
    if (event) payload = { event, ...payload };
    if (!matches(t.filter, payload)) {
      this.record(tid, "skipped", "did not match the filter", payload);
      return { status: 202, body: "skipped" };
    }
    this.fire(t, payload);
    return { status: 202, body: "delivered" };
  }

  replay(runId: string): void {
    const r = this.db.prepare("SELECT * FROM trigger_runs WHERE id = ?").get(runId) as any;
    if (!r) throw new Error("no such run");
    const t = this.get(r.trigger_id);
    if (!t) throw new Error("trigger is gone");
    this.fire(t, json(r.payload, {}), true);
  }

  fire(t: Trigger, payload: any, replay = false): void {
    const text = render(t.prompt, payload);
    const summary = summarize(payload);
    this.svc.insertMessage({
      chatId: t.chatId,
      authorType: "system",
      authorId: "",
      kind: "trigger",
      body: `${t.name}${summary ? ": " + summary : ""}`,
      meta: { triggerId: t.id, replay },
    });
    const d = this.svc.deliver({ agentId: t.agentId, chatId: t.chatId, fromType: "trigger", fromId: t.name, text, hop: 0, goalId: id("goal_") });
    this.record(t.id, d ? "delivered" : "failed", summary || text.slice(0, 120), payload);
  }

  private record(tid: string, status: string, summary: string, payload: any): void {
    this.db
      .prepare("INSERT INTO trigger_runs(id, trigger_id, status, summary, payload, ts) VALUES(?,?,?,?,?,?)")
      .run(id("run_"), tid, status, summary.slice(0, 300), JSON.stringify(payload ?? null).slice(0, 20000), now());
  }

  /** Called every 20 s; fires each schedule at most once per minute. */
  tick(at = new Date()): number {
    let fired = 0;
    const minute = at.toISOString().slice(0, 16);
    for (const t of this.list()) {
      if (t.kind !== "schedule" || !t.enabled) continue;
      const lr = this.db.prepare("SELECT last_run_minute FROM triggers WHERE id = ?").get(t.id) as any;
      if (lr?.last_run_minute === minute) continue;
      if (!cronMatches(parseCron(t.schedule), at)) continue;
      this.db.prepare("UPDATE triggers SET last_run_minute = ? WHERE id = ?").run(minute, t.id);
      this.fire(t, { at: at.toISOString() });
      fired++;
    }
    return fired;
  }
  start(): void {
    this.timer = setInterval(() => this.tick(), 20_000);
    this.timer.unref();
  }
  stop(): void {
    clearInterval(this.timer);
  }
}

// ---------------------------------------------------------------- helpers
export function get(obj: any, path: string): any {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
/** filter: {"event": "issues", "action": "opened", "issue.labels.*.name": "bug"} — all must match. */
export function matches(filter: Record<string, any>, payload: any): boolean {
  for (const [path, want] of Object.entries(filter ?? {})) {
    if (path.includes(".*.")) {
      const [arr, rest] = path.split(".*.");
      const list = get(payload, arr);
      if (!Array.isArray(list) || !list.some((x) => String(get(x, rest)) === String(want))) return false;
    } else if (String(get(payload, path)) !== String(want)) return false;
  }
  return true;
}
/** "Look into {{issue.title}} ({{issue.html_url}})" */
export function render(tpl: string, payload: any): string {
  const out = tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, p) => {
    const v = get(payload, p);
    return v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  });
  return out.includes("{{") ? out : out;
}
function summarize(p: any): string {
  if (!p || typeof p !== "object") return "";
  const title = p.issue?.title ?? p.pull_request?.title ?? p.title ?? p.subject ?? p.text ?? "";
  const num = p.issue?.number ?? p.pull_request?.number;
  return (num ? `#${num} ` : "") + String(title).slice(0, 140);
}

type Cron = [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
export function parseCron(expr: string): Cron {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error("schedule needs 5 fields: minute hour day month weekday");
  const ranges: [number, number][] = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];
  return f.map((field, i) => {
    const [lo, hi] = ranges[i];
    const set = new Set<number>();
    for (const part of field.split(",")) {
      const [base, stepS] = part.split("/");
      const step = stepS ? Number(stepS) : 1;
      if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${part}"`);
      let a = lo,
        b = hi;
      if (base !== "*") {
        const [x, y] = base.split("-").map(Number);
        if (!Number.isInteger(x) || (y !== undefined && !Number.isInteger(y))) throw new Error(`bad value "${part}"`);
        a = x;
        b = y ?? (stepS ? hi : x);
      }
      if (a < lo || b > hi || a > b) throw new Error(`"${part}" is out of range ${lo}-${hi}`);
      for (let v = a; v <= b; v += step) set.add(i === 4 && v === 7 ? 0 : v);
    }
    return set;
  }) as Cron;
}
export function cronMatches(c: Cron, d: Date): boolean {
  return c[0].has(d.getMinutes()) && c[1].has(d.getHours()) && c[2].has(d.getDate()) && c[3].has(d.getMonth() + 1) && c[4].has(d.getDay());
}
