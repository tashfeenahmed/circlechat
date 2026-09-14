import { and, eq, inArray, isNotNull, isNull, lt, notInArray, sql as dsql } from "drizzle-orm";
import { db } from "../db/index.js";
import { agents, agentRuns, notifications, tasks, workspaces } from "../db/schema.js";
import { agentQueue } from "../agents/queue.js";
import { publishToWorkspace } from "./events.js";
import { hydrateTasks } from "./tasks-core.js";
import { coerceInt, envNum } from "./env.js";

// ─────────────────────────────────────────────────────────────────────────
// Data retention.
//
// Nothing in CircleChat used to expire. Observed on the live fishbowl after
// ~4 months: 43,423 notification rows (41,001 of them the same unread stall
// alert), a 191 MB `agent_runs` table of which 180 MB was `context_json`
// (a full prompt packet per run, kept forever), Done cards from July still on
// the board, and 506 stale BullMQ `repeat:*` keys under `noeviction`.
//
// Every window below is a default that `workspaces.retention_days` (the
// enterprise governance control, previously stored and never read) overrides
// when set. The sweeps run on the worker's existing periodic goal sweep.
// Pure helpers first so the policy is unit-testable without a database.
// ─────────────────────────────────────────────────────────────────────────

export interface RetentionWindows {
  /** Read notifications older than this are deleted. */
  notificationReadDays: number;
  /** Unread `system` notifications older than this are deleted (a machine-generated
   *  nag nobody has opened in three months is noise, not an inbox). */
  notificationUnreadSystemDays: number;
  /** Hard cap on rows kept per member, newest first. */
  notificationsPerMemberCap: number;
  /** Runs older than this keep their result/trace but lose `context_json`. */
  runContextDays: number;
  /** Runs older than this are deleted outright. */
  runDeleteDays: number;
  /** `done` cards older than this are auto-archived off the board. */
  doneArchiveDays: number;
}

// Same rule as lib/env.ts, reading a raw value so a workspace override can be
// merged in: unset, empty or out of range → the default.
const num = (raw: string | undefined, fallback: number, min = 1): number =>
  coerceInt(raw, fallback, { min });

export function retentionWindows(
  env: Record<string, string | undefined> = process.env,
): RetentionWindows {
  return {
    notificationReadDays: num(env.CC_NOTIFICATION_READ_RETENTION_DAYS, 30),
    notificationUnreadSystemDays: num(env.CC_NOTIFICATION_UNREAD_RETENTION_DAYS, 90),
    notificationsPerMemberCap: num(env.CC_NOTIFICATION_MAX_PER_MEMBER, 500, 10),
    runContextDays: num(env.CC_RUN_CONTEXT_RETENTION_DAYS, 7),
    runDeleteDays: num(env.CC_RUN_RETENTION_DAYS, 90),
    doneArchiveDays: num(env.CC_DONE_ARCHIVE_DAYS, 7),
  };
}

/**
 * The window actually applied for a workspace: its own `retention_days` when an
 * operator set one, otherwise the deployment default. A workspace that asks for
 * a SHORTER window always gets it; a longer one is honoured too (that is what
 * the governance control is for) except for the context-stripping window, which
 * is capped by the delete window — keeping a context longer than the run itself
 * is meaningless.
 */
export function effectiveRetentionDays(
  defaultDays: number,
  workspaceRetentionDays: number | null | undefined,
): number {
  if (workspaceRetentionDays == null) return defaultDays;
  if (!Number.isFinite(workspaceRetentionDays) || workspaceRetentionDays < 1) return defaultDays;
  return Math.floor(workspaceRetentionDays);
}

