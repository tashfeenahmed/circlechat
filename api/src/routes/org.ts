import { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  members,
  users,
  agents,
  workspaceMembers,
} from "../db/schema.js";
import { requireWorkspace } from "../auth/session.js";

const AssignBody = z.object({
  memberId: z.string().min(1),
  reportsTo: z.string().min(1).nullable(),
});

interface OrgNode {
  memberId: string;
  kind: "user" | "agent";
  name: string;
  handle: string;
  title: string;
  avatarColor: string;
  status: string | null;
  reportsTo: string | null;
  // Only set for agents. "hermes" | "openclaw" | string — matches agents.kind.
  agentKind: string | null;
}

export default async function orgRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireWorkspace);

  // Flat directory of every member in the workspace + their reportsTo pointer.
  // The UI builds the tree; the server just serves the flat data.
  app.get("/org", async (req) => {
    const { workspaceId } = req.auth!;
    const nodes = await loadOrgNodes(workspaceId!);
    return { nodes };
  });

  // Reassign a member's manager. Admin-only; rejects cycles and cross-workspace
  // pointers. Null reportsTo puts the member at the top of the tree.
  app.post("/org/assign", async (req, reply) => {
    const body = AssignBody.parse(req.body);
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

    if (body.reportsTo && body.reportsTo === body.memberId) {
      return reply.code(400).send({ error: "cannot_report_to_self" });
    }

    const [target] = await db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.id, body.memberId), eq(members.workspaceId, workspaceId!)))
      .limit(1);
    if (!target) return reply.code(404).send({ error: "member_not_found" });

    if (body.reportsTo) {
      const [manager] = await db
        .select({ id: members.id })
        .from(members)
        .where(
          and(eq(members.id, body.reportsTo), eq(members.workspaceId, workspaceId!)),
        )
        .limit(1);
      if (!manager) return reply.code(404).send({ error: "manager_not_found" });

      // Cycle check: walk up from the prospective manager — if we meet `memberId`,
      // the new edge would close a loop.
      const allRows = await db
        .select({ id: members.id, reportsTo: members.reportsTo })
        .from(members)
        .where(eq(members.workspaceId, workspaceId!));
      const rtMap = new Map(allRows.map((r) => [r.id, r.reportsTo]));
      let cursor: string | null | undefined = body.reportsTo;
      const seen = new Set<string>();
      while (cursor) {
        if (cursor === body.memberId) {
          return reply.code(400).send({ error: "cycle_detected" });
        }
        if (seen.has(cursor)) break;
        seen.add(cursor);
        cursor = rtMap.get(cursor) ?? null;
      }
    }

    await db
      .update(members)
      .set({ reportsTo: body.reportsTo })
      .where(and(eq(members.id, body.memberId), eq(members.workspaceId, workspaceId!)));

    return { ok: true };
  });
}

export async function loadOrgNodes(workspaceId: string): Promise<OrgNode[]> {
  const rows = await db
    .select()
    .from(members)
    .where(eq(members.workspaceId, workspaceId));
  if (!rows.length) return [];
  const userRefs = rows.filter((r) => r.kind === "user").map((r) => r.refId);
  const agentRefs = rows.filter((r) => r.kind === "agent").map((r) => r.refId);
  const uRows = userRefs.length
    ? await db
        .select({
          id: users.id,
          name: users.name,
          handle: users.handle,
          avatarColor: users.avatarColor,
        })
        .from(users)
        .where(inArray(users.id, userRefs))
    : [];
  const aRows = agentRefs.length
    ? await db
        .select({
          id: agents.id,
          name: agents.name,
          handle: agents.handle,
          avatarColor: agents.avatarColor,
          title: agents.title,
          status: agents.status,
          kind: agents.kind,
        })
        .from(agents)
        .where(inArray(agents.id, agentRefs))
    : [];
  const uMap = new Map(uRows.map((u) => [u.id, u]));
  const aMap = new Map(aRows.map((a) => [a.id, a]));

  const out: OrgNode[] = [];
  for (const m of rows) {
    if (m.kind === "user") {
      const u = uMap.get(m.refId);
      if (!u) continue;
      out.push({
        memberId: m.id,
        kind: "user",
        name: u.name,
        handle: u.handle,
        title: "",
        avatarColor: u.avatarColor,
        status: null,
        reportsTo: m.reportsTo ?? null,
        agentKind: null,
      });
    } else {
      const a = aMap.get(m.refId);
      if (!a) continue;
      out.push({
        memberId: m.id,
        kind: "agent",
        name: a.name,
        handle: a.handle,
        title: a.title,
        avatarColor: a.avatarColor,
        status: a.status,
        reportsTo: m.reportsTo ?? null,
        agentKind: a.kind,
      });
    }
  }
  return out;
}

// Compact reporting bundle used inside agent context packets.
export interface ReportingBundle {
  manager: { memberId: string; kind: string; name: string; handle: string; title: string } | null;
  directReports: Array<{ memberId: string; kind: string; name: string; handle: string; title: string }>;
  peers: Array<{ memberId: string; kind: string; name: string; handle: string; title: string }>;
}

export async function loadReportingFor(
  workspaceId: string,
  memberId: string,
): Promise<ReportingBundle> {
  const nodes = await loadOrgNodes(workspaceId);
  const byId = new Map(nodes.map((n) => [n.memberId, n]));
  const me = byId.get(memberId);
  const empty: ReportingBundle = { manager: null, directReports: [], peers: [] };
  if (!me) return empty;
  const manager = me.reportsTo ? byId.get(me.reportsTo) ?? null : null;
  const reports = nodes.filter((n) => n.reportsTo === memberId);
  const peers = manager
    ? nodes.filter((n) => n.memberId !== memberId && n.reportsTo === manager.memberId)
    : [];
  const shape = (n: OrgNode) => ({
    memberId: n.memberId,
    kind: n.kind,
    name: n.name,
    handle: n.handle,
    title: n.title,
  });
  return {
    manager: manager ? shape(manager) : null,
    directReports: reports.map(shape),
    peers: peers.map(shape),
  };
}
