import { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { db } from "../db/index.js";
import {
  agents,
  members,
  conversationMembers,
  workspaceMembers,
} from "../db/schema.js";
import { requireWorkspace } from "../auth/session.js";
import { id, rawToken } from "../lib/ids.js";
import { scheduleAgentHeartbeat } from "../agents/scheduler.js";
import {
  installCircleChatTooling,
  resolveHermesHome,
  quarantineBundledSkills,
  restoreQuarantinedSkills,
} from "../agents/hermes-equip.js";
import { HERMES_RUNTIME, buildHermesCommand } from "../agents/hermes-runtime.js";
import { buildOpenClawCommand } from "../agents/openclaw-runtime.js";
import { equipOpenClawAgent } from "../agents/openclaw-equip.js";

// Where Hermes per-agent homes live and where the multi-bridge reads its
// connection list. Both are overridable for dev.
const HERMES_HOMES_DIR = process.env.HERMES_HOMES_DIR ?? homedir();
const BRIDGE_CONFIG_PATH =
  process.env.CC_BRIDGE_CONFIG_PATH ??
  join(process.cwd(), "bridge-config.json");
// `hermes setup` requires a TTY, so we bootstrap HERMES_HOME by copying a
// pre-baked config.yaml template. Override via HERMES_CONFIG_TEMPLATE for a
// non-default path.
const HERMES_CONFIG_TEMPLATE =
  process.env.HERMES_CONFIG_TEMPLATE ??
  pathResolve(process.cwd(), "templates/hermes-config.yaml");

const InstallOpenClawBody = z.object({
  name: z.string().min(1).max(100),
  handle: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9._-]*$/i),
  title: z.string().max(160).optional(),
  brief: z.string().max(2000).optional(),
  // OpenClaw maps these onto its --auth-choice/--*-api-key flags; see the
  // install-openclaw handler for the providerMap.
  provider: z
    .enum(["anthropic", "openai-codex", "openrouter", "custom:freeapi"])
    .default("custom:freeapi"),
  apiKey: z.string().min(10).max(400),
  apiBaseUrl: z.string().url().max(400).optional(),
  model: z.string().max(120).optional(),
  heartbeatIntervalSec: z.number().int().min(15).max(3600).optional(),
  channelIds: z.array(z.string()).optional(),
  // Optional member id the new agent should report to in the org chart —
  // wired by the "+ Add report" PLUS block on /org.
  reportsTo: z.string().max(32).nullable().optional(),
});

const InstallHermesBody = z.object({
  name: z.string().min(1).max(100),
  handle: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9._-]*$/i),
  title: z.string().max(160).optional(),
  brief: z.string().max(2000).optional(),
  provider: z
    .enum(["anthropic", "openai-codex", "openrouter", "nous", "custom:freeapi"])
    .default("nous"),
  apiKey: z.string().min(10).max(400),
  apiKeyLabel: z.string().max(80).optional(),
  // Required when provider === "custom:freeapi" — user's self-hosted
  // FreeLLMAPI endpoint, stored in HERMES_HOME/config.yaml:custom_providers.
  apiBaseUrl: z.string().url().max(400).optional(),
  model: z.string().max(120).optional(),
  heartbeatIntervalSec: z.number().int().min(15).max(3600).optional(),
  channelIds: z.array(z.string()).optional(),
  reportsTo: z.string().max(32).nullable().optional(),
});

