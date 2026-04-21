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
  model: z.string().max(120).optional(),
  heartbeatIntervalSec: z.number().int().min(15).max(3600).optional(),
  channelIds: z.array(z.string()).optional(),
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

    const env = { ...process.env, HERMES_HOME: hermesHome };
    try {
      // Copy the baked template — hermes setup needs a TTY which we don't
      // have, so we pre-seed config.yaml instead. Subsequent `hermes auth add`
      // and `hermes config set` calls are non-interactive and work fine.
      const tmpl = await fs.readFile(HERMES_CONFIG_TEMPLATE, "utf8");
      await fs.writeFile(join(hermesHome, "config.yaml"), tmpl);
      await runCmd(
        "hermes",
        [
          "auth",
          "add",
          body.provider,
          "--type",
          "api-key",
          "--api-key",
          body.apiKey,
          ...(body.apiKeyLabel ? ["--label", body.apiKeyLabel] : []),
        ],
        env,
      );
      if (body.model) {
        await runCmd("hermes", ["config", "set", "model.default", body.model], env);
      }
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

    // Best-effort remove HERMES_HOME — only for agents whose kind is hermes
    // and whose directory matches the handle we created.
    if (a.kind === "hermes") {
      const hermesHome = join(HERMES_HOMES_DIR, `.hermes-${a.handle}`);
      try {
        await fs.rm(hermesHome, { recursive: true, force: true });
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
    const p = spawn(cmd, args, { env, timeout: 60_000 });
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
