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

// ─────────────────────── run projections ───────────────────────
// `GET /agents/:id` used to return whole `agent_runs` rows in `recentRuns`, and
// `GET /agent-runs/:id` / `GET /active-runs` still do. A run row carries
// `contextJson` — the assembled prompt packet: memory blocks, the planner
// ledger, `previousRunErrors`, the conversation excerpt — plus `traceJson`
// (per-action tool trace), `resultJson` (raw error strings), `steerJson` /
// `followupJson` (operator instructions) and `errorText`. On
// live.circlechat.co that was ~45 KB per run × 25 runs served to anonymous
// visitors on one page load.
//
// Nobody outside the workspace's admins needs any of it to read "this agent
// ran, it was a heartbeat, it took 12s and applied 2 actions". So non-admins
// get this projection: identity, outcome, timing, and one plain-English
// summary sentence derived from the structured result — never model- or
// tool-authored text.

export interface PublicRunView {
  id: string;
  trigger: string;
  status: string;
  startedAt: Date | string;
  finishedAt: Date | string | null;
  durationSec: number | null;
  summary: string;
}

type RunLike = {
  id: string;
  trigger: string;
  status: string;
  startedAt: Date | string;
  finishedAt?: Date | string | null;
  resultJson?: Record<string, unknown> | null;
};

const SKIP_COPY: Record<string, string> = {
  paused: "Skipped — the agent is paused.",
  no_activity: "Skipped — nothing new to look at.",
  heartbeat_backoff: "Skipped — waiting before the next check.",
  cancelled_before_actions: "Cancelled before anything was applied.",
};

// Pure: one human sentence for a run, built only from structured fields. Never
// echoes `errorText`, a trace line or a tool message — those are operator
// diagnostics and are what leaked in the first place.
export function publicRunSummary(run: RunLike): string {
  const result = (run.resultJson ?? {}) as {
    applied?: unknown;
    errors?: unknown;
    idle?: unknown;
    skipped?: unknown;
  };
  if (run.status === "queued") return "Queued.";
  if (run.status === "running") return "Running now.";
  if (run.status === "cancelled") return "Cancelled.";
  if (typeof result.skipped === "string") {
    return SKIP_COPY[result.skipped] ?? "Skipped — nothing to do.";
  }
  if (run.status === "failed") return "The run did not finish.";
  const applied = typeof result.applied === "number" ? result.applied : 0;
  if (applied > 0) return `${applied} action${applied === 1 ? "" : "s"} applied.`;
  return "Finished with no changes.";
}

function seconds(from: Date | string, to: Date | string | null | undefined): number | null {
  if (!to) return null;
  const a = from instanceof Date ? from.getTime() : Date.parse(String(from));
  const b = to instanceof Date ? to.getTime() : Date.parse(String(to));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / 1000));
}

// Pure: the public projection of one agent run. Whitelist, not blacklist — a
// column added to `agent_runs` later is private by default.
export function publicRunView(run: RunLike): PublicRunView {
  return {
    id: run.id,
    trigger: run.trigger,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    durationSec: seconds(run.startedAt, run.finishedAt ?? null),
    summary: publicRunSummary(run),
  };
}

// Same idea for workflow runs: `inputJson` / `outputJson` are the workflow's
// own payloads (they have carried file paths and API responses) and
// `steerJson` / `followupJson` are operator instructions.
export interface PublicWorkflowRunView {
  id: string;
  workflowId: string;
  status: string;
  startedAt: Date | string;
  finishedAt: Date | string | null;
  durationSec: number | null;
}

export function publicWorkflowRunView(run: {
  id: string;
  workflowId: string;
  status: string;
  startedAt: Date | string;
  finishedAt?: Date | string | null;
}): PublicWorkflowRunView {
  return {
    id: run.id,
    workflowId: run.workflowId,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    durationSec: seconds(run.startedAt, run.finishedAt ?? null),
  };
}

// ─────────────── board / goal rows on the public demo ───────────────
// Two more fields that are written FOR an agent and were being served to
// anonymous visitors:
//   • `verification.rationale` — the judge's critique of a deliverable. It
//     quotes rubric wording, file paths and tool names, and the web client
//     already refuses to render it to a spectator (VerificationBadge,
//     TaskModal). Don't send it either.
//   • `goals.lastPlanError` / `planAttempts` — planner bookkeeping ("no_roster",
//     "plan_generation_failed"), meaningful only to whoever configures the
//     planner.
// Logged-in members keep both: a reviewer needs the rationale, and an operator
// needs to know why planning failed. Only the shared spectator identity loses
// them.

export function spectatorTaskView<T extends Record<string, unknown>>(task: T): T {
  const verification = task.verification as { rationale?: unknown } | null | undefined;
  if (!verification || typeof verification !== "object") return task;
  const { rationale: _rationale, ...rest } = verification as Record<string, unknown>;
  return { ...task, verification: rest } as T;
}

export function spectatorGoalView<T extends Record<string, unknown>>(goal: T): T {
  const { lastPlanError: _err, planAttempts: _n, ...rest } = goal;
  return rest as T;
}

// ─────────────── archived goals on the public demo ───────────────
// The one goal status the public identity never sees. `parked` stays visible
// on purpose: web/src/pages/Goals.tsx renders a parked goal (with its "Parked"
// label) to everyone and only hides the Resume button from a spectator, so
// hiding the row would blank a goal the page is built to show. `archived` is
// the opposite — Goals.tsx filters it out for every identity, so no client
// loses anything by the server never sending it, and on live 9 of the 32 goals
// in the public payload were retired ones.
export const SPECTATOR_HIDDEN_GOAL_STATUS = "archived";

// Pure: is this goal row one the public identity must not be shown?
export function hiddenFromSpectators(status: string | null | undefined): boolean {
  return status === SPECTATOR_HIDDEN_GOAL_STATUS;
}
