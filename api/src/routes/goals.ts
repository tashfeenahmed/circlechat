import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireWorkspace } from "../auth/session.js";
import { hiddenFromSpectators, spectatorGoalView, spectatorTaskView } from "../lib/agent-view.js";
import { spectatorGoalText, spectatorTaskText } from "../lib/public-text.js";
import {
  GOAL_STATUSES,
  GOAL_KINDS,
  createGoal,
  listGoals,
  getGoalDetail,
  updateGoal,
  deleteGoal,
} from "../lib/goals-core.js";
import { planGoal, type PlanError } from "../lib/planner.js";

const CreateBody = z.object({
  title: z.string().min(1).max(300),
  bodyMd: z.string().max(20000).optional(),
  parentGoalId: z.string().nullable().optional(),
  ownerMemberId: z.string().nullable().optional(),
  kind: z.enum(GOAL_KINDS).optional(),
});

const UpdateBody = z.object({
  title: z.string().min(1).max(300).optional(),
  bodyMd: z.string().max(20000).optional(),
  status: z.enum(GOAL_STATUSES).optional(),
  ownerMemberId: z.string().nullable().optional(),
  kind: z.enum(GOAL_KINDS).optional(),
});

const ERR_CODE: Record<string, number> = {
  wrong_workspace: 403,
  not_found: 404,
  invalid_parent: 400,
};

const PLAN_ERR_CODE: Record<PlanError, number> = {
  goal_not_found: 404,
  wrong_workspace: 403,
  planner_unconfigured: 503,
  already_planned: 409,
  no_roster: 422,
  plan_generation_failed: 502,
  empty_plan: 502,
  cyclic_plan: 422,
};

function send(reply: import("fastify").FastifyReply, result: { error?: string; [k: string]: unknown }) {
  if (result.error) return reply.code(ERR_CODE[result.error] ?? 400).send({ error: result.error });
  return result;
}

export default async function goalsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireWorkspace);

  // Paginated the same way as /tasks — `?limit=` (default 100, max 500) plus
  // `?cursor=` from the previous page's `nextCursor`.
  app.get("/goals", async (req) => {
    const q = req.query as { limit?: unknown; cursor?: unknown };
    // Archived goals are filtered in SQL, not here: the page is a keyset page,
    // so dropping rows after the query would return short pages and a cursor
    // that skips whatever the filter removed.
    const r = await listGoals(req.auth!.workspaceId!, {
      limit: q.limit,
      cursor: q.cursor,
      includeArchived: !req.spectator,
    });
    if (!req.spectator) return r;
    // `spectatorGoalView` drops the planner's bookkeeping; `spectatorGoalText`
    // cleans the goal's own title and body, which an agent writes in the same
    // prose it writes a card in. See lib/public-text.ts.
    return { ...r, goals: r.goals.map(spectatorGoalView).map(spectatorGoalText) };
  });

  app.post("/goals", async (req, reply) => {
    const body = CreateBody.parse(req.body);
    const r = await createGoal(body, req.auth!.memberId!, req.auth!.workspaceId!);
    return send(reply, r);
  });

  app.get("/goals/:id", async (req, reply) => {
    const goalId = (req.params as { id: string }).id;
    const r = await getGoalDetail(goalId, req.auth!.workspaceId!);
    if (!r.error && req.spectator) {
      const detail = r as {
        goal?: Record<string, unknown>;
        subGoals?: Array<Record<string, unknown>>;
        tasks?: Array<Record<string, unknown>>;
      };
      // Same rule as the list: an archived goal does not exist as far as the
      // public identity is concerned, by id or as somebody's sub-goal.
      if (hiddenFromSpectators(detail.goal?.status as string | undefined)) {
        return reply.code(404).send({ error: "not_found" });
      }
      if (detail.goal) detail.goal = spectatorGoalText(spectatorGoalView(detail.goal));
      if (Array.isArray(detail.subGoals)) {
        detail.subGoals = detail.subGoals
          .filter((g) => !hiddenFromSpectators(g.status as string | undefined))
          .map((g) => spectatorGoalText(spectatorGoalView(g)));
      }
      // The goal's cards come back hydrated here, so this response is a second
      // door onto every task title and body `GET /tasks` serves — and onto the
      // judge's rationale, which /tasks has stripped since #64 and this never
      // did.
      if (Array.isArray(detail.tasks)) {
        detail.tasks = detail.tasks.map((t) => spectatorTaskText(spectatorTaskView(t)));
      }
    }
    return send(reply, r);
  });

  app.patch("/goals/:id", async (req, reply) => {
    const goalId = (req.params as { id: string }).id;
    const body = UpdateBody.parse(req.body);
    const r = await updateGoal(goalId, body, req.auth!.workspaceId!);
    return send(reply, r);
  });

  app.delete("/goals/:id", async (req, reply) => {
    const goalId = (req.params as { id: string }).id;
    const r = await deleteGoal(goalId, req.auth!.workspaceId!);
    return send(reply, r);
  });

  // Decompose a goal into a delegation tree of tasks and start it. The heavy
  // lift (LLM call + materialisation) happens synchronously; the response
  // carries the plan summary.
  app.post("/goals/:id/plan", async (req, reply) => {
    const goalId = (req.params as { id: string }).id;
    const r = await planGoal({
      goalId,
      workspaceId: req.auth!.workspaceId!,
      actorMemberId: req.auth!.memberId!,
    });
    if ("error" in r) return reply.code(PLAN_ERR_CODE[r.error] ?? 400).send({ error: r.error });
    return r;
  });
}
