// SPDX-License-Identifier: AGPL-3.0-only
// Slack bridge: mirror one Slack channel and one CircleChat chat both ways.
// Agents keep living in CircleChat (sandbox, approvals, logs); people can talk
// to them from Slack. Uses Socket Mode, so no public URL is needed.
import WebSocket from "ws";
import type { Services } from "../services.ts";
import type { Bus } from "../bus.ts";

export interface SlackBridgeConfig {
  id: string;
  chatId: string;
  channel: string; // Slack channel id, e.g. C0123
  botToken: string; // xoxb-...
  appToken: string; // xapp-... (Socket Mode)
  apiBase?: string; // for tests
}

export class SlackBridge {
  private ws?: WebSocket;
  private off?: () => void;
  private closed = false;
  private names = new Map<string, string>();
  private botUserId = "";
  status: "connecting" | "connected" | "error" | "stopped" = "stopped";
  lastError = "";

  private cfg: SlackBridgeConfig;

  private svc: Services;

  private bus: Bus;

  private agentName: (id: string) => string;

  constructor(cfg: SlackBridgeConfig, svc: Services, bus: Bus, agentName: (id: string) => string) {
    this.cfg = cfg;

    this.svc = svc;

    this.bus = bus;

    this.agentName = agentName;
  }

  private api(method: string, body: any, tokenKind: "bot" | "app" = "bot"): Promise<any> {
    const base = (this.cfg.apiBase ?? "https://slack.com/api").replace(/\/+$/, "");
    return fetch(`${base}/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenKind === "bot" ? this.cfg.botToken : this.cfg.appToken}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body ?? {}),
    }).then((r) => r.json());
  }

  async start(): Promise<void> {
    this.closed = false;
    this.status = "connecting";
    const auth = await this.api("auth.test", {});
    if (!auth.ok) throw new Error(`Slack auth failed: ${auth.error}`);
    this.botUserId = auth.user_id ?? "";
    // outbound: CircleChat -> Slack (skip anything that came from Slack)
    this.off = this.bus.onEvent((e) => {
      if (e.type !== "message" || e.chatId !== this.cfg.chatId) return;
      const m: any = e.message;
      if (m.meta?.source === "slack" || m.kind === "approval") return;
      const name = m.authorType === "agent" ? this.agentName(m.authorId) : m.authorType === "system" ? "CircleChat" : (m.meta?.displayName ?? "CircleChat");
      void this.api("chat.postMessage", { channel: this.cfg.channel, text: m.body, username: name, unfurl_links: false }).catch(() => {});
    });
    await this.connect();
  }

  private async connect(): Promise<void> {
    const open = await this.api("apps.connections.open", {}, "app");
    if (!open.ok) {
      this.status = "error";
      this.lastError = open.error;
      throw new Error(`Socket Mode failed: ${open.error}`);
    }
    const ws = new WebSocket(open.url);
    this.ws = ws;
    ws.on("open", () => (this.status = "connected"));
    ws.on("message", (raw) => void this.onFrame(String(raw)));
    ws.on("close", () => {
      if (this.closed) return;
      this.status = "connecting";
      setTimeout(() => void this.connect().catch((e) => (this.lastError = e.message)), 3000).unref();
    });
    ws.on("error", (e) => (this.lastError = e.message));
  }

  private async onFrame(raw: string): Promise<void> {
    let f: any;
    try {
      f = JSON.parse(raw);
    } catch {
      return;
    }
    if (f.envelope_id) this.ws?.send(JSON.stringify({ envelope_id: f.envelope_id })); // ack within 3 s
    if (f.type !== "events_api") return;
    const ev = f.payload?.event;
    if (!ev || ev.type !== "message" || ev.subtype || ev.bot_id || ev.user === this.botUserId) return;
    if (ev.channel !== this.cfg.channel) return;
    const name = await this.userName(ev.user);
    // Slack writes mentions as plain @handle in our convention; also map "<@U..>" to nothing.
    const text = String(ev.text ?? "")
      .replace(/<@[A-Z0-9]+>/g, "")
      .trim();
    this.svc.post({
      chatId: this.cfg.chatId,
      authorType: "user",
      authorId: `slack:${ev.user}`,
      body: text,
      meta: { source: "slack", displayName: name, slackTs: ev.ts },
    });
  }

  private async userName(uid: string): Promise<string> {
    if (this.names.has(uid)) return this.names.get(uid)!;
    const r = await this.api("users.info", { user: uid }).catch(() => ({}));
    const n = r?.user?.profile?.display_name || r?.user?.real_name || "Slack user";
    this.names.set(uid, n);
    return n;
  }

  stop(): void {
    this.closed = true;
    this.status = "stopped";
    this.off?.();
    this.ws?.close();
  }
}
