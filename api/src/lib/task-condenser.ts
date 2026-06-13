import { and, asc, eq, lt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { taskComments, taskSummaries, members, tasks } from "../db/schema.js";
import { chat, plannerEnabled } from "./completion.js";

// Condensation-as-event for long task threads (OpenHands condenser). The task
// context shows only the most recent KEEP_RECENT comments; this keeps a rolling
// summary of everything OLDER so the agent sees the head of the thread (what
// was decided, what was tried) without loading 50 comments. The summary chains:
// each refresh feeds the PREVIOUS summary + the newly-aged comments, like
// OpenHands' LLMSummarizingCondenser. Opt-in (CONDENSE_TASKS=on) + requires a
// planner backend; fail-safe (any error leaves the existing summary intact).

export const KEEP_RECENT = 10; // comments always shown live (matches the context window)
const REFRESH_GAP = 5; // only re-summarize once this many new comments have aged past the window
const MAX_SUMMARY_CHARS = 1500;
const MAX_INPUT_CHARS = 8000;

export function condenserEnabled(): boolean {
  return process.env.CONDENSE_TASKS === "on" && plannerEnabled();
}

// Pure: should we (re)build the summary? Yes when there are older comments
// beyond the live window AND the stored summary lags the aged set by the gap
// (or doesn't exist). Exported for tests.
export function shouldRefresh(totalComments: number, summarizedCount: number): boolean {
  const agedOut = totalComments - KEEP_RECENT; // comments that have scrolled past the window
  if (agedOut <= 0) return false;
  return agedOut - summarizedCount >= REFRESH_GAP || summarizedCount === 0;
}

export async function loadTaskSummary(taskId: string): Promise<string | null> {
  const [row] = await db
    .select({ summary: taskSummaries.summary })
    .from(taskSummaries)
    .where(eq(taskSummaries.taskId, taskId))
    .limit(1);
  return row?.summary?.trim() ? row.summary : null;
}

// Fire-and-forget: refresh the rolling summary if the thread has grown enough.
// Callers (context builder) don't await this on the hot path.
export async function maybeSummarizeTaskThread(taskId: string): Promise<void> {
  if (!condenserEnabled()) return;
  try {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(taskComments)
      .where(and(eq(taskComments.taskId, taskId), sql`${taskComments.deletedAt} is null`));
    const total = Number(n ?? 0);

    const [existing] = await db
      .select()
      .from(taskSummaries)
      .where(eq(taskSummaries.taskId, taskId))
      .limit(1);
    const summarizedCount = existing?.commentCount ?? 0;
    if (!shouldRefresh(total, summarizedCount)) return;

    // The comments to summarize = everything except the live tail (KEEP_RECENT).
    const agedCount = total - KEEP_RECENT;
    if (agedCount <= 0) return;
    const aged = await db
      .select({ ts: taskComments.ts, memberId: taskComments.memberId, bodyMd: taskComments.bodyMd })
      .from(taskComments)
      .where(and(eq(taskComments.taskId, taskId), sql`${taskComments.deletedAt} is null`))
      .orderBy(asc(taskComments.ts))
      .limit(agedCount);
    if (!aged.length) return;

    // Resolve handles for readability.
    const memberIds = Array.from(new Set(aged.map((c) => c.memberId)));
    const handleRows = memberIds.length
      ? await db.select({ id: members.id, kind: members.kind, refId: members.refId }).from(members).where(
          sql`${members.id} in (${sql.join(memberIds.map((m) => sql`${m}`), sql`, `)})`,
        )
      : [];
    const handleByMember = new Map(handleRows.map((m) => [m.id, m.kind === "agent" ? "agent" : "user"]));

    const digest = aged
      .map((c) => `${handleByMember.get(c.memberId) ?? "?"}: ${c.bodyMd.replace(/\s+/g, " ").slice(0, 300)}`)
      .join("\n")
      .slice(0, MAX_INPUT_CHARS);

    const [taskRow] = await db
      .select({ title: tasks.title, workspaceId: tasks.workspaceId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);
    if (!taskRow) return;

    const out = await chat(
      [
        {
          role: "system",
          content:
            "You compress the older comments of a task thread into a tight factual summary so a " +
            "teammate can catch up without reading them all. Preserve: decisions made, what was " +
            "tried and the outcome, blockers raised and whether they cleared, and any concrete facts " +
            "(URLs, file paths, names). Drop chit-chat and acknowledgements. Fold the PRIOR SUMMARY " +
            "(if given) into the result so nothing earlier is lost. Output ONLY the summary, under " +
            MAX_SUMMARY_CHARS + " characters, no preamble.",
        },
        {
          role: "user",
          content:
            `TASK: ${taskRow.title}\n\n` +
            (existing?.summary ? `PRIOR SUMMARY:\n${existing.summary}\n\n` : "") +
            `OLDER COMMENTS (oldest first):\n${digest}`,
        },
      ],
      { temperature: 0, maxTokens: 600, timeoutMs: 60_000 },
    ).catch(() => null);

    const summary = (out || "").trim().slice(0, MAX_SUMMARY_CHARS);
    if (!summary) return;

    const throughTs = aged[aged.length - 1].ts;
    await db
      .insert(taskSummaries)
      .values({
        taskId,
        workspaceId: taskRow.workspaceId,
        summary,
        commentCount: agedCount,
        throughTs,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: taskSummaries.taskId,
        set: { summary, commentCount: agedCount, throughTs, updatedAt: new Date() },
      });
  } catch (e) {
    console.error(`[task-condenser] ${taskId} failed`, (e as Error).message);
  }
}
