// Cross-message dedupe for agent posts. The single-body reply-guard catches
// runaway repetition WITHIN one message, but agents also lock into a pattern
// where each run produces a near-identical message ("demo URL was not shown",
// observed 3× in #backlinks across separate runs). Same author, same
// conversation, same content — different message IDs, so the in-body
// repetition rule never sees them.
//
// Two layers:
//   1. SAME SURFACE — the last RECENT_LIMIT messages in this conversation /
//      comments on this task (any author, no time bound).
//   2. CROSS SURFACE, TIME-WINDOWED — the same fact narrated into chat AND a
//      task comment (or onto two different task cards, by two agents) within
//      CROSS_WINDOW_MS. Observed live: "Backend is live and verified — `node
//      server.js` on port 3000" posted by two agents as comments on different
//      tasks, and "Proof package v28 shipped" mirrored into chat + task.
//      Agents only — humans never hit this code path — and the window is
//      short, so a genuine re-announcement a day later still lands.
//
// The similarity primitives live in lib/text-similarity.ts (pure, tested).

import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { messages, taskComments } from "../db/schema.js";
import { findNearDuplicate } from "../lib/text-similarity.js";

const RECENT_LIMIT = 50;
// Cross-surface window + fetch bound. Six hours covers the heartbeat cadence
// that produces the mirrored posts (agents re-narrating within a few runs)
// without suppressing a legitimate next-day status.
export const CROSS_WINDOW_MS = 6 * 60 * 60 * 1000;
const CROSS_LIMIT = 120;

export type DedupeSurface = "message" | "task_comment";

export type DedupeResult =
  | { ok: true }
  | {
      ok: false;
      reason: "duplicate_of_recent";
      againstId: string;
      score: number;
      // Which table the match came from — lets the executor's trace say
      // "duplicate of task comment tc_… " when a chat post mirrors a comment.
      surface: DedupeSurface;
    };

type Row = { id: string; bodyMd: string };

function hit(surface: DedupeSurface, r: { candidate: Row; score: number }): DedupeResult {
  return {
    ok: false,
    reason: "duplicate_of_recent",
    againstId: r.candidate.id,
    score: r.score,
    surface,
  };
}

async function recentMessagesIn(conversationId: string): Promise<Row[]> {
  return db
    .select({ id: messages.id, bodyMd: messages.bodyMd })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), isNull(messages.deletedAt)))
    .orderBy(desc(messages.ts))
    .limit(RECENT_LIMIT);
}

async function recentCommentsOn(taskId: string): Promise<Row[]> {
  return db
    .select({ id: taskComments.id, bodyMd: taskComments.bodyMd })
    .from(taskComments)
    .where(and(eq(taskComments.taskId, taskId), isNull(taskComments.deletedAt)))
    .orderBy(desc(taskComments.ts))
    .limit(RECENT_LIMIT);
}

// Windowed, workspace-wide scans for the cross-surface layer. Bounded by
// CROSS_LIMIT so a busy board can't turn one post into a big read.
async function windowedComments(since: Date): Promise<Row[]> {
  return db
    .select({ id: taskComments.id, bodyMd: taskComments.bodyMd })
    .from(taskComments)
    .where(and(gte(taskComments.ts, since), isNull(taskComments.deletedAt)))
    .orderBy(desc(taskComments.ts))
    .limit(CROSS_LIMIT);
}

async function windowedMessages(since: Date): Promise<Row[]> {
  return db
    .select({ id: messages.id, bodyMd: messages.bodyMd })
    .from(messages)
    .where(and(gte(messages.ts, since), isNull(messages.deletedAt)))
    .orderBy(desc(messages.ts))
    .limit(CROSS_LIMIT);
}

// Incoming CHAT MESSAGE: compare against the conversation's recent messages,
// then against every task comment posted in the window (the same fact already
// narrated onto a task card).
export async function checkRecentDuplicate(
  conversationId: string,
  bodyMd: string,
): Promise<DedupeResult> {
  const sameSurface = findNearDuplicate(bodyMd, await recentMessagesIn(conversationId));
  if (sameSurface) return hit("message", sameSurface);

  const since = new Date(Date.now() - CROSS_WINDOW_MS);
  const cross = findNearDuplicate(bodyMd, await windowedComments(since));
  if (cross) return hit("task_comment", cross);
  return { ok: true };
}

// Incoming TASK COMMENT. The begging loop relocated here: approval-level
// dedupe killed duplicate approval CARDS, so agents moved to re-posting "still
// blocked, need credentials" as a fresh task_comment every hour. Compare
// against the recent comments on the SAME task, then (windowed) against
// comments on every other task — two agents posting the identical verification
// line onto sibling cards — and against recent chat messages (the same fact
// posted to chat first, then mirrored onto the card).
export async function checkRecentDuplicateTaskComment(
  taskId: string,
  bodyMd: string,
): Promise<DedupeResult> {
  const sameTask = findNearDuplicate(bodyMd, await recentCommentsOn(taskId));
  if (sameTask) return hit("task_comment", sameTask);

  const since = new Date(Date.now() - CROSS_WINDOW_MS);
  const otherTasks = findNearDuplicate(bodyMd, await windowedComments(since));
  if (otherTasks) return hit("task_comment", otherTasks);
  const chat = findNearDuplicate(bodyMd, await windowedMessages(since));
  if (chat) return hit("message", chat);
  return { ok: true };
}
