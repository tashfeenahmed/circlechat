// Cross-message dedupe for agent posts. The single-body reply-guard catches
// runaway repetition WITHIN one message, but agents also lock into a pattern
// where each run produces a near-identical message ("demo URL was not shown",
// observed 3× in #backlinks across separate runs). Same author, same
// conversation, same content — different message IDs, so the in-body
// repetition rule never sees them.
//
// Strategy: 3-word shingles, Jaccard similarity, threshold 0.85, against the
// last 50 messages in the conversation. Normalization strips URLs, @mentions,
// and punctuation so "ping @nova" and "ping @ada" don't count as different.
// Short bodies skip the check — "ok"/"thanks"/"👍" repeat naturally and the
// false-positive cost is high.

import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { messages, taskComments } from "../db/schema.js";

const RECENT_LIMIT = 50;
const SIMILARITY_THRESHOLD = 0.85;
const MIN_NORMALIZED_LEN = 30;
const SHINGLE_SIZE = 3;

export type DedupeResult =
  | { ok: true }
  | { ok: false; reason: "duplicate_of_recent"; againstId: string; score: number };

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/@[a-z0-9_]+/g, " ")
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shingles(normalized: string, k: number): Set<string> {
  const words = normalized.split(" ").filter(Boolean);
  if (words.length < k) return new Set([words.join(" ")]);
  const out = new Set<string>();
  for (let i = 0; i <= words.length - k; i++) {
    out.add(words.slice(i, i + k).join(" "));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export async function checkRecentDuplicate(
  conversationId: string,
  bodyMd: string,
): Promise<DedupeResult> {
  const incomingNorm = normalize(bodyMd);
  if (incomingNorm.length < MIN_NORMALIZED_LEN) return { ok: true };
  const incoming = shingles(incomingNorm, SHINGLE_SIZE);

  const recents = await db
    .select({ id: messages.id, bodyMd: messages.bodyMd })
    .from(messages)
    .where(
      and(eq(messages.conversationId, conversationId), isNull(messages.deletedAt)),
    )
    .orderBy(desc(messages.ts))
    .limit(RECENT_LIMIT);

  for (const r of recents) {
    const norm = normalize(r.bodyMd);
    if (norm.length < MIN_NORMALIZED_LEN) continue;
    const score = jaccard(incoming, shingles(norm, SHINGLE_SIZE));
    if (score >= SIMILARITY_THRESHOLD) {
      return {
        ok: false,
        reason: "duplicate_of_recent",
        againstId: r.id,
        score: Math.round(score * 100) / 100,
      };
    }
  }
  return { ok: true };
}

// Same cross-message dedupe, but for TASK COMMENTS. The begging loop relocated
// here: approval-level dedupe killed duplicate approval CARDS, so agents moved
// to re-posting "still blocked, need credentials" as a fresh task_comment every
// hour (no message-table dedupe ever saw those). Compare an incoming comment
// against the recent comments on the SAME task; a near-identical restatement is
// noise, not progress. Threshold matches the message dedupe.
export async function checkRecentDuplicateTaskComment(
  taskId: string,
  bodyMd: string,
): Promise<DedupeResult> {
  const incomingNorm = normalize(bodyMd);
  if (incomingNorm.length < MIN_NORMALIZED_LEN) return { ok: true };
  const incoming = shingles(incomingNorm, SHINGLE_SIZE);

  const recents = await db
    .select({ id: taskComments.id, bodyMd: taskComments.bodyMd })
    .from(taskComments)
    .where(and(eq(taskComments.taskId, taskId), isNull(taskComments.deletedAt)))
    .orderBy(desc(taskComments.ts))
    .limit(RECENT_LIMIT);

  for (const r of recents) {
    const n = normalize(r.bodyMd);
    if (n.length < MIN_NORMALIZED_LEN) continue;
    const score = jaccard(incoming, shingles(n, SHINGLE_SIZE));
    if (score >= SIMILARITY_THRESHOLD) {
      return { ok: false, reason: "duplicate_of_recent", againstId: r.id, score: Math.round(score * 100) / 100 };
    }
  }
  return { ok: true };
}