export default async function agentInstallRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireWorkspace);

  // POST /api/agents/install-hermes — creates a brand-new Hermes agent that
  // runs on THIS server. End-to-end:
  //   1. sanity-check handle, admin role
  //   2. mint a bot token + HERMES_HOME
  //   3. run `hermes setup --non-interactive` to scaffold config
  //   4. `hermes auth add <provider> --type api-key --api-key <key>`
  //   5. `hermes config set model.default <model>` (if provided)
  //   6. insert agent + member rows, auto-join channels
  //   7. append entry to bridge-config.json — the multi-bridge watches this
  //      file and will pick up the new agent within a second
  app.post("/agents/install-hermes", async (req, reply) => {
    const body = InstallHermesBody.parse(req.body);
    const { workspaceId, memberId, user } = req.auth!;

    // Admin-only
    const [wm] = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, user.id),
          eq(workspaceMembers.workspaceId, workspaceId!),
        ),
      )
      .limit(1);
    if (!wm || wm.role !== "admin") return reply.code(403).send({ error: "not_admin" });

    // Handle unique per-workspace
    const [existH] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(eq(agents.workspaceId, workspaceId!), eq(agents.handle, body.handle)),
      )
      .limit(1);
    if (existH) return reply.code(409).send({ error: "handle_in_use" });

    const agentId = id("a");
    const botToken = `cc_${rawToken(32)}`;
    const hermesHome = join(HERMES_HOMES_DIR, `.hermes-${body.handle}`);

    // Reject if the target directory already exists to avoid clobbering a
    // pre-existing Hermes install — the operator can "attach existing" instead.
    try {
      await fs.stat(hermesHome);
      return reply
        .code(409)
        .send({ error: "hermes_home_exists", path: hermesHome });
    } catch {
      // Expected: not found.
    }

    await fs.mkdir(hermesHome, { recursive: true });
    // Under docker, the container runs with its own `hermes` user (uid 10000)
    // and the entrypoint needs write access to the mounted HERMES_HOME. Give
    // the dir open permissions so both root and the hermes user inside the
    // container can bootstrap it without a chown dance.
    if (HERMES_RUNTIME === "docker") {
      try { await fs.chmod(hermesHome, 0o777); } catch { /* ignore */ }
    }

    const isFreeApi = body.provider === "custom:freeapi";
    if (isFreeApi && !body.apiBaseUrl) {
      return reply
        .code(400)
        .send({ error: "freeapi_base_url_required" });
    }

    try {
      // Copy the baked template — hermes setup needs a TTY which we don't
      // have, so we pre-seed config.yaml instead. Subsequent `hermes auth add`
      // and `hermes config set` calls are non-interactive and work fine.
      const tmpl = await fs.readFile(HERMES_CONFIG_TEMPLATE, "utf8");
      const configPath = join(hermesHome, "config.yaml");
      if (isFreeApi) {
        // FreeLLMAPI is an OpenAI-compatible endpoint declared under
        // `custom_providers` in Hermes config, NOT via `hermes auth add`. Replace
        // the empty `custom_providers: []` placeholder with the user's entry.
        const patched = tmpl.replace(
          /^custom_providers:\s*\[\]\s*$/m,
          [
            "custom_providers:",
            "- name: freeapi",
            `  base_url: ${JSON.stringify(body.apiBaseUrl)}`,
            `  api_key: ${JSON.stringify(body.apiKey)}`,
            "  api_mode: chat_completions",
          ].join("\n"),
        );
        await fs.writeFile(configPath, patched);
      } else {
        await fs.writeFile(configPath, tmpl);
        const authCmd = buildHermesCommand(hermesHome, [
          "auth",
          "add",
          body.provider,
          "--type",
          "api-key",
          "--api-key",
          body.apiKey,
          ...(body.apiKeyLabel ? ["--label", body.apiKeyLabel] : []),
        ]);
        await runCmd(authCmd.cmd, authCmd.args, authCmd.env);
      }
      const setProviderCmd = buildHermesCommand(hermesHome, [
        "config",
        "set",
        "model.provider",
        body.provider,
      ]);
      await runCmd(setProviderCmd.cmd, setProviderCmd.args, setProviderCmd.env);
      if (body.model) {
        const setModelCmd = buildHermesCommand(hermesHome, [
          "config",
          "set",
          "model.default",
          body.model,
        ]);
        await runCmd(setModelCmd.cmd, setModelCmd.args, setModelCmd.env);
      }
      // Skill + MCP install MUST happen before any other docker command that
      // might invoke the image's entrypoint, because skills_sync runs as the
      // container's root user and flips every created subdir to uid=10000.
      // Once that has happened, node (running as pi) can't copyDir into
      // skills/. Doing it here — while skills/ was only just pre-seeded by
      // auth add / config set with the manifest-aware sync — keeps our
      // circlechat dir writable by the subsequent mcp add path.
    } catch (e) {
      // Clean up the half-created HERMES_HOME on failure so a retry with the
      // same handle can proceed.
      try {
        await fs.rm(hermesHome, { recursive: true, force: true });
      } catch { /* ignore */ }
      return reply
        .code(500)
        .send({ error: "hermes_setup_failed", detail: (e as Error).message.slice(0, 400) });
    }

    await db.insert(agents).values({
      id: agentId,
      workspaceId: workspaceId!,
      handle: body.handle,
      name: body.name,
      kind: "hermes",
      adapter: "socket",
      configJson: {},
      model: body.model ?? "",
      scopes: ["channels.read", "channels.reply"],
      status: "provisioning",
      title: body.title ?? "",
      brief: body.brief ?? "",
      botToken,
      heartbeatIntervalSec: body.heartbeatIntervalSec ?? 180,
      callbackUrl: null,
      createdBy: memberId!,
      avatarColor: pickColor(body.handle),
    });

    const agentMemberId = id("m");
    await db.insert(members).values({
      id: agentMemberId,
      workspaceId: workspaceId!,
      kind: "agent",
      refId: agentId,
      reportsTo: body.reportsTo ?? null,
    });

    if (body.channelIds?.length) {
      await db
        .insert(conversationMembers)
        .values(
          body.channelIds.map((cid) => ({
            conversationId: cid,
            memberId: agentMemberId,
            role: "member" as const,
          })),
        )
        .onConflictDoNothing();
    }

    // Append to bridge-config.json so the multi-bridge picks up the new agent.
    // Use a simple lock-file-free approach: read + append + write. The bridge
    // watches the file via watchFile; one write = one reconcile.
    let cfg: Array<Record<string, unknown>> = [];
    try {
      const raw = await fs.readFile(BRIDGE_CONFIG_PATH, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) cfg = parsed;
    } catch { /* file may not exist yet */ }
    cfg = cfg.filter((e) => (e as { handle?: string }).handle !== body.handle);
    cfg.push({
      handle: body.handle,
      name: body.name,
      title: body.title ?? "",
      token: botToken,
      hermesHome,
      agentId,
    });
    await fs.writeFile(BRIDGE_CONFIG_PATH, JSON.stringify(cfg, null, 2));

    await scheduleAgentHeartbeat(agentId, body.heartbeatIntervalSec ?? 180);

    const equip = await installCircleChatTooling({ hermesHome, botToken });
    if (equip.notes.length) req.log.warn({ notes: equip.notes }, "circlechat tooling install notes");

    return {
      id: agentId,
      memberId: agentMemberId,
      handle: body.handle,
      hermesHome,
      botToken,
      skillInstalled: equip.skillInstalled,
      mcpRegistered: equip.mcpRegistered,
    };
  });

  // POST /api/agents/install-openclaw — creates a brand-new OpenClaw agent
  // that runs on this server via the alpine/openclaw Docker image. Mirrors
  // install-hermes: sanity-check, mint token, `openclaw onboard` in a clean
  // state dir, drop the CircleChat MCP stdio bridge into the config, add to
  // bridge-config.json, schedule heartbeat.
  app.post("/agents/install-openclaw", async (req, reply) => {
    const body = InstallOpenClawBody.parse(req.body);
    const { workspaceId, memberId, user } = req.auth!;

    const [wm] = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, user.id),
          eq(workspaceMembers.workspaceId, workspaceId!),
        ),
      )
      .limit(1);
    if (!wm || wm.role !== "admin") return reply.code(403).send({ error: "not_admin" });

    const [existH] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(eq(agents.workspaceId, workspaceId!), eq(agents.handle, body.handle)),
      )
      .limit(1);
    if (existH) return reply.code(409).send({ error: "handle_in_use" });

    const agentId = id("a");
    const botToken = `cc_${rawToken(32)}`;
    const openclawHome = join(HERMES_HOMES_DIR, `.openclaw-${body.handle}`);

    try {
      await fs.stat(openclawHome);
      return reply.code(409).send({ error: "openclaw_home_exists", path: openclawHome });
    } catch {
      /* Expected: not found. */
    }

    await fs.mkdir(openclawHome, { recursive: true });
    // Container runs as root (0:0) so it can create files under /root/.openclaw;
    // open perms so the host-side `fs.copyFile` for the MCP script also works.
    try { await fs.chmod(openclawHome, 0o777); } catch { /* ignore */ }

    const isFreeApi = body.provider === "custom:freeapi";
    if (isFreeApi && !body.apiBaseUrl) {
      return reply.code(400).send({ error: "freeapi_base_url_required" });
    }

    try {
      const onboardArgs = [
        "onboard",
        "--accept-risk",
        "--non-interactive",
        "--flow",
        "manual",
        "--skip-channels",
        "--skip-health",
        "--skip-search",
        "--skip-skills",
        "--skip-daemon",
        "--skip-ui",
        "--json",
      ];
      if (isFreeApi) {
        onboardArgs.push(
          "--auth-choice",
          "custom-api-key",
          "--custom-api-key",
          body.apiKey,
          "--custom-base-url",
          body.apiBaseUrl!,
          "--custom-compatibility",
          "openai",
          "--custom-provider-id",
          "freeapi",
        );
        if (body.model) onboardArgs.push("--custom-model-id", body.model);
      } else {
        // Map circlechat provider ids → openclaw's auth-choice + per-provider
        // key flag. openclaw has distinct flags per provider rather than a
        // single --api-key.
        const providerMap: Record<string, { choice: string; keyFlag: string }> = {
          anthropic: { choice: "anthropic-api-key", keyFlag: "--anthropic-api-key" },
          "openai-codex": { choice: "openai-api-key", keyFlag: "--openai-api-key" },
          openrouter: { choice: "openrouter-api-key", keyFlag: "--openrouter-api-key" },
        };
        const mapped = providerMap[body.provider];
        if (!mapped) {
          return reply.code(400).send({
            error: "unsupported_openclaw_provider",
            detail: `provider '${body.provider}' has no openclaw mapping`,
          });
        }
        onboardArgs.push("--auth-choice", mapped.choice, mapped.keyFlag, body.apiKey);
      }

      const onboardCmd = buildOpenClawCommand(openclawHome, onboardArgs);
      await runCmd(onboardCmd.cmd, onboardCmd.args, onboardCmd.env);
    } catch (e) {
      try { await fs.rm(openclawHome, { recursive: true, force: true }); } catch { /* ignore */ }
      return reply
        .code(500)
        .send({ error: "openclaw_setup_failed", detail: (e as Error).message.slice(0, 400) });
    }

    await db.insert(agents).values({
      id: agentId,
      workspaceId: workspaceId!,
      handle: body.handle,
      name: body.name,
      kind: "openclaw",
      adapter: "socket",
      configJson: {},
      model: body.model ?? "",
      scopes: ["channels.read", "channels.reply"],
      status: "provisioning",
      title: body.title ?? "",
      brief: body.brief ?? "",
      botToken,
      heartbeatIntervalSec: body.heartbeatIntervalSec ?? 180,
      callbackUrl: null,
      createdBy: memberId!,
      avatarColor: pickColor(body.handle),
    });

    const agentMemberId = id("m");
    await db.insert(members).values({
      id: agentMemberId,
      workspaceId: workspaceId!,
      kind: "agent",
      refId: agentId,
      reportsTo: body.reportsTo ?? null,
    });

    if (body.channelIds?.length) {
      await db
        .insert(conversationMembers)
        .values(
          body.channelIds.map((cid) => ({
            conversationId: cid,
            memberId: agentMemberId,
            role: "member" as const,
          })),
        )
        .onConflictDoNothing();
    }

    let cfg: Array<Record<string, unknown>> = [];
    try {
      const raw = await fs.readFile(BRIDGE_CONFIG_PATH, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) cfg = parsed;
    } catch { /* file may not exist yet */ }
    cfg = cfg.filter((e) => (e as { handle?: string }).handle !== body.handle);
    cfg.push({
      handle: body.handle,
      name: body.name,
      title: body.title ?? "",
      token: botToken,
      kind: "openclaw",
      openclawHome,
      agentId,
    });
    await fs.writeFile(BRIDGE_CONFIG_PATH, JSON.stringify(cfg, null, 2));

    await scheduleAgentHeartbeat(agentId, body.heartbeatIntervalSec ?? 180);

    const equip = await equipOpenClawAgent({ openclawHome, botToken });
    if (equip.notes.length) req.log.warn({ notes: equip.notes }, "openclaw tooling install notes");

    return {
      id: agentId,
      memberId: agentMemberId,
      handle: body.handle,
      openclawHome,
      botToken,
      mcpRegistered: equip.mcpRegistered,
    };
  });

  // POST /api/agents/:id/equip — (re)install the circlechat skill + MCP into
  // an existing Hermes-kind agent's HERMES_HOME. Used to backfill agents that
  // were created before the MCP/skill auto-install landed, or to reset after
  // a user edits things manually. Admin-only.
  app.post("/agents/:id/equip", async (req, reply) => {
    const aId = (req.params as { id: string }).id;
    const { workspaceId, user } = req.auth!;

    const [wm] = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, user.id),
          eq(workspaceMembers.workspaceId, workspaceId!),
        ),
      )
      .limit(1);
    if (!wm || wm.role !== "admin") return reply.code(403).send({ error: "not_admin" });

    const [a] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, aId), eq(agents.workspaceId, workspaceId!)))
      .limit(1);
    if (!a) return reply.code(404).send({ error: "not_found" });
    if (a.kind !== "hermes") return reply.code(400).send({ error: "only_hermes_supported" });

    const hermesHome = await resolveHermesHome(a.id, a.handle);
    const equip = await installCircleChatTooling({ hermesHome, botToken: a.botToken });
    return equip;
  });

  // POST /api/agents/:id/quarantine-bundled-skills — move every non-CC skill
  // out of the agent's HERMES_HOME/skills into .../skills-disabled. Admin-only.
  // Safe to re-run. Mirror endpoint `/restore-bundled-skills` puts them back.
  app.post("/agents/:id/quarantine-bundled-skills", async (req, reply) => {
    const aId = (req.params as { id: string }).id;
    const { workspaceId, user } = req.auth!;
    const [wm] = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, user.id),
          eq(workspaceMembers.workspaceId, workspaceId!),
        ),
      )
      .limit(1);
    if (!wm || wm.role !== "admin") return reply.code(403).send({ error: "not_admin" });
    const [a] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, aId), eq(agents.workspaceId, workspaceId!)))
      .limit(1);
    if (!a) return reply.code(404).send({ error: "not_found" });
    if (a.kind !== "hermes") return reply.code(400).send({ error: "only_hermes_supported" });
    const hermesHome = await resolveHermesHome(a.id, a.handle);
    const moved = await quarantineBundledSkills(hermesHome);
    return { ok: true, moved };
  });

  app.post("/agents/:id/restore-bundled-skills", async (req, reply) => {
    const aId = (req.params as { id: string }).id;
    const { workspaceId, user } = req.auth!;
    const [wm] = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, user.id),
          eq(workspaceMembers.workspaceId, workspaceId!),
        ),
      )
      .limit(1);
    if (!wm || wm.role !== "admin") return reply.code(403).send({ error: "not_admin" });
    const [a] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, aId), eq(agents.workspaceId, workspaceId!)))
      .limit(1);
    if (!a) return reply.code(404).send({ error: "not_found" });
    if (a.kind !== "hermes") return reply.code(400).send({ error: "only_hermes_supported" });
    const hermesHome = await resolveHermesHome(a.id, a.handle);
    const restored = await restoreQuarantinedSkills(hermesHome);
    return { ok: true, restored };
  });

  // DELETE /api/agents/:id/uninstall — full teardown: removes bridge-config
  // entry, deletes the HERMES_HOME dir, archives messaging membership, and
  // drops the DB rows. Admin-only.
  app.delete("/agents/:id/uninstall", async (req, reply) => {
    const aId = (req.params as { id: string }).id;
    const { workspaceId, user } = req.auth!;

    const [wm] = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, user.id),
          eq(workspaceMembers.workspaceId, workspaceId!),
        ),
      )
      .limit(1);
    if (!wm || wm.role !== "admin") return reply.code(403).send({ error: "not_admin" });

    const [a] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, aId), eq(agents.workspaceId, workspaceId!)))
      .limit(1);
    if (!a) return reply.code(404).send({ error: "not_found" });

    // Remove bridge-config entry (if any) — triggers the bridge to close the WS.
    try {
      const raw = await fs.readFile(BRIDGE_CONFIG_PATH, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const next = parsed.filter(
          (e) => (e as { agentId?: string; handle?: string }).agentId !== aId &&
                 (e as { handle?: string }).handle !== a.handle,
        );
        await fs.writeFile(BRIDGE_CONFIG_PATH, JSON.stringify(next, null, 2));
      }
    } catch { /* ignore */ }

    // Best-effort remove the per-agent state dir — only for agents whose
    // runtime we actually provisioned on this host.
    if (a.kind === "hermes") {
      const hermesHome = join(HERMES_HOMES_DIR, `.hermes-${a.handle}`);
      try {
        await fs.rm(hermesHome, { recursive: true, force: true });
      } catch { /* ignore */ }
    } else if (a.kind === "openclaw") {
      const openclawHome = join(HERMES_HOMES_DIR, `.openclaw-${a.handle}`);
      try {
        await fs.rm(openclawHome, { recursive: true, force: true });
      } catch { /* ignore */ }
    }

    // DB cleanup: drop member row (cascade-style via manual deletes).
    const [am] = await db
      .select({ id: members.id })
      .from(members)
      .where(
        and(eq(members.workspaceId, workspaceId!), eq(members.kind, "agent"), eq(members.refId, aId)),
      )
      .limit(1);
    if (am) {
      await db
        .delete(conversationMembers)
        .where(eq(conversationMembers.memberId, am.id));
      await db.delete(members).where(eq(members.id, am.id));
    }
    await db.delete(agents).where(eq(agents.id, aId));

    return { ok: true };
  });
}

function runCmd(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Docker runs can take minutes on first pull; give them room before we
    // assume the subprocess is stuck.
    const p = spawn(cmd, args, { env, timeout: 180_000 });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(`${cmd} ${args[0]} exit ${code}: ${err.slice(0, 300) || out.slice(0, 300)}`));
    });
  });
}

const COLORS = ["amber", "teal", "rose", "violet", "lime", "sky", "orange", "emerald"];
function pickColor(handle: string): string {
  let h = 0;
  for (let i = 0; i < handle.length; i++) h = (h * 31 + handle.charCodeAt(i)) | 0;
  return COLORS[Math.abs(h) % COLORS.length];
}
