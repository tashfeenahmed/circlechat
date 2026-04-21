import { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { db } from "../db/index.js";
import { agents, workspaceMembers } from "../db/schema.js";
import { requireWorkspace } from "../auth/session.js";
import {
  resolveHermesHome,
  readManifest,
  addToManifest,
  removeFromManifest,
} from "../agents/hermes-equip.js";

const HERMES_HOMES_DIR = process.env.HERMES_HOMES_DIR ?? homedir();

// Both runtimes keep their CircleChat-managed skills under `<home>/skills/`
// with the same `.circlechat-managed.json` manifest. For Hermes, the path is
// authoritatively resolved from bridge-config.json via resolveHermesHome;
// for OpenClaw we use the install convention `.openclaw-<handle>`.
async function resolveAgentSkillsRoot(agent: { id: string; handle: string; kind: string }): Promise<string> {
  if (agent.kind === "openclaw") {
    return join(HERMES_HOMES_DIR, `.openclaw-${agent.handle}`, "skills");
  }
  return await resolveAgentSkillsRoot(agent);
}

const SkillBody = z.object({
  markdown: z.string().min(1).max(200_000),
});

const SkillNameRe = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export default async function agentSkillsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireWorkspace);

  // GET /api/agents/:id/skills — list CircleChat-managed skills only.
  //
  // "Managed" = in the `.circlechat-managed.json` manifest, which captures
  // the core circlechat skill + anything a user has added through this UI.
  // The bundled Hermes skill pack (apple/devops/songwriting/…) is hidden —
  // users don't edit those here, and including them flooded the page.
  //
  // Fallback (for agents equipped before the manifest shipped): if no
  // manifest exists but `circlechat/` is present, show just that entry.
  app.get("/agents/:id/skills", async (req, reply) => {
    const agent = await resolveAgent(req, reply);
    if (!agent) return;
    const root = await resolveAgentSkillsRoot(agent);

    let managed = await readManifest(root);
    if (managed.length === 0) {
      const dirs = await safeListDirs(root);
      if (dirs.includes("circlechat")) managed = ["circlechat"];
    }

    const out: Array<{ name: string; hasDescription: boolean; summary: string | null }> = [];
    for (const name of managed) {
      const desc = await safeReadFile(join(root, name, "DESCRIPTION.md"));
      out.push({
        name,
        hasDescription: !!desc,
        summary: desc ? extractSummary(desc) : null,
      });
    }
    return { skills: out };
  });

  // GET /api/agents/:id/skills/:name — raw DESCRIPTION.md contents.
  app.get("/agents/:id/skills/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!SkillNameRe.test(name)) return reply.code(400).send({ error: "bad_name" });
    const agent = await resolveAgent(req, reply);
    if (!agent) return;
    const path = join(await resolveAgentSkillsRoot(agent), name, "DESCRIPTION.md");
    const md = await safeReadFile(path);
    if (md === null) return reply.code(404).send({ error: "not_found" });
    return { name, markdown: md };
  });

  // PUT /api/agents/:id/skills/:name — create or overwrite. Admin-only.
  app.put("/agents/:id/skills/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!SkillNameRe.test(name)) return reply.code(400).send({ error: "bad_name" });
    if (!(await requireAdmin(req, reply))) return;
    const agent = await resolveAgent(req, reply);
    if (!agent) return;
    const body = SkillBody.parse(req.body);

    const root = await resolveAgentSkillsRoot(agent);
    const dir = join(root, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, "DESCRIPTION.md"), body.markdown);
    await addToManifest(root, name);
    return { ok: true };
  });

  // DELETE /api/agents/:id/skills/:name — but never the shipped `circlechat`
  // skill (it's the one that wires up the MCP). Admin-only.
  app.delete("/agents/:id/skills/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!SkillNameRe.test(name)) return reply.code(400).send({ error: "bad_name" });
    if (name === "circlechat") return reply.code(400).send({ error: "cannot_delete_core_skill" });
    if (!(await requireAdmin(req, reply))) return;
    const agent = await resolveAgent(req, reply);
    if (!agent) return;
    const root = await resolveAgentSkillsRoot(agent);
    await fs.rm(join(root, name), { recursive: true, force: true });
    await removeFromManifest(root, name);
    return { ok: true };
  });
}

// ──────────────────────── helpers ────────────────────────

async function safeListDirs(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function safeReadFile(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

function extractSummary(md: string): string | null {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const desc = fm[1]!.match(/^description:\s*>?\s*\n?((?: {2}.*\n?)+|.*)/m);
  if (!desc) return null;
  return desc[1]!
    .split("\n")
    .map((l) => l.replace(/^\s+/, ""))
    .join(" ")
    .trim()
    .slice(0, 240);
}

async function resolveAgent(
  req: import("fastify").FastifyRequest,
  reply: import("fastify").FastifyReply,
): Promise<{ id: string; handle: string; kind: string } | null> {
  const aId = (req.params as { id: string }).id;
  const { workspaceId } = req.auth!;
  const [a] = await db
    .select({ id: agents.id, handle: agents.handle, kind: agents.kind })
    .from(agents)
    .where(and(eq(agents.id, aId), eq(agents.workspaceId, workspaceId!)))
    .limit(1);
  if (!a) {
    reply.code(404).send({ error: "agent_not_found" });
    return null;
  }
  if (a.kind !== "hermes" && a.kind !== "openclaw") {
    reply.code(400).send({ error: "unsupported_agent_kind" });
    return null;
  }
  return a;
}

async function requireAdmin(
  req: import("fastify").FastifyRequest,
  reply: import("fastify").FastifyReply,
): Promise<boolean> {
  const { user, workspaceId } = req.auth!;
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
  if (!wm || wm.role !== "admin") {
    reply.code(403).send({ error: "not_admin" });
    return false;
  }
  return true;
}
