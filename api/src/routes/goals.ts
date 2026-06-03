import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireWorkspace } from "../auth/session.js";
import {
  GOAL_STATUSES,
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
});

const UpdateBody = z.object({
  title: z.string().min(1).max(300).optional(),
  bodyMd: z.string().max(20000).optional(),
  status: z.enum(GOAL_STATUSES).optional(),
  ownerMemberId: z.string().nullable().optional(),
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

  app.get("/goals", async (req) => {
    return await listGoals(req.auth!.workspaceId!);
  });

  app.post("/goals", async (req, reply) => {
    const body = CreateBody.parse(req.body);
    const r = await createGoal(body, req.auth!.memberId!, req.auth!.workspaceId!);
    return send(reply, r);
  });

  app.get("/goals/:id", async (req, reply) => {
    const goalId = (req.params as { id: string }).id;
    const r = await getGoalDetail(goalId, req.auth!.workspaceId!);
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
