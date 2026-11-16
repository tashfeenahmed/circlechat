// SPDX-License-Identifier: AGPL-3.0-only
// Wires everything together. Used by the server entry point and by tests.
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openDb, getSetting, setSetting, json, type DB } from "./db.ts";
import { Vault, token } from "./crypto.ts";
import { Bus } from "./bus.ts";
import { Services } from "./services.ts";
import { Gateway } from "./gateway.ts";
import { AgentRuntime } from "./agents/runtime.ts";
import { ENGINES, dockerfileFor, REPO_ROOT, type ModelProvider } from "./agents/engines.ts";
import { Triggers } from "./triggers.ts";
import { SlackBridge } from "./bridges/slack.ts";

const execFileP = promisify(execFile);

export interface AppConfig {
  dataDir: string;
  masterKey: string; // base64url, 32 bytes
  idleSleepMs?: number;
  turnTimeoutMs?: number;
  approvalTtlMs?: number;
  /** honour X-Forwarded-Proto/Host from a TLS reverse proxy (CIRCLECHAT_TRUST_PROXY=1) */
  trustProxy?: boolean;
  /** start the most recently used agents at boot so the first reply is quick */
  warmOnBoot?: boolean;
}

export interface StoredProvider {
  id: string;
  kind: ModelProvider["kind"];
  baseUrl: string;
  secretId: string; // "" = no key
  models: string[];
  label: string;
}

export class App {
  db: DB;
  bus = new Bus();
  vault: Vault;
  svc: Services;
  gateway: Gateway;
  runtime: AgentRuntime;
  triggers: Triggers;
  bridges = new Map<string, SlackBridge>();
  engineJobs = new Map<string, { state: "running" | "done" | "error"; log: string }>();

  cfg: AppConfig;

  constructor(cfg: AppConfig) {
    this.cfg = cfg;
    this.db = openDb(join(cfg.dataDir, "circlechat.db"));
    this.vault = new Vault(cfg.masterKey);
    this.svc = new Services(this.db, this.bus);
    this.gateway = new Gateway(this.db, this.svc, this.vault, { approvalTimeoutMs: cfg.approvalTtlMs });
    this.runtime = new AgentRuntime(this.db, this.svc, this.gateway, this.bus, {
      dataDir: cfg.dataDir,
      idleSleepMs: cfg.idleSleepMs ?? 15 * 60_000,
      turnTimeoutMs: cfg.turnTimeoutMs ?? 20 * 60_000,
      providers: () => this.providers(true) as ModelProvider[],
      workspaceName: () => getSetting(this.db, "workspace_name") ?? "CircleChat",
    });
    this.runtime.approvalTtlMs = cfg.approvalTtlMs;
    this.triggers = new Triggers(this.db, this.svc);
  }

  start(): void {
    // leftovers from a crash go first, then queued work and the warm-up start fresh containers
    const swept = this.cfg.warmOnBoot ? this.runtime.sweepContainers().catch(() => 0) : Promise.resolve(0);
    void swept.then((n) => {
      if (n) console.log(`Removed ${n} agent container${n === 1 ? "" : "s"} left from the last run.`);
      this.runtime.resume();
      if (this.cfg.warmOnBoot) void this.runtime.warmRecent().catch(() => undefined);
    });
    this.triggers.start();
    void this.startBridges();
  }
  async stop(): Promise<void> {
    this.triggers.stop();
    for (const b of this.bridges.values()) b.stop();
    await this.runtime.shutdown();
    await this.gateway.closeAll();
    this.db.close();
  }

