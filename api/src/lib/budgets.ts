import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { agents, agentRuns, members, workspaces, workspaceMembers } from "../db/schema.js";
import { notifyMany } from "./notifications.js";

// Monthly spend budgets with hard stops, modeled on Paperclip's budget scopes:
// soft warning at 80%, hard stop at 100%. Two scopes — per-agent (pauses that
// agent with pause_reason='budget') and per-workspace (skips every run in the
// workspace without touching agent rows, so lifting the cap instantly resumes).
//
// Spend is ESTIMATED. The hermes/openclaw runtimes call the LLM gateway
// directly and never report usage back, so each run's cost is derived from the
// context-packet + response sizes at chars/4 tokens, times a loop multiplier
// (one run = several internal LLM calls), times a $/Mtok rate:
//   CC_COST_PER_MTOK_USD   combined in+out rate, default 0.50
//   CC_COST_RUN_MULTIPLIER internal-loop fudge factor, default 3

export const WARN_RATIO = 0.8;

const costPerMtokUsd = (): number => {
  const v = Number(process.env.CC_COST_PER_MTOK_USD ?? "0.5");
  return Number.isFinite(v) && v >= 0 ? v : 0.5;
};
const runMultiplier = (): number => {
  const v = Number(process.env.CC_COST_RUN_MULTIPLIER ?? "3");
  return Number.isFinite(v) && v >= 1 ? v : 3;
};

export function estimateRunCost(
  promptChars: number,
  completionChars: number,
): { tokensEst: number; costUsd: number } {
  const tokensEst = Math.ceil(((promptChars + completionChars) / 4) * runMultiplier());
  const costUsd = (tokensEst / 1_000_000) * costPerMtokUsd();
  return { tokensEst, costUsd };
}

export type BudgetVerdict = "ok" | "warn" | "hard_stop";

// Pure classification: NULL/0 budget = unlimited (0 would otherwise mean
// "never run", which no one sets on purpose — treat it as unset).
export function classifyBudget(spentUsd: number, budgetUsd: number | null | undefined): BudgetVerdict {
  if (budgetUsd == null || budgetUsd <= 0) return "ok";
  if (spentUsd >= budgetUsd) return "hard_stop";
  if (spentUsd >= budgetUsd * WARN_RATIO) return "warn";
  return "ok";
}

export function monthStartUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// True when `warnedAt` already falls inside the current month — the 80%
// warning fires at most once per scope per month.
export function warnedThisMonth(warnedAt: Date | null | undefined, now: Date = new Date()): boolean {
  return !!warnedAt && warnedAt >= monthStartUtc(now);
}

export async function agentSpendMonthUsd(agentId: string, now: Date = new Date()): Promise<number> {
  const [row] = await db
    .select({ spent: sql<number>`coalesce(sum(${agentRuns.costUsd}), 0)::float` })
    .from(agentRuns)
    .where(and(eq(agentRuns.agentId, agentId), gte(agentRuns.startedAt, monthStartUtc(now))));
  return row?.spent ?? 0;
}

export async function workspaceSpendMonthUsd(workspaceId: string, now: Date = new Date()): Promise<number> {
  const [row] = await db
    .select({ spent: sql<number>`coalesce(sum(${agentRuns.costUsd}), 0)::float` })
    .from(agentRuns)
    .innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(and(eq(agents.workspaceId, workspaceId), gte(agentRuns.startedAt, monthStartUtc(now))));
  return row?.spent ?? 0;
}

// Workspace admins' user-member ids (the inbox recipients for budget alerts).
async function adminMemberIds(workspaceId: string): Promise<string[]> {
  const admins = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "admin")));
  if (!admins.length) return [];
  const rows = await db
    .select({ id: members.id })
    .from(members)
    .where(
      and(
        eq(members.workspaceId, workspaceId),
        eq(members.kind, "user"),
        inArray(members.refId, admins.map((a) => a.userId)),
      ),
    );
  return rows.map((r) => r.id);
}

export type BudgetGate =
  | { allowed: true }
  | { allowed: false; reason: "agent_budget" | "workspace_budget" };

