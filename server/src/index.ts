// SPDX-License-Identifier: AGPL-3.0-only
// CircleChat server entry point.
//   CIRCLECHAT_DATA       data folder (default ./data)
//   CIRCLECHAT_PORT       port (default 3100)
//   CIRCLECHAT_HOST       bind address (default 127.0.0.1)
//   CIRCLECHAT_MASTER_KEY 32-byte base64url key for the vault (created on first run if missing)
//   CIRCLECHAT_AGENT_URL  how agents in containers reach this server (default http://host.docker.internal:<port>)
//   CIRCLECHAT_AGENT_EGRESS  open (default) | none | allowlist: what agent containers may reach (see agents/egress.ts)
//   CIRCLECHAT_AGENT_EGRESS_ALLOW  hosts agents may reach in allowlist mode, e.g. github.com,*.npmjs.org
//   CIRCLECHAT_AGENT_LISTEN  extra address (IP or interface, e.g. docker0) that serves only /mcp/* for agent
//                         containers on Linux, where host.docker.internal is the bridge IP, not loopback
//   CIRCLECHAT_TRUST_PROXY 1 = behind a TLS reverse proxy: honour X-Forwarded-Proto/Host (Secure cookies)
//   CIRCLECHAT_SEED       path to a seed file applied once on first boot, then deleted (see hosting.ts)
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { App, newMasterKey } from "./app.ts";
import { createHttpServer, createAgentServer } from "./server.ts";
import { applySeedFile, resolveListenAddress } from "./hosting.ts";
import { REPO_ROOT } from "./agents/engines.ts";
import { getSetting } from "./db.ts";
import { egressConfigFromEnv, ensureEgress } from "./agents/egress.ts";

const dataDir = resolve(process.env.CIRCLECHAT_DATA ?? join(REPO_ROOT, "data"));
mkdirSync(dataDir, { recursive: true });
const keyFile = join(dataDir, "master.key");
let masterKey = process.env.CIRCLECHAT_MASTER_KEY ?? "";
if (!masterKey) {
  if (existsSync(keyFile)) masterKey = readFileSync(keyFile, "utf8").trim();
  else {
    masterKey = newMasterKey();
    writeFileSync(keyFile, masterKey + "\n", { mode: 0o600 });
    chmodSync(keyFile, 0o600);
    console.log(`Created a new vault key at ${keyFile}. Back it up: without it, stored keys can't be read.`);
  }
}

const port = Number(process.env.CIRCLECHAT_PORT ?? 3100);
const host = process.env.CIRCLECHAT_HOST ?? "127.0.0.1";
const app = new App({ dataDir, masterKey, trustProxy: process.env.CIRCLECHAT_TRUST_PROXY === "1", warmOnBoot: process.env.CIRCLECHAT_WARM_ON_BOOT !== "0" });

if (process.env.CIRCLECHAT_SEED) {
  try {
    const r = applySeedFile(app, process.env.CIRCLECHAT_SEED);
    if (r !== "missing") console.log(`Seed file ${r}.`);
  } catch (e) {
    // a bad seed must not leave a half-made workspace behind silently
    console.error(`Seed file failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

// first run in dev: a local OpenAI-compatible model server can be registered from env
if (process.env.CIRCLECHAT_LOCAL_MODEL_URL && !getSetting(app.db, "providers")) {
  app.upsertProvider({
    id: "local",
    kind: "openai-compatible",
    baseUrl: process.env.CIRCLECHAT_LOCAL_MODEL_URL,
    apiKey: "",
    models: (process.env.CIRCLECHAT_LOCAL_MODELS ?? "").split(",").filter(Boolean),
    label: "Local models",
  });
}

const server = createHttpServer(app);

// Agent containers on Linux: a narrow /mcp/*-only listener on the docker bridge.
const agentListen = process.env.CIRCLECHAT_AGENT_LISTEN ?? "";
const agentPort = Number(process.env.CIRCLECHAT_AGENT_PORT ?? port);
const agentServer = agentListen ? createAgentServer(app) : null;
if (agentServer) {
  const tryListen = () => {
    const addr = resolveListenAddress(agentListen);
    if (!addr) {
      // docker0 appears when docker starts; keep trying rather than failing the whole server
      console.log(`Waiting for ${agentListen} to have an address for the agent gateway...`);
      return void setTimeout(tryListen, 5000).unref();
    }
    agentServer.once("error", (e) => {
      console.error(`Agent gateway listener on ${addr}:${agentPort} failed: ${e.message}. Retrying.`);
      setTimeout(tryListen, 5000).unref();
    });
    agentServer.listen(agentPort, addr, () => console.log(`Agent gateway (tools only) on http://${addr}:${agentPort}/mcp/`));
  };
  tryListen();
}
server.listen(port, host, async () => {
  app.gateway.publicUrl = `http://127.0.0.1:${port}`;
  app.gateway.agentReachableUrl = process.env.CIRCLECHAT_AGENT_URL ?? `http://host.docker.internal:${agentPort}`;
  // network limits for agent containers: set up before any agent starts, and fail closed
  try {
    const eg = egressConfigFromEnv();
    if (eg.mode !== "open") {
      app.runtime.egressPending = true;
      const u = new URL(app.gateway.agentReachableUrl);
      app.runtime.egress = await ensureEgress(eg, dataDir, [`${u.hostname}:${u.port || (u.protocol === "https:" ? 443 : 80)}`]);
      console.log(`Agent network: ${eg.mode}${eg.allow.length ? ` (${eg.allow.join(", ")})` : ""}, through ${app.runtime.egress?.network}`);
    }
  } catch (e) {
    app.runtime.egressError = (e as Error).message;
    console.error(`Agent network limits could not be set up, so agents won't start: ${app.runtime.egressError}`);
  } finally {
    app.runtime.egressPending = false;
  }
  app.start();
  console.log(`CircleChat is running on http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
});

const shutdown = async () => {
  server.close();
  agentServer?.close();
  await app.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
