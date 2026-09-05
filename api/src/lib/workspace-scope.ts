import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { conversations, members } from "../db/schema.js";

// Workspace-scoping helpers for caller-supplied id lists. Several write paths
// (channel create, add-members, agent channel auto-join) used to insert the ids
// the client sent verbatim — a member id from workspace B could be dropped into
// a conversation in workspace A (and then read it), and an agent could be
// auto-joined to a conversation in another workspace. Both helpers return only
// the ids that really belong to `workspaceId`, deduplicated, in input order.

export async function filterWorkspaceMemberIds(
  workspaceId: string,
  ids: readonly string[],
): Promise<string[]> {
  const wanted = Array.from(new Set(ids.filter((v) => typeof v === "string" && v.length > 0)));
  if (!wanted.length) return [];
  const rows = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.workspaceId, workspaceId), inArray(members.id, wanted)));
  const ok = new Set(rows.map((r) => r.id));
  return wanted.filter((id) => ok.has(id));
}

export async function filterWorkspaceConversationIds(
  workspaceId: string,
  ids: readonly string[],
  opts: { kind?: "channel" | "dm" } = {},
): Promise<string[]> {
  const wanted = Array.from(new Set(ids.filter((v) => typeof v === "string" && v.length > 0)));
  if (!wanted.length) return [];
  const conds = [eq(conversations.workspaceId, workspaceId), inArray(conversations.id, wanted)];
  if (opts.kind) conds.push(eq(conversations.kind, opts.kind));
  const rows = await db.select({ id: conversations.id }).from(conversations).where(and(...conds));
  const ok = new Set(rows.map((r) => r.id));
  return wanted.filter((id) => ok.has(id));
}