export function cutoffDate(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

// ── BullMQ repeatable hygiene ────────────────────────────────────────────
// Every agent heartbeat is a repeatable job named `hb:<agentId>`. Deleting an
// agent removes the row but the repeat template (and its `repeat:*` redis keys)
// survives — 506 of them had accumulated, each one waking the worker to
// discover the agent is gone. Under `noeviction` redis never reclaims them.

export interface RepeatableLike {
  /** BullMQ repeat key — the handle `removeRepeatableByKey` takes. */
  key: string;
  /** Job name; heartbeats are `hb:<agentId>`. */
  name?: string | null;
}

export const HEARTBEAT_NAME_RE = /^hb:(.+)$/;

/**
 * Repeat templates safe to remove: heartbeats whose agent no longer exists, or
 * whose agent is no longer eligible for a schedule (deleted/paused agents have
 * their heartbeat cancelled explicitly, so a survivor here is an orphan).
 * Anything that is not a `hb:` heartbeat is left alone — other repeatables
 * (goal sweep, mission sweep) live on a different queue and are not ours to
 * reap. A duplicate key for the SAME agent is kept (cancelAgentHeartbeat owns
 * that case); we only drop what can never run usefully again.
 */
export function staleRepeatableKeys(
  jobs: RepeatableLike[],
  liveAgentIds: Iterable<string>,
): string[] {
  const live = new Set(liveAgentIds);
  const out: string[] = [];
  for (const j of jobs) {
    const m = HEARTBEAT_NAME_RE.exec(String(j.name ?? ""));
    if (!m) continue;
    if (live.has(m[1]!)) continue;
    if (j.key) out.push(j.key);
  }
  return out;
}

// ── Spectator board window ───────────────────────────────────────────────
// The web board has always hidden `done` cards finished more than two weeks
// ago behind a "show older" toggle. The API shipped every one of them anyway,
// so the public fishbowl's task payload grew without bound and a spectator
// could read cards the board itself considers archived history.

export const SPECTATOR_DONE_WINDOW_MS = envNum(
  "CC_SPECTATOR_DONE_WINDOW_MS",
  14 * 24 * 60 * 60 * 1000,
  { min: 1 },
);

export interface DoneWindowRow {
  status: string;
  archived?: boolean;
  updatedAt: Date | string;
}

/** True when a row may be shown given a `done` freshness window (null = no window). */
export function withinDoneWindow(
  row: DoneWindowRow,
  windowMs: number | null,
  now: number = Date.now(),
): boolean {
  if (row.archived) return false;
  if (windowMs == null) return true;
  if (row.status !== "done") return true;
  const ts = row.updatedAt instanceof Date ? row.updatedAt.getTime() : Date.parse(String(row.updatedAt));
  if (!Number.isFinite(ts)) return true;
  return now - ts <= windowMs;
}

// ─────────────────────────────────────────────────────────────────────────
// Sweeps (db/redis side effects). Each one is independently fail-safe: the
// caller runs them from the periodic goal sweep and logs, never throws.
// ─────────────────────────────────────────────────────────────────────────

export async function sweepNotifications(
  now: Date = new Date(),
  w: RetentionWindows = retentionWindows(),
): Promise<{ read: number; unread: number; overCap: number }> {
  const readCutoff = cutoffDate(now, w.notificationReadDays);
  const unreadCutoff = cutoffDate(now, w.notificationUnreadSystemDays);

  const read = await db
    .delete(notifications)
    .where(and(isNotNull(notifications.readAt), lt(notifications.createdAt, readCutoff)))
    .returning({ id: notifications.id });

  // Only machine-generated `system` rows expire while still unread. A mention or
  // a DM someone never opened is theirs to keep.
  const unread = await db
    .delete(notifications)
    .where(
      and(
        isNull(notifications.readAt),
        eq(notifications.kind, "system"),
        lt(notifications.createdAt, unreadCutoff),
      ),
    )
    .returning({ id: notifications.id });

  // Per-member cap: keep the newest N rows, drop the tail. One statement so a
  // member with tens of thousands of rows doesn't need a paged read first.
  const overCap = await db.execute(dsql`
    delete from notifications n
    using (
      select id, row_number() over (partition by member_id order by created_at desc) as rn
      from notifications
    ) ranked
    where ranked.id = n.id and ranked.rn > ${w.notificationsPerMemberCap}
    returning n.id
  `);
  // postgres-js returns a RowList: rows to count, plus a `count` field. Read
  // whichever is present so this does not depend on driver internals.
  const overCapCount = Array.isArray(overCap)
    ? overCap.length
    : Number((overCap as unknown as { count?: number })?.count ?? 0);

  if (read.length || unread.length || overCapCount) {
    console.log(
      `[retention] notifications: deleted read=${read.length} unread_system=${unread.length} over_cap=${overCapCount}`,
    );
  }
  return { read: read.length, unread: unread.length, overCap: overCapCount };
}

/** Agent ids grouped by the retention window that applies to their workspace. */
async function agentIdsByWindow(
  defaultDays: number,
): Promise<{ defaultAgentIds: null | string[]; overrides: Array<{ days: number; agentIds: string[] }> }> {
  const overrideWorkspaces = await db
    .select({ id: workspaces.id, retentionDays: workspaces.retentionDays })
    .from(workspaces)
    .where(isNotNull(workspaces.retentionDays));
  if (!overrideWorkspaces.length) return { defaultAgentIds: null, overrides: [] };

  const rows = await db
    .select({ id: agents.id, workspaceId: agents.workspaceId })
    .from(agents)
    .where(inArray(agents.workspaceId, overrideWorkspaces.map((w) => w.id)));
  const byWorkspace = new Map<string, string[]>();
  for (const r of rows) {
    const list = byWorkspace.get(r.workspaceId) ?? [];
    list.push(r.id);
    byWorkspace.set(r.workspaceId, list);
  }
  const overrides: Array<{ days: number; agentIds: string[] }> = [];
  const covered: string[] = [];
  for (const w of overrideWorkspaces) {
    const ids = byWorkspace.get(w.id) ?? [];
    if (!ids.length) continue;
    covered.push(...ids);
    overrides.push({ days: effectiveRetentionDays(defaultDays, w.retentionDays), agentIds: ids });
  }
  return { defaultAgentIds: covered.length ? covered : null, overrides };
}

export async function sweepAgentRuns(
  now: Date = new Date(),
  w: RetentionWindows = retentionWindows(),
): Promise<{ contextCleared: number; deleted: number }> {
  let contextCleared = 0;
  let deleted = 0;

  // `agent_runs` has no workspace column, so per-workspace retention is applied
  // through the agent roster. Workspaces without an override share one global
  // pass that simply excludes the overridden agents.
  const { defaultAgentIds: excluded, overrides } = await agentIdsByWindow(w.runDeleteDays);

  const clearContext = async (days: number, scope?: { include?: string[]; exclude?: string[] }) => {
    const conds = [
      lt(agentRuns.startedAt, cutoffDate(now, Math.min(w.runContextDays, days))),
      dsql`${agentRuns.contextJson} <> '{}'::jsonb`,
    ];
    if (scope?.include?.length) conds.push(inArray(agentRuns.agentId, scope.include));
    if (scope?.exclude?.length) conds.push(notInArray(agentRuns.agentId, scope.exclude));
    const rows = await db
      .update(agentRuns)
      .set({ contextJson: {} })
      .where(and(...conds))
      .returning({ id: agentRuns.id });
    contextCleared += rows.length;
  };

  const deleteRuns = async (days: number, scope?: { include?: string[]; exclude?: string[] }) => {
    const conds = [lt(agentRuns.startedAt, cutoffDate(now, days))];
    if (scope?.include?.length) conds.push(inArray(agentRuns.agentId, scope.include));
    if (scope?.exclude?.length) conds.push(notInArray(agentRuns.agentId, scope.exclude));
    const rows = await db.delete(agentRuns).where(and(...conds)).returning({ id: agentRuns.id });
    deleted += rows.length;
  };

  await clearContext(w.runDeleteDays, excluded ? { exclude: excluded } : undefined);
  await deleteRuns(w.runDeleteDays, excluded ? { exclude: excluded } : undefined);
  for (const o of overrides) {
    await clearContext(o.days, { include: o.agentIds });
    await deleteRuns(o.days, { include: o.agentIds });
  }

  if (contextCleared || deleted) {
    console.log(`[retention] agent_runs: context_json cleared=${contextCleared} rows deleted=${deleted}`);
  }
  return { contextCleared, deleted };
}

/**
 * Auto-archive `done` cards. The board is a work surface, not an archive: once
 * a card has been done for `doneArchiveDays` (workspace `retention_days` wins
 * when set) it is archived, which removes it from every task list — including
 * the public/spectator one, which already excludes archived rows.
 */
export async function sweepDoneCards(
  now: Date = new Date(),
  w: RetentionWindows = retentionWindows(),
): Promise<number> {
  const wss = await db
    .select({ id: workspaces.id, retentionDays: workspaces.retentionDays })
    .from(workspaces);
  let archived = 0;
  for (const ws of wss) {
    const days = effectiveRetentionDays(w.doneArchiveDays, ws.retentionDays);
    const rows = await db
      .update(tasks)
      .set({ archived: true })
      .where(
        and(
          eq(tasks.workspaceId, ws.id),
          eq(tasks.status, "done"),
          eq(tasks.archived, false),
          lt(tasks.updatedAt, cutoffDate(now, days)),
        ),
      )
      .returning();
    if (!rows.length) continue;
    archived += rows.length;
    // Tell open boards so a card doesn't linger in a stale client until reload.
    const hydrated = await hydrateTasks(rows).catch(() => []);
    for (const t of hydrated) {
      await publishToWorkspace(ws.id, {
        type: "task.updated",
        workspaceId: ws.id,
        taskId: (t as { id: string }).id,
        task: t,
      }).catch(() => {});
    }
    console.log(`[retention] board: archived ${rows.length} done card(s) older than ${days}d in ${ws.id}`);
  }
  return archived;
}

/** Drop BullMQ repeat templates for agents that no longer exist. */
export async function sweepStaleRepeatables(): Promise<number> {
  const jobs = await agentQueue.getRepeatableJobs();
  if (!jobs.length) return 0;
  const live = await db.select({ id: agents.id }).from(agents);
  const keys = staleRepeatableKeys(jobs, live.map((a) => a.id));
  let removed = 0;
  for (const key of keys) {
    try {
      await agentQueue.removeRepeatableByKey(key);
      removed++;
    } catch {
      /* another worker won the race — fine */
    }
  }
  if (removed) console.log(`[retention] redis: removed ${removed} orphaned repeatable heartbeat(s)`);
  return removed;
}

/**
 * One retention pass. Called from the worker's periodic goal sweep; each step
 * is isolated so a failure in one does not stop the others. Throttled through
 * the caller (the sweep runs every GOAL_SWEEP_EVERY_MS) via `shouldRunNow`.
 */
export async function runRetentionSweep(now: Date = new Date()): Promise<void> {
  const w = retentionWindows();
  await sweepNotifications(now, w).catch((e) =>
    console.error("[retention] notification sweep failed", (e as Error).message),
  );
  await sweepAgentRuns(now, w).catch((e) =>
    console.error("[retention] agent_runs sweep failed", (e as Error).message),
  );
  await sweepDoneCards(now, w).catch((e) =>
    console.error("[retention] done-card sweep failed", (e as Error).message),
  );
  await sweepStaleRepeatables().catch((e) =>
    console.error("[retention] repeatable sweep failed", (e as Error).message),
  );
}

// Keep the sweep off the 3-minute goal tick — the deletes are cheap but the
// per-member cap scan is not. The interval gate is exported for the worker.
export const RETENTION_INTERVAL_MS = Number(
  process.env.CC_RETENTION_SWEEP_EVERY_MS ?? 60 * 60 * 1000,
);

export function shouldRunNow(lastRunAt: number | null, now: number, intervalMs: number): boolean {
  if (lastRunAt == null) return true;
  return now - lastRunAt >= intervalMs;
}
