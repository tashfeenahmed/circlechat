// SPDX-License-Identifier: AGPL-3.0-only
// Engine definitions: how to start each CLI agent so it speaks ACP on stdio,
// either inside its own Docker sandbox or (dev only) as a local process.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");

export interface ModelProvider {
  id: string; // "local" | "anthropic" | "openai" | "openrouter" | custom
  kind: "openai-compatible" | "anthropic" | "openai";
  baseUrl: string;
  apiKey: string; // engines get CircleChat's model proxy token here, not the provider's key (see modelproxy.ts)
  models: string[];
}

export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** docker named volumes for engine state that needs a real Linux filesystem */
  volumes?: { name: string; target: string }[];
}

export interface EngineContext {
  agentId: string;
  handle: string;
  home: string; // host path of the agent's home folder
  work: string; // host path of the agent's working folder
  model: string;
  provider?: ModelProvider;
  sandbox: "docker" | "local";
  /** agent-wide CircleChat MCP endpoint, for engines that can't take MCP servers per session */
  agentMcpUrl?: string;
}

export interface EngineDef {
  id: string;
  name: string;
  vendor: string;
  description: string;
  image: string; // docker image tag, built from engines/<id>/Dockerfile
  protocol: "acp" | "acp-adapter";
  providerKinds: ModelProvider["kind"][]; // which providers it can use
  defaultModel: string;
  /** false: the engine rejects per-session MCP servers, so tools are wired into its config at launch */
  sessionMcp?: boolean;
  /** false: the engine can only call its vendor directly, so it gets the real key instead of the model proxy */
  modelProxy?: boolean;
  /** Smallest container memory the engine runs in, e.g. "4g". The sandbox_memory setting can raise it, not lower it. */
  minMemory?: string;
  /** Write any engine config into the agent home, then say how to start it. */
  launch(ctx: EngineContext): LaunchSpec;
}

const require = createRequire(import.meta.url);
function resolveBin(pkg: string, rel: string): string | null {
  try {
    return join(dirname(require.resolve(`${pkg}/package.json`)), rel);
  } catch {
    return null;
  }
}

function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Path the engine sees for the agent home: /home/agent in docker, the real folder locally. */
function homeFor(ctx: EngineContext): string {
  return ctx.sandbox === "docker" ? "/home/agent" : ctx.home;
}
function workFor(ctx: EngineContext): string {
  return ctx.sandbox === "docker" ? "/home/agent/work" : ctx.work;
}
function openaiBase(p?: ModelProvider): string {
  return (p?.baseUrl ?? "").replace(/\/+$/, "");
}

