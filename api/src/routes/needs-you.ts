import type { FastifyInstance } from "fastify";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  agents,
  approvals,
  connectors,
  goalLedgers,
  goals,
  hostedApps,
  taskVerifications,
  tasks,
  workflowRuns,
  workflows,
  workspaces,
} from "../db/schema.js";
import { requireWorkspace } from "../auth/session.js";
import { approvalExpiresAt, isCredentialAsk } from "../lib/approval-policy.js";

type ReviewItem = {
  id: string;
  kind: "approval" | "task_review" | "verification_failed" | "stalled_goal" | "workflow_wait" | "workflow_failed" | "budget" | "connector_error" | "app_publish";
  priority: "critical" | "high" | "normal";
  title: string;
  detail: string;
  link: string;
  targetId: string;
  createdAt: string;
  actions: string[];
};

export default async function needsYouRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireWorkspace);

  app.get("/needs-you", async (req) => {
    const workspaceId = req.auth!.workspaceId!;
    const workspaceAgents = await db.select({ id: agents.id, name: agents.name, budgetWarnedAt: agents.budgetWarnedAt, pauseReason: agents.pauseReason })
      .from(agents).where(eq(agents.workspaceId, workspaceId));
    const agentIds = workspaceAgents.map((agent) => agent.id);
    const [approvalRows, reviewTasks, failedVerdicts, stalledGoals, waits, failures, connectorErrors, pendingApps, workspace] = await Promise.all([
      agentIds.length ? db.select({ approval: approvals, agentName: agents.name }).from(approvals).innerJoin(agents, eq(agents.id, approvals.agentId)).where(and(inArray(approvals.agentId, agentIds), eq(approvals.status, "pending"))).orderBy(desc(approvals.createdAt)) : [],
      db.select().from(tasks).where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, "review"), eq(tasks.archived, false))).orderBy(desc(tasks.updatedAt)),
      // Only cards still sitting in review can act on a failed verdict; a fail on a
      // card that has since moved (done, back to in_progress, archived) is history.
      db.select({ verification: taskVerifications, taskTitle: tasks.title }).from(taskVerifications).innerJoin(tasks, eq(tasks.id, taskVerifications.taskId)).where(and(eq(taskVerifications.workspaceId, workspaceId), eq(taskVerifications.verdict, "fail"), eq(tasks.status, "review"), eq(tasks.archived, false))).orderBy(desc(taskVerifications.createdAt)),
      db.select({ ledger: goalLedgers, title: goals.title }).from(goalLedgers).innerJoin(goals, eq(goals.id, goalLedgers.goalId)).where(and(eq(goalLedgers.workspaceId, workspaceId), gt(goalLedgers.stallCount, 0))).orderBy(desc(goalLedgers.updatedAt)),
      db.select({ run: workflowRuns, name: workflows.name }).from(workflowRuns).innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId)).where(and(eq(workflowRuns.workspaceId, workspaceId), eq(workflowRuns.status, "waiting"), eq(workflowRuns.waitKind, "human"))).orderBy(desc(workflowRuns.updatedAt)),
      db.select({ run: workflowRuns, name: workflows.name }).from(workflowRuns).innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId)).where(and(eq(workflowRuns.workspaceId, workspaceId), eq(workflowRuns.status, "failed"))).orderBy(desc(workflowRuns.updatedAt)).limit(20),
      db.select().from(connectors).where(and(eq(connectors.workspaceId, workspaceId), eq(connectors.status, "error"))).orderBy(desc(connectors.updatedAt)),
      db.select().from(hostedApps).where(and(eq(hostedApps.workspaceId, workspaceId), eq(hostedApps.status, "pending"))).orderBy(desc(hostedApps.updatedAt)),
      db.select({ budgetWarnedAt: workspaces.budgetWarnedAt, budgetStoppedAt: workspaces.budgetStoppedAt, budgetUsdMonth: workspaces.budgetUsdMonth }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1).then((rows) => rows[0]),
    ]);

    const items: ReviewItem[] = [];
    for (const row of approvalRows) {
      const expiresAt = approvalExpiresAt(row.approval.createdAt);
      const hoursLeft = expiresAt ? Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 3_600_000)) : null;
      const credential = isCredentialAsk(row.approval.scope, row.approval.action);
      const hints = [
        credential ? "credential request — approving without attaching the secret delivers nothing (use the Approvals page to attach it)" : null,
        hoursLeft != null ? (hoursLeft > 0 ? `expires in ${hoursLeft}h if undecided` : "expiring now") : null,
      ].filter(Boolean);
      items.push({
        id: `approval:${row.approval.id}`,
        kind: "approval",
        // A card about to expire is the last chance to say yes/no before the
        // agent is told to route around it.
        priority: hoursLeft != null && hoursLeft <= 12 ? "critical" : "high",
        title: `${row.agentName} needs approval`,
        detail: `${row.approval.scope}: ${row.approval.action}${hints.length ? ` (${hints.join("; ")})` : ""}`,
        link: credential ? "/approvals" : "/needs-you",
        targetId: row.approval.id,
        createdAt: row.approval.createdAt.toISOString(),
        actions: ["approve", "deny"],
      });
    }
    // One item per review card. If its latest verdict is a fail, the item says
    // so (with the judge's reason) instead of a second "verification failed" row.
    const latestFailed = new Map<string, (typeof failedVerdicts)[number]>();
    for (const row of failedVerdicts) if (!latestFailed.has(row.verification.taskId)) latestFailed.set(row.verification.taskId, row);
    for (const task of reviewTasks) {
      const failed = latestFailed.get(task.id);
      if (failed) {
        items.push({ id: `verification:${failed.verification.id}`, kind: "verification_failed", priority: "high", title: `Needs review: ${task.title}`, detail: `Verification failed — ${failed.verification.rationale || `score ${failed.verification.score ?? "n/a"}`}`, link: `/board?task=${task.id}`, targetId: task.id, createdAt: failed.verification.createdAt.toISOString(), actions: ["open"] });
      } else {
        items.push({ id: `task:${task.id}`, kind: "task_review", priority: "normal", title: `Needs review: ${task.title}`, detail: "The assignee marked this card ready. Open it to check the deliverable and move it to done.", link: `/board?task=${task.id}`, targetId: task.id, createdAt: task.updatedAt.toISOString(), actions: ["open"] });
      }
    }
    for (const row of stalledGoals) items.push({ id: `goal:${row.ledger.goalId}`, kind: "stalled_goal", priority: row.ledger.stallCount >= 3 ? "critical" : "high", title: `Stalled goal: ${row.title}`, detail: `${row.ledger.stallCount} stalled assessment(s); ${row.ledger.replanCount} re-plan(s).`, link: "/goals", targetId: row.ledger.goalId, createdAt: row.ledger.updatedAt.toISOString(), actions: ["open"] });
    for (const row of waits) items.push({ id: `workflow-wait:${row.run.id}`, kind: "workflow_wait", priority: "high", title: `${row.name} is waiting for you`, detail: `State ${row.run.currentStateId ?? "unknown"}`, link: "/automation", targetId: row.run.id, createdAt: row.run.updatedAt.toISOString(), actions: ["resume", "cancel", "steer"] });
    for (const row of failures) items.push({ id: `workflow-failed:${row.run.id}`, kind: "workflow_failed", priority: "high", title: `${row.name} failed`, detail: row.run.errorText ?? "Workflow failed without an error message.", link: "/automation", targetId: row.run.id, createdAt: row.run.updatedAt.toISOString(), actions: ["open"] });
    for (const connector of connectorErrors) items.push({ id: `connector:${connector.id}`, kind: "connector_error", priority: "high", title: `Connector error: ${connector.name}`, detail: connector.lastError ?? "Health check failed.", link: "/automation", targetId: connector.id, createdAt: connector.updatedAt.toISOString(), actions: ["recheck"] });
    for (const hosted of pendingApps) items.push({ id: `app:${hosted.id}`, kind: "app_publish", priority: "high", title: `Publish ${hosted.name}?`, detail: "Preview passed creation checks and is waiting for a human release decision.", link: "/platform", targetId: hosted.id, createdAt: hosted.updatedAt.toISOString(), actions: ["approve", "reject", "preview"] });
    if (workspace?.budgetWarnedAt || workspace?.budgetStoppedAt) items.push({ id: "budget:workspace", kind: "budget", priority: workspace.budgetStoppedAt ? "critical" : "high", title: workspace.budgetStoppedAt ? "Workspace budget stopped runs" : "Workspace budget warning", detail: workspace.budgetUsdMonth == null ? "Budget policy needs attention." : `Monthly cap: $${workspace.budgetUsdMonth.toFixed(2)}`, link: "/settings", targetId: workspaceId, createdAt: (workspace.budgetStoppedAt ?? workspace.budgetWarnedAt)!.toISOString(), actions: ["open"] });
    for (const agent of workspaceAgents.filter((row) => row.budgetWarnedAt || row.pauseReason === "budget")) items.push({ id: `budget:${agent.id}`, kind: "budget", priority: agent.pauseReason === "budget" ? "critical" : "high", title: `${agent.name} budget needs attention`, detail: agent.pauseReason === "budget" ? "Agent is paused at its hard cap." : "Agent crossed its warning threshold.", link: `/agents/${agent.id}`, targetId: agent.id, createdAt: (agent.budgetWarnedAt ?? new Date()).toISOString(), actions: ["open"] });

    const priority = { critical: 0, high: 1, normal: 2 } as const;
    items.sort((a, b) => priority[a.priority] - priority[b.priority] || Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return { items, counts: { total: items.length, critical: items.filter((item) => item.priority === "critical").length, high: items.filter((item) => item.priority === "high").length } };
  });
}
