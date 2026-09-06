// What an agent row looks like to somebody who is not a workspace admin.
//
// `GET /agents`, `GET /agents/:id` and the member directory used to return the
// whole `agents` row: runtime kind, adapter, the raw `configJson` (which can
// carry a provider base URL and other deployment detail), the granted scopes,
// the masked bot token, the callback URL, the heartbeat interval and the budget
// / pause bookkeeping. On live.circlechat.co that is served to anonymous
// spectators, so the public demo was publishing the harness wiring of every
// agent. None of it is needed to render a member card, a member directory row
// or an agent profile — those want the identity and what the agent does.
//
// Admins keep the full row (they configure it). Everyone else — spectators AND
// ordinary members/guests — gets this projection.

import type { FastifyRequest } from "fastify";
import { workspaceAccess, permits } from "./access-control.js";

// The only agent fields a non-admin ever needs. Anything not listed here is
// dropped, so a new column added to the schema is private by default.
export const PUBLIC_AGENT_FIELDS = [
  "id",
  "handle",
  "name",
  "avatarColor",
  "title",
  "brief",
  "status",
  "memberId",
  "model",
] as const;

export type PublicAgentField = (typeof PUBLIC_AGENT_FIELDS)[number];

// Pure: pick the public subset out of an agent-shaped object. Fields that are
// absent on the input stay absent on the output (so `/members` rows, which
// carry no `model`, don't sprout a `model: undefined`).
export function publicAgentView<T extends Record<string, unknown>>(row: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of PUBLIC_AGENT_FIELDS) {
    if (key in row) (out as Record<string, unknown>)[key] = row[key];
  }
  return out;
}

// True when the caller may see an agent's configuration. Spectators never can
// (the shared read-only identity is not an admin even if its user row happened
// to hold the role); everyone else needs the workspace admin permission.
export async function canSeeAgentInternals(req: FastifyRequest): Promise<boolean> {
  if (req.spectator) return false;
  const workspaceId = req.auth?.workspaceId;
  const userId = req.auth?.userId;
  if (!workspaceId || !userId) return false;
  const access = await workspaceAccess(workspaceId, userId);
  if (!access) return false;
  return access.role === "admin" || permits(access.permissions, "*");
}