export const ENGINES: EngineDef[] = [
  {
    id: "hermes",
    name: "Hermes Agent",
    vendor: "Nous Research",
    description: "Learns skills, remembers, any model",
    image: "circlechat/engine-hermes:latest",
    protocol: "acp",
    providerKinds: ["openai-compatible", "anthropic", "openai"],
    defaultModel: "local",
    launch(ctx) {
      const hh = ensure(join(ctx.home, ".hermes"));
      const p = ctx.provider;
      // Hermes reads ~/.hermes/config.yaml and ~/.hermes/.env
      const model = ctx.model || p?.models[0] || "";
      writeFileSync(
        join(hh, "config.yaml"),
        [
          "model:",
          `  default: ${JSON.stringify(model)}`,
          `  provider: ${p?.kind === "anthropic" ? "anthropic" : "custom"}`,
          p && (p.kind !== "anthropic" || p.baseUrl) ? `  base_url: ${JSON.stringify(openaiBase(p))}` : "",
          p && p.kind !== "anthropic" ? `  api_key: ${JSON.stringify(p.apiKey || "none")}` : "",
          "terminal:",
          "  backend: local",
          `  cwd: ${JSON.stringify(workFor(ctx))}`,
          "approvals:",
          "  mode: manual",
          "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      writeFileSync(
        join(hh, ".env"),
        p?.apiKey
          ? p.kind === "anthropic"
            ? `ANTHROPIC_API_KEY=${p.apiKey}\n${p.baseUrl ? `ANTHROPIC_BASE_URL=${p.baseUrl}\n` : ""}`
            : `OPENAI_API_KEY=${p.apiKey}\n`
          : "OPENAI_API_KEY=none\n",
      );
      if (ctx.sandbox === "docker") return { command: "cc-hermes-acp", args: [], env: { HERMES_HOME: "/var/lib/hermes/home" }, cwd: workFor(ctx), volumes: [{ name: "hermes", target: "/var/lib/hermes" }] };
      return { command: "hermes-acp", args: [], env: { HERMES_HOME: join(homeFor(ctx), ".hermes") }, cwd: workFor(ctx) };
    },
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    vendor: "OpenClaw",
    description: "Big skill library, personal-style agent",
    image: "circlechat/engine-openclaw:latest",
    protocol: "acp",
    providerKinds: ["openai-compatible", "anthropic", "openai"],
    defaultModel: "local",
    sessionMcp: false,
    minMemory: "4g", // gateway + worker threads + ACP bridge; 2g gets OOM-killed on the first turn
    launch(ctx) {
      const oc = ensure(join(ctx.home, ".openclaw"));
      const p = ctx.provider;
      const model = ctx.model || p?.models[0] || "";
      const cfg: any = {
        agents: { defaults: { workspace: workFor(ctx), model: { primary: p?.kind === "anthropic" ? `anthropic/${model}` : `circlechat/${model}` } } },
        skills: { allowBundled: [] }, // reviewed skills only: nothing from ClawHub unless added
      };
      if (p && p.kind !== "anthropic") {
        cfg.models = {
          providers: {
            circlechat: { baseUrl: openaiBase(p), apiKey: p.apiKey || "none", api: "openai-completions", timeoutSeconds: 600, models: [{ id: model, name: model, input: ["text"] }] },
          },
        };
      }
      if (ctx.agentMcpUrl) cfg.mcp = { servers: { circlechat: { url: ctx.agentMcpUrl, transport: "streamable-http", requestTimeoutMs: 24 * 3600 * 1000 } } };
      writeFileSync(join(oc, "openclaw.json"), JSON.stringify(cfg, null, 2));
      return {
        command: "cc-openclaw-acp",
        args: [],
        env: {
          OPENCLAW_STATE_DIR: join(homeFor(ctx), ".openclaw"),
          ...(p?.kind === "anthropic" ? { ANTHROPIC_API_KEY: p.apiKey, ...(p.baseUrl ? { ANTHROPIC_BASE_URL: p.baseUrl } : {}) } : {}),
        },
        cwd: workFor(ctx),
      };
    },
  },
  {
    id: "claude",
    name: "Claude Code",
    vendor: "Anthropic",
    description: "Best for code and long tasks",
    image: "circlechat/engine-claude:latest",
    protocol: "acp-adapter",
    providerKinds: ["anthropic"],
    defaultModel: "",
    launch(ctx) {
      const env: Record<string, string> = {};
      if (ctx.provider?.apiKey) env.ANTHROPIC_API_KEY = ctx.provider.apiKey;
      if (ctx.provider?.baseUrl) env.ANTHROPIC_BASE_URL = ctx.provider.baseUrl;
      if (ctx.model) env.ANTHROPIC_MODEL = ctx.model;
      if (ctx.sandbox === "local") {
        // Dev mode: run the ACP adapter on this machine with the user's own Claude Code login.
        const bin = resolveBin("@agentclientprotocol/claude-agent-acp", "dist/index.js");
        if (!bin) throw new Error("claude-agent-acp is not installed (npm i in server/)");
        return { command: process.execPath, args: [bin], env, cwd: ctx.work };
      }
      return { command: "claude-agent-acp", args: [], env, cwd: workFor(ctx) };
    },
  },
  {
    id: "opencode",
    name: "opencode",
    vendor: "Anomaly",
    description: "Open source, fast, any model",
    image: "circlechat/engine-opencode:latest",
    protocol: "acp",
    providerKinds: ["openai-compatible", "anthropic", "openai"],
    defaultModel: "local",
    launch(ctx) {
      const p = ctx.provider;
      const model = ctx.model || p?.models[0] || "";
      const cfgPath = join(ensure(join(ctx.home, ".config", "opencode")), "opencode.json");
      const cfg: any = { $schema: "https://opencode.ai/config.json", autoupdate: false, share: "disabled" };
      if (p && p.kind === "openai-compatible") {
        cfg.provider = {
          circlechat: {
            npm: "@ai-sdk/openai-compatible",
            name: "CircleChat models",
            options: { baseURL: openaiBase(p), apiKey: p.apiKey || "none" },
            models: Object.fromEntries((p.models.length ? p.models : [model]).map((m) => [m, { name: m }])),
          },
        };
        cfg.model = `circlechat/${model}`;
      } else if (p?.kind === "anthropic") {
        cfg.model = `anthropic/${model}`;
        if (p.baseUrl) cfg.provider = { anthropic: { options: { baseURL: `${openaiBase(p)}/v1`, apiKey: p.apiKey } } };
      } else if (p?.kind === "openai") {
        cfg.model = `openai/${model}`;
        if (p.baseUrl) cfg.provider = { openai: { options: { baseURL: openaiBase(p), apiKey: p.apiKey } } };
      }
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      const env: Record<string, string> = { OPENCODE_CONFIG: ctx.sandbox === "docker" ? "/home/agent/.config/opencode/opencode.json" : cfgPath };
      if (p?.kind === "anthropic") env.ANTHROPIC_API_KEY = p.apiKey;
      if (p?.kind === "openai") env.OPENAI_API_KEY = p.apiKey;
      return { command: "opencode", args: ["acp"], env, cwd: workFor(ctx) };
    },
  },
  {
    id: "codex",
    name: "Codex CLI",
    vendor: "OpenAI",
    description: "Strong at code",
    image: "circlechat/engine-codex:latest",
    protocol: "acp-adapter",
    providerKinds: ["openai", "openai-compatible"],
    defaultModel: "gpt-5",
    launch(ctx) {
      const env: Record<string, string> = { CODEX_HOME: join(homeFor(ctx), ".codex") };
      if (ctx.provider?.apiKey) env.OPENAI_API_KEY = ctx.provider.apiKey;
      if (ctx.provider?.baseUrl) env.OPENAI_BASE_URL = openaiBase(ctx.provider);
      return { command: "codex-acp", args: [], env, cwd: workFor(ctx) };
    },
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    vendor: "Google",
    description: "Large context, free tier",
    image: "circlechat/engine-gemini:latest",
    protocol: "acp",
    providerKinds: ["openai-compatible"],
    defaultModel: "gemini-2.5-pro",
    modelProxy: false, // Gemini CLI only calls Google; it gets the key itself
    launch(ctx) {
      const env: Record<string, string> = {};
      if (ctx.provider?.apiKey) env.GEMINI_API_KEY = ctx.provider.apiKey;
      return { command: "gemini", args: ["--acp"], env, cwd: workFor(ctx) };
    },
  },
  {
    id: "goose",
    name: "goose",
    vendor: "AAIF",
    description: "Open source, extensions, any model",
    image: "circlechat/engine-goose:latest",
    protocol: "acp",
    providerKinds: ["openai-compatible", "anthropic", "openai"],
    defaultModel: "local",
    launch(ctx) {
      const p = ctx.provider;
      const env: Record<string, string> = {};
      if (p?.kind === "openai-compatible")
        Object.assign(env, {
          GOOSE_PROVIDER: "openai",
          OPENAI_HOST: openaiBase(p).replace(/\/v1$/, ""),
          OPENAI_API_KEY: p.apiKey || "none",
          GOOSE_MODEL: ctx.model || p.models[0] || "",
        });
      if (p?.kind === "anthropic")
        Object.assign(env, { GOOSE_PROVIDER: "anthropic", ANTHROPIC_API_KEY: p.apiKey, GOOSE_MODEL: ctx.model, ...(p.baseUrl ? { ANTHROPIC_HOST: p.baseUrl } : {}) });
      return { command: "goose", args: ["acp"], env, cwd: workFor(ctx) };
    },
  },
  {
    id: "mock",
    name: "Test engine",
    vendor: "CircleChat",
    description: "Deterministic ACP agent used by the test suite",
    image: "",
    protocol: "acp",
    providerKinds: ["openai-compatible"],
    defaultModel: "",
    launch(ctx) {
      const script = join(REPO_ROOT, "tools", "mock-agent.ts");
      return { command: process.execPath, args: [script], env: { MOCK_AGENT_NAME: ctx.handle }, cwd: ctx.work };
    },
  },
];

// Same test agent, but with tools wired at launch (like OpenClaw) instead of per session.
ENGINES.push({
  ...ENGINES.find((e) => e.id === "mock")!,
  id: "mock-gw",
  name: "Test engine (agent-wide tools)",
  sessionMcp: false,
  launch(ctx) {
    const script = join(REPO_ROOT, "tools", "mock-agent.ts");
    return { command: process.execPath, args: [script], env: { MOCK_AGENT_NAME: ctx.handle, MOCK_AGENT_MCP_URL: ctx.agentMcpUrl ?? "" }, cwd: ctx.work };
  },
});

export function engineById(id: string): EngineDef | undefined {
  return ENGINES.find((e) => e.id === id);
}

export function agentDirs(dataDir: string, agentId: string): { home: string; work: string } {
  const home = ensure(join(dataDir, "agents", agentId, "home"));
  const work = ensure(join(home, "work"));
  return { home, work };
}

export function dockerfileFor(engineId: string): string | null {
  const p = join(REPO_ROOT, "engines", engineId, "Dockerfile");
  return existsSync(p) ? p : null;
}

/** "512m", "2g", "1.5G" -> bytes. Unknown formats count as 0. */
export function memBytes(v: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i.exec(v.trim());
  if (!m) return 0;
  return Math.round(Number(m[1]) * ({ "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 } as Record<string, number>)[m[2].toLowerCase()]);
}
/** Container memory for an engine: the larger of the workspace setting and the engine's minimum. */
export function sandboxMemory(engine: EngineDef, setting: string | undefined): string {
  const want = setting ?? "2g";
  return engine.minMemory && memBytes(engine.minMemory) > memBytes(want) ? engine.minMemory : want;
}