  // ---------------------------------------------------------------- model providers (keys live in the vault)
  providers(decrypt = false): (StoredProvider | ModelProvider)[] {
    const list = json<StoredProvider[]>(getSetting(this.db, "providers"), []);
    if (!decrypt) return list.map((p) => ({ ...p, hasKey: !!p.secretId, secretId: undefined }) as any);
    return list.map((p) => ({ id: p.id, kind: p.kind, baseUrl: p.baseUrl, models: p.models, apiKey: p.secretId ? this.gateway.getSecret(p.secretId) : "" }));
  }
  upsertProvider(p: { id: string; kind: ModelProvider["kind"]; baseUrl: string; apiKey?: string; models: string[]; label?: string }): void {
    const list = json<StoredProvider[]>(getSetting(this.db, "providers"), []);
    const existing = list.find((x) => x.id === p.id);
    let secretId = existing?.secretId ?? "";
    if (p.apiKey !== undefined) {
      if (secretId) this.gateway.deleteSecret(secretId);
      secretId = p.apiKey ? this.gateway.putSecret(`provider:${p.id}`, p.apiKey) : "";
    }
    const next: StoredProvider = { id: p.id, kind: p.kind, baseUrl: p.baseUrl, models: p.models, secretId, label: p.label ?? p.id };
    setSetting(this.db, "providers", JSON.stringify([...list.filter((x) => x.id !== p.id), next]));
  }
  removeProvider(pid: string): void {
    const list = json<StoredProvider[]>(getSetting(this.db, "providers"), []);
    const p = list.find((x) => x.id === pid);
    if (p?.secretId) this.gateway.deleteSecret(p.secretId);
    setSetting(this.db, "providers", JSON.stringify(list.filter((x) => x.id !== pid)));
  }

  // ---------------------------------------------------------------- engines
  async engineStatus(): Promise<any[]> {
    const out: any[] = [];
    for (const e of ENGINES) {
      if (e.id.startsWith("mock")) continue;
      let installed = false,
        version = "";
      if (e.image) {
        try {
          const { stdout } = await execFileP("docker", ["image", "inspect", e.image, "--format", '{{index .Config.Labels "circlechat.engine.version"}}'], {
            timeout: 5000,
          });
          installed = true;
          version = stdout.trim();
        } catch {}
      }
      const agents = this.svc
        .agents()
        .filter((a) => a.engine === e.id)
        .map((a) => a.id);
      out.push({
        id: e.id,
        name: e.name,
        vendor: e.vendor,
        description: e.description,
        protocol: e.protocol,
        image: e.image,
        installed,
        version,
        dockerfile: !!dockerfileFor(e.id),
        agents,
        job: this.engineJobs.get(e.id) ?? null,
        providerKinds: e.providerKinds,
      });
    }
    return out;
  }
  installEngine(eid: string): void {
    const e = ENGINES.find((x) => x.id === eid);
    const df = dockerfileFor(eid);
    if (!e || !df) throw new Error("no Dockerfile for that engine");
    if (this.engineJobs.get(eid)?.state === "running") return;
    const job = { state: "running" as const, log: "" };
    this.engineJobs.set(eid, job);
    const p = execFile("docker", ["build", "-t", e.image, "-f", df, join(REPO_ROOT, "engines", eid)], { maxBuffer: 50 * 1024 * 1024 });
    const add = (s: string) => (job.log = (job.log + s).slice(-20000));
    p.stdout?.on("data", add);
    p.stderr?.on("data", add);
    p.on("exit", (code) => this.engineJobs.set(eid, { state: code === 0 ? "done" : "error", log: job.log }));
  }

  // ---------------------------------------------------------------- bridges
  async startBridges(): Promise<void> {
    const rows = this.db.prepare("SELECT * FROM bridges WHERE enabled = 1 AND kind = 'slack'").all() as any[];
    for (const r of rows) await this.startBridge(r.id).catch(() => {});
  }
  async startBridge(bid: string): Promise<void> {
    const r = this.db.prepare("SELECT * FROM bridges WHERE id = ?").get(bid) as any;
    if (!r) throw new Error("no such bridge");
    this.bridges.get(bid)?.stop();
    const cfg = json<any>(r.config, {});
    const tokens = JSON.parse(this.gateway.getSecret(r.secret_id));
    const b = new SlackBridge(
      { id: r.id, chatId: r.chat_id, channel: r.external_id, botToken: tokens.botToken, appToken: tokens.appToken, apiBase: cfg.apiBase },
      this.svc,
      this.bus,
      (aid) => this.svc.agent(aid)?.name ?? "Agent",
    );
    this.bridges.set(bid, b);
    await b.start();
  }
}

export function newMasterKey(): string {
  return token(32);
}
