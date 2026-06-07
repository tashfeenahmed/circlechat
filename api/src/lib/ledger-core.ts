// Goal ledger — Magentic-One-style externalized plan + progress state, one row
// per goal. The context packet injects it every agent wake so agents read the
// current plan, established facts, and known dead-ends instead of re-deriving
// intent from noisy channel history (the driver of echo loops, no-op runs, and
// credential dead-ends). The stall machinery here lets the goal sweeper detect
// "work is supposedly happening but nothing advanced" and trigger a re-plan.
import { eq, inArray, sql as dsql } from "drizzle-orm";
import { db } from "../db/index.js";
import { goalLedgers, type GoalLedger } from "../db/schema.js";

const MAX_FACTS = 40;
const MAX_PROGRESS_NOTES = 30;
const MAX_DEAD_ENDS = 30;

export async function loadLedger(goalId: string): Promise<GoalLedger | null> {
  const [row] = await db.select().from(goalLedgers).where(eq(goalLedgers.goalId, goalId)).limit(1);
  return row ?? null;
}

export async function loadLedgers(goalIds: string[]): Promise<Map<string, GoalLedger>> {
  if (!goalIds.length) return new Map();
  const rows = await db.select().from(goalLedgers).where(inArray(goalLedgers.goalId, goalIds));
  return new Map(rows.map((r) => [r.goalId, r]));
}

// Write the planner's plan into the ledger. On first plan it creates the row;
// on re-plan it overwrites `plan`, bumps version/replanCount, resets the stall
// counter, but PRESERVES accumulated facts/progress/dead-ends so learning
// survives the re-plan (the whole point — don't re-propose what already failed).
export async function writePlan(opts: {
  goalId: string;
  workspaceId: string;
  plan: string;
  isReplan?: boolean;
}): Promise<void> {
  const now = new Date();
  await db
    .insert(goalLedgers)
    .values({
      goalId: opts.goalId,
      workspaceId: opts.workspaceId,
      plan: opts.plan,
      lastProgressAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: goalLedgers.goalId,
      set: {
        plan: opts.plan,
        stallCount: 0,
        lastProgressAt: now,
        updatedAt: now,
        ...(opts.isReplan
          ? { replanCount: dsql`${goalLedgers.replanCount} + 1`, version: dsql`${goalLedgers.version} + 1` }
          : {}),
      },
    })
    .catch(() => {});
}

// Append a verified fact (deduped, bounded).
export async function appendFact(goalId: string, fact: string): Promise<void> {
  const f = fact.trim();
  if (!f) return;
  const led = await loadLedger(goalId);
  if (!led) return;
  if (led.facts.includes(f)) return;
  const facts = [...led.facts, f].slice(-MAX_FACTS);
  await db.update(goalLedgers).set({ facts, updatedAt: new Date() }).where(eq(goalLedgers.goalId, goalId)).catch(() => {});
}

export async function appendProgressNote(goalId: string, by: string, note: string): Promise<void> {
  const n = note.trim();
  if (!n) return;
  const led = await loadLedger(goalId);
  if (!led) return;
  const progressNotes = [...led.progressNotes, { by, note: n, ts: new Date().toISOString() }].slice(-MAX_PROGRESS_NOTES);
  await db
    .update(goalLedgers)
    .set({ progressNotes, updatedAt: new Date() })
    .where(eq(goalLedgers.goalId, goalId))
    .catch(() => {});
}

export async function appendDeadEnd(goalId: string, deadEnd: string): Promise<void> {
  const d = deadEnd.trim();
  if (!d) return;
  const led = await loadLedger(goalId);
  if (!led) return;
  if (led.triedDeadEnds.includes(d)) return;
  const triedDeadEnds = [...led.triedDeadEnds, d].slice(-MAX_DEAD_ENDS);
  await db
    .update(goalLedgers)
    .set({ triedDeadEnds, updatedAt: new Date() })
    .where(eq(goalLedgers.goalId, goalId))
    .catch(() => {});
}

// Real forward motion happened (a task advanced): reset the stall counter and
// stamp the progress clock. Idempotent / best-effort.
export async function recordProgress(goalId: string): Promise<void> {
  await db
    .update(goalLedgers)
    .set({ stallCount: 0, lastProgressAt: new Date(), updatedAt: new Date() })
    .where(eq(goalLedgers.goalId, goalId))
    .catch(() => {});
}

// A sweep observed no forward motion within the stall window: increment.
export async function bumpStall(goalId: string): Promise<number> {
  const [row] = await db
    .update(goalLedgers)
    .set({ stallCount: dsql`${goalLedgers.stallCount} + 1`, updatedAt: new Date() })
    .where(eq(goalLedgers.goalId, goalId))
    .returning({ stallCount: goalLedgers.stallCount });
  return row?.stallCount ?? 0;
}