// The pre-run gate. Checks workspace scope first (cheapest to lift), then the
// agent scope. Side effects on the way out:
//   • warn (≥80%, once a month per scope) → notification to workspace admins
//   • agent hard stop → agent paused with pause_reason='budget' + notification
//   • workspace hard stop → run skipped, agents left untouched + notification
// Never throws — a metering hiccup must not take down the run loop.
export async function enforceBudgets(agent: {
  id: string;
  workspaceId: string;
  name: string;
  handle: string;
  budgetUsdMonth: number | null;
  budgetWarnedAt: Date | null;
}): Promise<BudgetGate> {
  try {
    const now = new Date();

    const [ws] = await db
      .select({
        budgetUsdMonth: workspaces.budgetUsdMonth,
        budgetWarnedAt: workspaces.budgetWarnedAt,
        budgetStoppedAt: workspaces.budgetStoppedAt,
      })
      .from(workspaces)
      .where(eq(workspaces.id, agent.workspaceId))
      .limit(1);

    if (ws && ws.budgetUsdMonth != null && ws.budgetUsdMonth > 0) {
      const spent = await workspaceSpendMonthUsd(agent.workspaceId, now);
      const verdict = classifyBudget(spent, ws.budgetUsdMonth);
      if (verdict === "hard_stop") {
        if (!warnedThisMonth(ws.budgetStoppedAt, now)) {
          await db
            .update(workspaces)
            .set({ budgetStoppedAt: now })
            .where(eq(workspaces.id, agent.workspaceId));
          await notifyAdmins(agent.workspaceId, {
            title: `Workspace monthly budget reached ($${ws.budgetUsdMonth.toFixed(2)})`,
            body: `Estimated spend is $${spent.toFixed(2)}. All agent runs are on hold until you raise the budget in Settings or the month rolls over.`,
            link: `/settings`,
          });
        }
        return { allowed: false, reason: "workspace_budget" };
      }
      if (verdict === "warn" && !warnedThisMonth(ws.budgetWarnedAt, now)) {
        await markWorkspaceWarned(agent.workspaceId, now);
        await notifyAdmins(agent.workspaceId, {
          title: `Workspace at ${Math.round((spent / ws.budgetUsdMonth) * 100)}% of its monthly budget`,
          body: `Estimated spend is $${spent.toFixed(2)} of $${ws.budgetUsdMonth.toFixed(2)}. Agents stop when it runs out.`,
          link: `/settings`,
        });
      }
    }

    if (agent.budgetUsdMonth != null && agent.budgetUsdMonth > 0) {
      const spent = await agentSpendMonthUsd(agent.id, now);
      const verdict = classifyBudget(spent, agent.budgetUsdMonth);
      if (verdict === "hard_stop") {
        await db
          .update(agents)
          .set({ status: "paused", pauseReason: "budget" })
          .where(eq(agents.id, agent.id));
        await notifyAdmins(agent.workspaceId, {
          title: `@${agent.handle} paused: monthly budget reached ($${agent.budgetUsdMonth.toFixed(2)})`,
          body: `${agent.name}'s estimated spend is $${spent.toFixed(2)}. Raise the budget and resume the agent, or leave it paused until the month rolls over.`,
          link: `/agents/${agent.id}`,
        });
        return { allowed: false, reason: "agent_budget" };
      }
      if (verdict === "warn" && !warnedThisMonth(agent.budgetWarnedAt, now)) {
        await db.update(agents).set({ budgetWarnedAt: now }).where(eq(agents.id, agent.id));
        await notifyAdmins(agent.workspaceId, {
          title: `@${agent.handle} at ${Math.round((spent / agent.budgetUsdMonth) * 100)}% of its monthly budget`,
          body: `Estimated spend is $${spent.toFixed(2)} of $${agent.budgetUsdMonth.toFixed(2)}. The agent pauses when it runs out.`,
          link: `/agents/${agent.id}`,
        });
      }
    }

    return { allowed: true };
  } catch (e) {
    console.error("[budgets] enforcement failed (allowing run)", (e as Error).message);
    return { allowed: true };
  }
}

async function markWorkspaceWarned(workspaceId: string, now: Date): Promise<void> {
  await db.update(workspaces).set({ budgetWarnedAt: now }).where(eq(workspaces.id, workspaceId));
}

export async function notifyAdmins(
  workspaceId: string,
  msg: { title: string; body: string; link: string },
): Promise<void> {
  const recipients = await adminMemberIds(workspaceId);
  if (!recipients.length) return;
  await notifyMany(recipients, {
    workspaceId,
    kind: "system",
    title: msg.title,
    body: msg.body,
    link: msg.link,
  });
}
