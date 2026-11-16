// SPDX-License-Identifier: AGPL-3.0-only
// Network limits for agent containers.
//   CIRCLECHAT_AGENT_EGRESS=open        (default) Docker's normal network: agents reach the internet
//   CIRCLECHAT_AGENT_EGRESS=none        agents reach only CircleChat (its tools and model proxy)
//   CIRCLECHAT_AGENT_EGRESS=allowlist   ...plus the hosts in CIRCLECHAT_AGENT_EGRESS_ALLOW
// For "none" and "allowlist", agent containers join a Docker network with no route out
// (--internal), get no outside name lookups (--dns 127.0.0.1), and reach the world only
// through a small filter container (egress/proxy.mjs) that is on both networks.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { REPO_ROOT } from "./engines.ts";

const execFileP = promisify(execFile);
const docker = (args: string[], timeout = 60_000) => execFileP("docker", args, { timeout, maxBuffer: 20 * 1024 * 1024 }).then((r) => r.stdout.trim());

export type EgressMode = "open" | "none" | "allowlist";
export interface EgressConfig {
  mode: EgressMode;
  allow: string[];
}
export interface Egress {
  network: string;
  proxyUrl: string;
}

const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export function egressConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EgressConfig {
  const raw = (env.CIRCLECHAT_AGENT_EGRESS ?? "open").trim().toLowerCase();
  const mode: EgressMode = raw === "none" || raw === "allowlist" ? raw : "open";
  const allow = (env.CIRCLECHAT_AGENT_EGRESS_ALLOW ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const h of allow) if (!HOST.test(h)) throw new Error(`CIRCLECHAT_AGENT_EGRESS_ALLOW: "${h}" isn't a host name (use names like github.com or *.npmjs.org)`);
  if (mode === "allowlist" && !allow.length) throw new Error("CIRCLECHAT_AGENT_EGRESS=allowlist needs CIRCLECHAT_AGENT_EGRESS_ALLOW");
  return { mode, allow: mode === "allowlist" ? allow : [] };
}

/**
 * Make sure the closed network and the filter container exist and match the config.
 * `scope` keeps several CircleChat servers on one host apart; `always` is the host:port
 * agents use to reach CircleChat. Returns null in open mode.
 */
export async function ensureEgress(cfg: EgressConfig, scope: string, always: string[]): Promise<Egress | null> {
  if (cfg.mode === "open") return null;
  const h = createHash("sha256").update(scope).digest("hex").slice(0, 10);
  const network = `cc-agents-${h}`;
  const name = `cc-egress-${h}`;
  const src = join(REPO_ROOT, "egress");
  const imageTag = createHash("sha256")
    .update(readFileSync(join(src, "Dockerfile")))
    .update(readFileSync(join(src, "proxy.mjs")))
    .digest("hex")
    .slice(0, 12);
  const image = `circlechat/egress:${imageTag}`;
  const want = createHash("sha256").update(JSON.stringify({ image, always, allow: cfg.allow })).digest("hex").slice(0, 12);

  if (!(await docker(["images", "-q", image]))) await docker(["build", "-t", image, src], 10 * 60_000);
  if (!(await docker(["network", "ls", "-q", "--filter", `name=^${network}$`]))) await docker(["network", "create", "--internal", network]);

  const have = await docker(["ps", "-a", "--filter", `name=^${name}$`, "--format", '{{.Label "circlechat.egress"}} {{.State}}']);
  const [label, state] = have.split(" ");
  if (have && (label !== want || state !== "running")) await docker(["rm", "-f", name]);
  if (!have || label !== want || state !== "running") {
    await docker([
      "run", "-d", "--name", name, "--restart", "unless-stopped",
      "--label", `circlechat.egress=${want}`,
      "--add-host", "host.docker.internal:host-gateway",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "128m", "--pids-limit", "256",
      "-e", `ALWAYS=${always.join(",")}`,
      "-e", `ALLOW=${cfg.allow.join(",")}`,
      image,
    ]);
    await docker(["network", "connect", "--alias", "egress", network, name]);
  }
  return { network, proxyUrl: "http://egress:3128" };
}

/** docker run arguments that put an agent behind the filter. */
export function egressDockerArgs(e: Egress | null): string[] {
  if (!e) return [];
  const p = e.proxyUrl;
  const env = { HTTP_PROXY: p, HTTPS_PROXY: p, http_proxy: p, https_proxy: p, ALL_PROXY: p, NO_PROXY: "", no_proxy: "", NODE_USE_ENV_PROXY: "1" };
  return [
    "--network", e.network,
    // Docker still answers for its own network's names (egress); every other lookup fails,
    // so nothing can leave inside a DNS query
    "--dns", "127.0.0.1",
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
  ];
}
