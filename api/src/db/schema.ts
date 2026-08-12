import {
  pgTable,
  text,
  varchar,
  timestamp,
  boolean,
  integer,
  jsonb,
  real,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ───────────────── workspaces ─────────────────
export const workspaces = pgTable(
  "workspaces",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    name: varchar("name", { length: 100 }).notNull(),
    handle: varchar("handle", { length: 40 }).notNull(),
    createdBy: varchar("created_by", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    // Workspace-level "what we build" prose, inherited by every agent's
    // runtime prompt. Set once per workspace; new agents auto-pick it up.
    mission: text("mission").notNull().default(""),
    // Auto-planning policy: 'auto' = a new goal is decomposed + started
    // automatically (no manual Plan button); 'off' = manual planning only.
    autoPlan: varchar("auto_plan", { length: 10 }).notNull().default("auto"),
    // Workspace-wide monthly spend cap (estimated USD, NULL = unlimited).
    // Exceeding it skips every agent run here without flipping agent statuses.
    budgetUsdMonth: real("budget_usd_month"),
    budgetWarnedAt: timestamp("budget_warned_at", { withTimezone: true }),
    // When the hard-stop notification last fired (separate from the 80% warn
    // marker so "budget reached" still notifies after a warning already did).
    budgetStoppedAt: timestamp("budget_stopped_at", { withTimezone: true }),
    // Enterprise governance controls. NULL retention means operator policy;
    // residency is an explicit deployment/data-placement label.
    retentionDays: integer("retention_days"),
    dataResidency: varchar("data_residency", { length: 32 }).notNull().default("operator"),
  },
  (t) => ({
    handleIdx: uniqueIndex("workspaces_handle_key").on(t.handle),
  }),
);

// ───────────────── workspace_members (user ↔ workspace) ─────────────────
export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
    userId: varchar("user_id", { length: 32 }).notNull(),
    role: varchar("role", { length: 20 }).notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.userId] }),
    userIdx: index("workspace_members_user_idx").on(t.userId),
  }),
);

// ───────────────── users ─────────────────
export const users = pgTable(
  "users",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    email: varchar("email", { length: 255 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    handle: varchar("handle", { length: 40 }).notNull(),
    avatarColor: varchar("avatar_color", { length: 20 }).notNull().default("slate"),
    passwordHash: text("password_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    emailIdx: uniqueIndex("users_email_key").on(t.email),
    handleIdx: uniqueIndex("users_handle_key").on(t.handle),
  }),
);

// ───────────────── agents ─────────────────
export const agents = pgTable(
  "agents",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
    handle: varchar("handle", { length: 40 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    avatarColor: varchar("avatar_color", { length: 20 }).notNull().default("accent"),
    kind: varchar("kind", { length: 20 }).notNull(), // openclaw | hermes | custom
    adapter: varchar("adapter", { length: 20 }).notNull(), // webhook | socket
    configJson: jsonb("config_json").$type<Record<string, unknown>>().notNull().default({}),
    model: varchar("model", { length: 80 }).notNull().default(""),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    // Free-form capability tags ("research", "frontend", "copywriting", …) used
    // by the goal planner to route decomposed subtasks to the right agent. The
    // org chart says who reports to whom; capabilities say who can do what.
    capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
    status: varchar("status", { length: 20 }).notNull().default("provisioning"),
    // Why status=paused: 'manual' (human clicked pause) | 'budget' (monthly
    // hard stop). Resume clears it; a budget pause re-trips until the cap is raised.
    pauseReason: varchar("pause_reason", { length: 40 }),
    // Monthly spend cap in estimated USD (NULL = unlimited): month-to-date
    // sum of agent_runs.cost_usd is checked before every run.
    budgetUsdMonth: real("budget_usd_month"),
    budgetWarnedAt: timestamp("budget_warned_at", { withTimezone: true }),
    title: varchar("title", { length: 160 }).notNull().default(""),
    brief: text("brief").notNull().default(""),
    heartbeatIntervalSec: integer("heartbeat_interval_sec").notNull().default(3600),
    botToken: varchar("bot_token", { length: 80 }).notNull(),
    callbackUrl: text("callback_url"),
    createdBy: varchar("created_by", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    handleWsIdx: uniqueIndex("agents_ws_handle_key").on(t.workspaceId, t.handle),
    tokenIdx: uniqueIndex("agents_token_key").on(t.botToken),
    wsIdx: index("agents_ws_idx").on(t.workspaceId),
  }),
);

// ───────────────── members (polymorphic, per-workspace) ─────────────────
// One row per (workspace, user-or-agent). A user joining a second workspace
// gets a second member row with a different id.
export const members = pgTable(
  "members",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
    kind: varchar("kind", { length: 10 }).notNull(), // user | agent
    refId: varchar("ref_id", { length: 32 }).notNull(),
    // Org chart: pointer to another member in the same workspace. null = root.
    reportsTo: varchar("reports_to", { length: 32 }),
  },
  (t) => ({
    refIdx: uniqueIndex("members_ws_kind_ref_key").on(t.workspaceId, t.kind, t.refId),
    reportsToIdx: index("members_reports_to_idx").on(t.workspaceId, t.reportsTo),
  }),
);

// ───────────────── conversations ─────────────────
export const conversations = pgTable(
  "conversations",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
    kind: varchar("kind", { length: 10 }).notNull(), // channel | dm
    name: varchar("name", { length: 100 }),
    topic: text("topic").notNull().default(""),
    isPrivate: boolean("is_private").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    createdBy: varchar("created_by", { length: 32 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    wsIdx: index("conversations_ws_idx").on(t.workspaceId),
  }),
);

// ───────────────── conversation_members ─────────────────
export const conversationMembers = pgTable(
  "conversation_members",
  {
    conversationId: varchar("conversation_id", { length: 32 }).notNull(),
    memberId: varchar("member_id", { length: 32 }).notNull(),
    role: varchar("role", { length: 20 }).notNull().default("member"),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    muted: boolean("muted").notNull().default(false),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.conversationId, t.memberId] }),
    memberIdx: index("conv_members_member_idx").on(t.memberId),
  }),
);

// ───────────────── messages ─────────────────
export const messages = pgTable(
  "messages",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    conversationId: varchar("conversation_id", { length: 32 }).notNull(),
    memberId: varchar("member_id", { length: 32 }).notNull(),
    parentId: varchar("parent_id", { length: 32 }),
    bodyMd: text("body_md").notNull(),
    attachmentsJson: jsonb("attachments_json").$type<Attachment[]>().notNull().default([]),
    mentions: jsonb("mentions").$type<string[]>().notNull().default([]),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    convTsIdx: index("messages_conv_ts_idx").on(t.conversationId, t.ts),
    parentIdx: index("messages_parent_idx").on(t.parentId),
  }),
);

export interface Attachment {
  key: string;
  name: string;
  contentType: string;
  size: number;
  url: string;
}

// ───────────────── reactions ─────────────────
export const reactions = pgTable(
  "reactions",
  {
    messageId: varchar("message_id", { length: 32 }).notNull(),
    memberId: varchar("member_id", { length: 32 }).notNull(),
    emoji: varchar("emoji", { length: 32 }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.messageId, t.memberId, t.emoji] }),
  }),
);

// ───────────────── agent_runs ─────────────────
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    agentId: varchar("agent_id", { length: 32 }).notNull(),
    trigger: varchar("trigger", { length: 30 }).notNull(), // scheduled | mention | dm | assigned | approval_response | test
    status: varchar("status", { length: 20 }).notNull().default("queued"), // queued | running | ok | failed
    contextJson: jsonb("context_json").$type<Record<string, unknown>>().notNull().default({}),
    resultJson: jsonb("result_json").$type<Record<string, unknown>>().notNull().default({}),
    traceJson: jsonb("trace_json").$type<string[]>().notNull().default([]),
    conversationId: varchar("conversation_id", { length: 32 }),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    costUsd: real("cost_usd"),
    // Estimated tokens behind cost_usd (context+response chars/4 × loop
    // multiplier) — agent runtimes call the gateway directly, so real usage
    // never reaches us. Estimated is better than blind; see lib/budgets.ts.
    tokensEst: integer("tokens_est"),
    errorText: text("error_text"),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    cancelledBy: varchar("cancelled_by", { length: 32 }),
    steerJson: jsonb("steer_json").$type<Array<Record<string, unknown>>>().notNull().default([]),
    followupJson: jsonb("followup_json").$type<Array<Record<string, unknown>>>().notNull().default([]),
    timeoutAt: timestamp("timeout_at", { withTimezone: true }),
    ownerMemberId: varchar("owner_member_id", { length: 32 }),
  },
  (t) => ({
    agentStartedIdx: index("agent_runs_agent_started_idx").on(t.agentId, t.startedAt),
  }),
);

// ───────────────── approvals ─────────────────
export const approvals = pgTable("approvals", {
  id: varchar("id", { length: 32 }).primaryKey(),
  agentRunId: varchar("agent_run_id", { length: 32 }).notNull(),
  agentId: varchar("agent_id", { length: 32 }).notNull(),
  conversationId: varchar("conversation_id", { length: 32 }),
  scope: varchar("scope", { length: 60 }).notNull(),
  action: text("action").notNull(),
  payloadJson: jsonb("payload_json").$type<Record<string, unknown>>().notNull().default({}),
  status: varchar("status", { length: 20 }).notNull().default("pending"), // pending | approved | denied | applied (approved consumed by replay)
  decidedBy: varchar("decided_by", { length: 32 }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionNote: text("decision_note"), // optional human comment delivered to the agent with the decision
  // Env-var NAMES delivered to the agent's runtime on approval (values are
  // written to the agent home's .env and never stored in the DB).
  deliveredSecrets: jsonb("delivered_secrets").$type<string[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ───────────────── sessions ─────────────────
export const sessions = pgTable("sessions", {
  id: varchar("id", { length: 64 }).primaryKey(),
  userId: varchar("user_id", { length: 32 }).notNull(),
  currentWorkspaceId: varchar("current_workspace_id", { length: 32 }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ───────────────── invites ─────────────────
export const invites = pgTable(
  "invites",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    token: varchar("token", { length: 64 }).notNull(),
    invitedBy: varchar("invited_by", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .default(sql`now() + interval '7 days'`)
      .notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    role: varchar("role", { length: 40 }).notNull().default("member"),
    channelIds: jsonb("channel_ids").$type<string[]>().notNull().default([]),
  },
  (t) => ({
    tokenIdx: uniqueIndex("invites_token_key").on(t.token),
    wsIdx: index("invites_ws_idx").on(t.workspaceId),
  }),
);

// ───────────────── task_summaries (condensed thread history) ─────────────
// Rolling summary of a task's OLDER comments so an agent sees the head of a
// long thread without loading every comment. See lib/task-condenser.ts.
export const taskSummaries = pgTable("task_summaries", {
  taskId: varchar("task_id", { length: 32 }).primaryKey(),
  workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
  summary: text("summary").notNull().default(""),
  commentCount: integer("comment_count").notNull().default(0),
  throughTs: timestamp("through_ts", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ───────────────── memory_blocks (Letta-style in-context memory) ─────────
// Labeled prose blocks compiled into EVERY agent prompt and self-edited by the
// agent. A `shared` block is attached to every agent in the workspace (the
// team whiteboard); a private block belongs to one agent. char_limit is shown
// to the model so it self-manages size. See lib/memory-blocks.ts.
export const memoryBlocks = pgTable(
  "memory_blocks",
  {
    id: varchar("id", { length: 40 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
    description: text("description").notNull().default(""),
    value: text("value").notNull().default(""),
    charLimit: integer("char_limit").notNull().default(2000),
    shared: boolean("shared").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    updatedBy: varchar("updated_by", { length: 32 }),
  },
  (t) => ({
    wsIdx: index("memory_blocks_ws_idx").on(t.workspaceId),
  }),
);

// Join: which blocks an agent has, under what agent-local label. A shared block
// has one row per attached agent, all pointing at the same block_id.
export const agentMemoryBlocks = pgTable(
  "agent_memory_blocks",
  {
    agentId: varchar("agent_id", { length: 32 }).notNull(),
    label: varchar("label", { length: 40 }).notNull(),
    blockId: varchar("block_id", { length: 40 }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.agentId, t.label] }),
    blockIdx: index("agent_memory_blocks_block_idx").on(t.blockId),
  }),
);

// ───────────────── memory_kv (per-agent scratch memory) ─────────────────
// scope: 'global' | 'conversation' | 'task'. scopeId is the conversationId
// or taskId for the latter two; '' (empty string, NOT null) for global so
// the composite primary key stays well-defined.
export const memoryKv = pgTable(
  "memory_kv",
  {
    agentId: varchar("agent_id", { length: 32 }).notNull(),
    scope: varchar("scope", { length: 20 }).notNull().default("global"),
    scopeId: varchar("scope_id", { length: 32 }).notNull().default(""),
    key: varchar("key", { length: 100 }).notNull(),
    valueJson: jsonb("value_json").$type<unknown>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.agentId, t.scope, t.scopeId, t.key] }),
    scopeIdx: index("memory_kv_scope_idx").on(t.agentId, t.scope, t.scopeId),
  }),
);

// ───────────────── knowledge store (per-workspace RAG) ─────────────────
// A chunk of text + its embedding vector (JSON number[]). Cross-run, workspace
// scoped, queryable by similarity so agents can recall prior work beyond what's
// in their context window or KV memory. Unique on (workspace, source, sourceId)
// so re-ingesting a source updates in place.
export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
    source: varchar("source", { length: 20 }).notNull(), // artifact | message | task | note
    sourceId: varchar("source_id", { length: 64 }).notNull().default(""),
    title: varchar("title", { length: 300 }).notNull().default(""),
    text: text("text").notNull(),
    embedding: jsonb("embedding").$type<number[]>().notNull(),
    dim: integer("dim").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    wsIdx: index("knowledge_ws_idx").on(t.workspaceId),
    srcUniq: uniqueIndex("knowledge_src_uniq").on(t.workspaceId, t.source, t.sourceId),
  }),
);

// ───────────────── presence (in-memory shadow; table kept for audit of last_seen) ─────────────────
export const presence = pgTable("presence", {
  memberId: varchar("member_id", { length: 32 }).primaryKey(),
  status: varchar("status", { length: 20 }).notNull().default("offline"), // online | idle | working | offline
  lastSeen: timestamp("last_seen", { withTimezone: true }).defaultNow().notNull(),
});

// ───────────────── notifications (per-member inbox) ─────────────────
// One row per thing a member should be told about: a mention, a DM, a task
// assignment, an approval decision. Written by the same code paths that fire
// agent triggers / publish events, read by the notification-center routes.
// `kind` drives the icon/copy in the UI; `link` is a client route to deep-link
// to (e.g. /c/<conv> or /board?task=<id>). readAt null = unread.
export const notifications = pgTable(
  "notifications",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
    // Recipient member (the user who should see this), always a user member.
    memberId: varchar("member_id", { length: 32 }).notNull(),
    kind: varchar("kind", { length: 30 }).notNull(), // mention | dm | task_assigned | task_comment | approval | system
    // Who/what caused it — a member id when there's an actor, else null.
    actorMemberId: varchar("actor_member_id", { length: 32 }),
    title: varchar("title", { length: 200 }).notNull().default(""),
    body: text("body").notNull().default(""),
    // Client-side deep link, e.g. "/c/<conversationId>" or "/board?task=<id>".
    link: text("link").notNull().default(""),
    // Loose references for grouping/dedup — populated per-kind, all optional.
    conversationId: varchar("conversation_id", { length: 32 }),
    messageId: varchar("message_id", { length: 32 }),
    taskId: varchar("task_id", { length: 32 }),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    memberCreatedIdx: index("notifications_member_created_idx").on(t.memberId, t.createdAt),
    memberUnreadIdx: index("notifications_member_unread_idx").on(t.memberId, t.readAt),
  }),
);

// ───────────────── goals (the delegation spine) ─────────────────
// A goal is a unit of intent that the planner decomposes into a dependency
// graph of tasks. Goals can nest (a sub-goal points at its parent) so a
// company mission → project goal → goal tree mirrors Paperclip's "all work
// traces to the company goal". Tasks point back at a goal via tasks.goalId.
//   status: open       — created, not yet planned
//           planning   — decomposition in flight
//           in_progress— plan materialised, tasks running
//           done        — every task under it completed
//           archived
export const goals = pgTable(
  "goals",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
    parentGoalId: varchar("parent_goal_id", { length: 32 }),
    // 'project' = a top-level container; 'goal' = a unit of intent the planner
    // decomposes. Makes the mission → project → goal tier real instead of
    // inferred from tree depth.
    kind: varchar("kind", { length: 16 }).notNull().default("goal"),
    title: varchar("title", { length: 300 }).notNull(),
    bodyMd: text("body_md").notNull().default(""),
    status: varchar("status", { length: 20 }).notNull().default("open"),
    // The member accountable for the goal — usually a manager agent or the human
    // who set it. Gets the roll-up notification when the goal completes.
    ownerMemberId: varchar("owner_member_id", { length: 32 }),
    // Auto-planning bookkeeping: how many times the planner has tried this goal
    // and the last failure code, so the sweeper can retry-with-backoff and give
    // up after a cap instead of looping (a cost bomb).
    planAttempts: integer("plan_attempts").notNull().default(0),
    lastPlanError: text("last_plan_error"),
    createdBy: varchar("created_by", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    wsIdx: index("goals_ws_idx").on(t.workspaceId, t.status),
    parentIdx: index("goals_parent_idx").on(t.parentGoalId),
  }),
);

// ───────────────── tasks (workspace-scoped kanban board) ─────────────────
export const tasks = pgTable(
  "tasks",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
    // Optional pointer back to the channel the task was spawned from — used
    // for "came from #eng" context on the card. Not a scope.
    conversationId: varchar("conversation_id", { length: 32 }),
    parentId: varchar("parent_id", { length: 32 }),
    // Goal this task traces back to (null for ad-hoc board tasks). Set by the
    // planner when it decomposes a goal so completion can roll back up to it.
    goalId: varchar("goal_id", { length: 32 }),
    title: varchar("title", { length: 200 }).notNull(),
    bodyMd: text("body_md").notNull().default(""),
    status: varchar("status", { length: 20 }).notNull().default("backlog"), // backlog | in_progress | review | done
    position: real("position").notNull().default(0),
    dueAt: timestamp("due_at", { withTimezone: true }),
    progress: integer("progress").notNull().default(0),
    createdBy: varchar("created_by", { length: 32 }).notNull(),
    sourceMessageId: varchar("source_message_id", { length: 32 }),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    wsIdx: index("tasks_ws_idx").on(t.workspaceId, t.archived),
    convIdx: index("tasks_conv_idx").on(t.conversationId, t.archived),
    parentIdx: index("tasks_parent_idx").on(t.parentId),
    goalIdx: index("tasks_goal_idx").on(t.goalId),
    statusPosIdx: index("tasks_status_pos_idx").on(t.workspaceId, t.status, t.position),
  }),
);

export const taskAssignees = pgTable(
  "task_assignees",
  {
    taskId: varchar("task_id", { length: 32 }).notNull(),
    memberId: varchar("member_id", { length: 32 }).notNull(),
    assignedBy: varchar("assigned_by", { length: 32 }).notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.taskId, t.memberId] }),
    memberIdx: index("task_assignees_member_idx").on(t.memberId),
  }),
);

export const taskLabels = pgTable(
  "task_labels",
  {
    taskId: varchar("task_id", { length: 32 }).notNull(),
    label: varchar("label", { length: 40 }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.taskId, t.label] }),
  }),
);

export const taskLinks = pgTable(
  "task_links",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    taskId: varchar("task_id", { length: 32 }).notNull(),
    linkedTaskId: varchar("linked_task_id", { length: 32 }).notNull(),
    kind: varchar("kind", { length: 20 }).notNull().default("relates"), // relates | blocks | duplicate
    // Workflow branch condition. NULL = unconditional `blocks` (hard dependency,
    // AND-join). Set = the source must complete carrying a label equal to this
    // value for the edge to fire (OR-activation / decision branch).
    condition: varchar("condition", { length: 60 }),
    createdBy: varchar("created_by", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("task_links_unique").on(t.taskId, t.linkedTaskId, t.kind),
    linkedIdx: index("task_links_linked_idx").on(t.linkedTaskId),
  }),
);

export const taskComments = pgTable(
  "task_comments",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    taskId: varchar("task_id", { length: 32 }).notNull(),
    memberId: varchar("member_id", { length: 32 }).notNull(),
    bodyMd: text("body_md").notNull(),
    mentions: jsonb("mentions").$type<string[]>().notNull().default([]),
    attachmentsJson: jsonb("attachments_json").$type<Array<Record<string, unknown>>>().notNull().default([]),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    taskTsIdx: index("task_comments_task_ts_idx").on(t.taskId, t.ts),
  }),
);

// ───────────────── task_artifacts (versioned, attributed deliverables) ─────────────────
// A task's durable deliverables namespace. Each row is one version of one
// named artifact, content-hashed + sized + attributed to the member who
// submitted it. The object store holds the bytes (storage_key); this table is
// the source of truth for "what was delivered for this task". The current
// artifact named N on task T is the max(version) row with deleted_at IS NULL.
export const taskArtifacts = pgTable(
  "task_artifacts",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    taskId: varchar("task_id", { length: 32 }).notNull(),
    workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    version: integer("version").notNull().default(1),
    storageKey: varchar("storage_key", { length: 300 }).notNull(),
    contentType: varchar("content_type", { length: 160 }).notNull().default("application/octet-stream"),
    size: integer("size").notNull().default(0),
    sha256: varchar("sha256", { length: 64 }),
    createdBy: varchar("created_by", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    taskIdx: index("task_artifacts_task_idx").on(t.taskId, t.deletedAt),
    taskNameVer: uniqueIndex("task_artifacts_task_name_ver").on(t.taskId, t.name, t.version),
  }),
);

export type TaskArtifact = typeof taskArtifacts.$inferSelect;

export const taskActivity = pgTable(
  "task_activity",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    taskId: varchar("task_id", { length: 32 }).notNull(),
    actorMemberId: varchar("actor_member_id", { length: 32 }).notNull(),
    kind: varchar("kind", { length: 30 }).notNull(), // created | status_changed | assigned | unassigned | moved | comment | renamed | due_changed | progress_changed | labels_changed | link_added | link_removed | archived
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    taskTsIdx: index("task_activity_task_ts_idx").on(t.taskId, t.ts),
  }),
);

// ───────────────── verification gate (LLM-as-judge before "done") ─────────
// One row per judge run on a task. The done-gate's byte-heuristic only proves a
// deliverable EXISTS; this proves it's RELEVANT and not fabricated — gating the
// review→done flip on an externally-checkable verdict instead of a reviewer's
// rubber-stamp. Auditable: every verdict + rationale is kept.
export const taskVerifications = pgTable(
  "task_verifications",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    taskId: varchar("task_id", { length: 32 }).notNull(),
    workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
    taskType: varchar("task_type", { length: 16 }).notNull().default("general"), // code | research | design | general
    method: varchar("method", { length: 16 }).notNull(), // rubric | test | heuristic
    verdict: varchar("verdict", { length: 12 }).notNull(), // pass | fail | error
    score: real("score"), // 0..1 (rubric path); null when method != rubric
    rubricJson: jsonb("rubric_json").$type<Record<string, unknown>>().notNull().default({}),
    rationale: text("rationale").notNull().default(""),
    artifactId: varchar("artifact_id", { length: 32 }), // the deliverable judged
    decidedBy: varchar("decided_by", { length: 32 }), // reviewer member who triggered the flip
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    taskIdx: index("task_verifications_task_idx").on(t.taskId, t.createdAt),
  }),
);

export type TaskVerification = typeof taskVerifications.$inferSelect;

// ───────────────── goal ledger (Magentic-One task + progress ledger) ──────
// One row per goal (1:1). Externalizes the plan, established facts, dead-ends,
// and progress into structured state the context packet injects every wake —
// so agents read the ledger instead of re-deriving intent from noisy chat
// history (the driver of echo loops, no-op runs, and credential dead-ends). The
// stall machinery drives automatic re-planning when forward motion stops.
export const goalLedgers = pgTable(
  "goal_ledgers",
  {
    goalId: varchar("goal_id", { length: 32 }).primaryKey(), // 1:1 with goals
    workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
    // TASK LEDGER: the plan + what's known.
    facts: jsonb("facts").$type<string[]>().notNull().default([]), // verified facts learned
    guesses: jsonb("guesses").$type<string[]>().notNull().default([]), // unverified assumptions
    plan: text("plan").notNull().default(""), // current human-readable plan (planner-written, re-plannable)
    // PROGRESS LEDGER: progress notes + dead-ends not to repeat.
    progressNotes: jsonb("progress_notes")
      .$type<Array<{ by: string; note: string; ts: string }>>()
      .notNull()
      .default([]),
    triedDeadEnds: jsonb("tried_dead_ends").$type<string[]>().notNull().default([]),
    // PROGRESS LEDGER (Magentic-style, typed per-round): the latest assessment of
    // whether the team is actually advancing or looping. Distinct from the
    // free-form progress NOTES above — these are typed signals the stall
    // machinery and the agent context both read, so loop-breaking no longer
    // depends only on a wall-clock gap. `signal` is the internal snapshot
    // signature used to diff progress between sweeps. Null until first assessed.
    progressLedger: jsonb("progress_ledger").$type<ProgressLedger>(),
    // Stall machinery.
    stallCount: integer("stall_count").notNull().default(0),
    loopCount: integer("loop_count").notNull().default(0), // consecutive sweeps assessed in-loop
    lastProgressAt: timestamp("last_progress_at", { withTimezone: true }).defaultNow().notNull(),
    replanCount: integer("replan_count").notNull().default(0),
    version: integer("version").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    wsIdx: index("goal_ledgers_ws_idx").on(t.workspaceId),
  }),
);

// One typed per-round Progress Ledger assessment (Magentic's five-field shape,
// adapted): is the goal done, is real progress happening, is the team looping,
// and what to do next. Stored on the ledger row + surfaced to agents.
export type ProgressLedger = {
  isRequestSatisfied: boolean;
  isProgressBeingMade: boolean;
  isInLoop: boolean;
  nextStep: string;
  signal: string; // internal: snapshot signature for cross-sweep progress diffing
  assessedAt: string; // ISO
};

export type GoalLedger = typeof goalLedgers.$inferSelect;

// ───────────────── connector / MCP registry ──────────────────────────────
// Connectors are workspace-owned and intentionally split into public config
// plus encrypted credentials.  `kind=mcp` speaks MCP's JSON-RPC HTTP shape;
// `kind=http` is a governed generic REST connector.  Grants keep a connector
// installed in the workspace from automatically becoming available to every
// agent.
export const connectors = pgTable(
  "connectors",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description").notNull().default(""),
    kind: varchar("kind", { length: 16 }).notNull(), // http | mcp
    baseUrl: text("base_url").notNull(),
    authType: varchar("auth_type", { length: 20 }).notNull().default("none"), // none | bearer | header | oauth2
    configJson: jsonb("config_json").$type<Record<string, unknown>>().notNull().default({}),
    secretCiphertext: text("secret_ciphertext"),
    status: varchar("status", { length: 20 }).notNull().default("unchecked"), // unchecked | healthy | error | disabled
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdBy: varchar("created_by", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    wsIdx: index("connectors_ws_idx").on(t.workspaceId, t.status),
    wsName: uniqueIndex("connectors_ws_name_key").on(t.workspaceId, t.name),
  }),
);

export const agentConnectorGrants = pgTable(
  "agent_connector_grants",
  {
    connectorId: varchar("connector_id", { length: 32 }).notNull(),
    agentId: varchar("agent_id", { length: 32 }).notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    createdBy: varchar("created_by", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.connectorId, t.agentId] }),
    agentIdx: index("agent_connector_grants_agent_idx").on(t.agentId),
  }),
);

// ───────────────── durable workflows ─────────────────────────────────────
export type WorkflowStateDefinition = {
  id: string;
  type: "agent" | "connector" | "wait" | "approval" | "poll" | "terminal";
  name?: string;
  next?: string;
  onSuccess?: string;
  onFailure?: string;
  config?: Record<string, unknown>;
};

export type WorkflowDefinition = {
  start: string;
  states: WorkflowStateDefinition[];
};

export const workflows = pgTable(
  "workflows",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
    name: varchar("name", { length: 140 }).notNull(),
    description: text("description").notNull().default(""),
    status: varchar("status", { length: 20 }).notNull().default("active"), // active | paused
    triggerType: varchar("trigger_type", { length: 20 }).notNull().default("manual"), // manual | webhook
    definitionJson: jsonb("definition_json").$type<WorkflowDefinition>().notNull(),
    version: integer("version").notNull().default(1),
    createdBy: varchar("created_by", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    wsIdx: index("workflows_ws_idx").on(t.workspaceId, t.status),
    wsName: uniqueIndex("workflows_ws_name_key").on(t.workspaceId, t.name),
  }),
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    workflowId: varchar("workflow_id", { length: 32 }).notNull(),
    workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("queued"), // queued | running | waiting | completed | failed | cancelled
    currentStateId: varchar("current_state_id", { length: 80 }),
    inputJson: jsonb("input_json").$type<Record<string, unknown>>().notNull().default({}),
    outputJson: jsonb("output_json").$type<Record<string, unknown>>().notNull().default({}),
    waitKind: varchar("wait_kind", { length: 20 }), // agent | human | timer | poll
    waitKey: varchar("wait_key", { length: 100 }),
    waitUntil: timestamp("wait_until", { withTimezone: true }),
    errorText: text("error_text"),
    createdBy: varchar("created_by", { length: 32 }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    cancelledBy: varchar("cancelled_by", { length: 32 }),
    steerJson: jsonb("steer_json").$type<Array<Record<string, unknown>>>().notNull().default([]),
    followupJson: jsonb("followup_json").$type<Array<Record<string, unknown>>>().notNull().default([]),
    timeoutAt: timestamp("timeout_at", { withTimezone: true }),
    ownerMemberId: varchar("owner_member_id", { length: 32 }),
  },
  (t) => ({
    workflowIdx: index("workflow_runs_workflow_idx").on(t.workflowId, t.startedAt),
    wsStatusIdx: index("workflow_runs_ws_status_idx").on(t.workspaceId, t.status),
  }),
);

export const workflowSteps = pgTable(
  "workflow_steps",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    runId: varchar("run_id", { length: 32 }).notNull(),
    stateId: varchar("state_id", { length: 80 }).notNull(),
    kind: varchar("kind", { length: 20 }).notNull(),
    attempt: integer("attempt").notNull().default(1),
    status: varchar("status", { length: 20 }).notNull().default("running"), // running | waiting | completed | failed
    inputJson: jsonb("input_json").$type<Record<string, unknown>>().notNull().default({}),
    outputJson: jsonb("output_json").$type<Record<string, unknown>>().notNull().default({}),
    agentRunId: varchar("agent_run_id", { length: 32 }),
    errorText: text("error_text"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({
    runIdx: index("workflow_steps_run_idx").on(t.runId, t.startedAt),
    runStateAttempt: uniqueIndex("workflow_steps_run_state_attempt_key").on(t.runId, t.stateId, t.attempt),
  }),
);

// Every webhook endpoint gets a distinct signing secret.  It is encrypted at
// rest and returned only once at creation/rotation.  Delivery ids provide
// replay protection and safe client retries.
export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
    workflowId: varchar("workflow_id", { length: 32 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    secretCiphertext: text("secret_ciphertext").notNull(),
    active: boolean("active").notNull().default(true),
    createdBy: varchar("created_by", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workflowIdx: index("webhook_endpoints_workflow_idx").on(t.workflowId),
  }),
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    endpointId: varchar("endpoint_id", { length: 32 }).notNull(),
    deliveryId: varchar("delivery_id", { length: 120 }).notNull(),
    signatureValid: boolean("signature_valid").notNull().default(false),
    status: varchar("status", { length: 20 }).notNull().default("received"), // received | accepted | rejected | duplicate
    payloadJson: jsonb("payload_json").$type<Record<string, unknown>>().notNull().default({}),
    workflowRunId: varchar("workflow_run_id", { length: 32 }),
    errorText: text("error_text"),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    endpointDelivery: uniqueIndex("webhook_events_endpoint_delivery_key").on(t.endpointId, t.deliveryId),
    endpointIdx: index("webhook_events_endpoint_idx").on(t.endpointId, t.receivedAt),
  }),
);

// ───────────────── model routing + actual usage ──────────────────────────
export const modelRoutes = pgTable(
  "model_routes",
  {
    workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
    tier: varchar("tier", { length: 20 }).notNull(), // economy | balanced | frontier | advisor
    provider: varchar("provider", { length: 60 }).notNull(),
    model: varchar("model", { length: 120 }).notNull(),
    inputCostPerMtok: real("input_cost_per_mtok").notNull().default(0),
    outputCostPerMtok: real("output_cost_per_mtok").notNull().default(0),
    cachedInputCostPerMtok: real("cached_input_cost_per_mtok").notNull().default(0),
    contextWindow: integer("context_window"),
    enabled: boolean("enabled").notNull().default(true),
    updatedBy: varchar("updated_by", { length: 32 }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.tier] }),
  }),
);

export const modelUsageEvents = pgTable(
  "model_usage_events",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
    agentId: varchar("agent_id", { length: 32 }).notNull(),
    runId: varchar("run_id", { length: 32 }).notNull(),
    // Stable idempotency key for one logical model call. The agent worker uses
    // `worker` so BullMQ retries update one event; runtime-side multi-call
    // reports get a fresh key and remain individually auditable.
    eventKey: varchar("event_key", { length: 80 }).notNull(),
    provider: varchar("provider", { length: 60 }).notNull().default("unknown"),
    model: varchar("model", { length: 120 }).notNull().default("unknown"),
    routeTier: varchar("route_tier", { length: 20 }),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    source: varchar("source", { length: 20 }).notNull().default("reported"), // reported | estimated
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    runIdx: index("model_usage_events_run_idx").on(t.runId),
    runEventKey: uniqueIndex("model_usage_events_run_event_key").on(t.runId, t.eventKey),
    wsTimeIdx: index("model_usage_events_ws_time_idx").on(t.workspaceId, t.occurredAt),
    agentTimeIdx: index("model_usage_events_agent_time_idx").on(t.agentId, t.occurredAt),
  }),
);

// ───────────────── P1 product platform ──────────────────────────────────
export const decisionMemories = pgTable(
  "decision_memories",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
    kind: varchar("kind", { length: 20 }).notNull(),
    title: varchar("title", { length: 180 }).notNull(),
    decision: text("decision").notNull(),
    rationale: text("rationale").notNull().default(""),
    alternativesJson: jsonb("alternatives_json").$type<string[]>().notNull().default([]),
    provenanceJson: jsonb("provenance_json").$type<Record<string, unknown>>().notNull().default({}),
    source: varchar("source", { length: 20 }).notNull().default("observer"),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    supersedesId: varchar("supersedes_id", { length: 32 }),
    createdBy: varchar("created_by", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    correctedAt: timestamp("corrected_at", { withTimezone: true }),
  },
  (t) => ({ wsIdx: index("decision_memories_ws_idx").on(t.workspaceId, t.status, t.createdAt) }),
);

export const hostedApps = pgTable(
  "hosted_apps",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
    taskId: varchar("task_id", { length: 32 }).notNull(),
    name: varchar("name", { length: 140 }).notNull(),
    slug: varchar("slug", { length: 80 }).notNull(),
    previewToken: varchar("preview_token", { length: 80 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("preview"),
    activeDeploymentId: varchar("active_deployment_id", { length: 32 }),
    createdBy: varchar("created_by", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    slugKey: uniqueIndex("hosted_apps_slug_key").on(t.slug),
    previewKey: uniqueIndex("hosted_apps_preview_key").on(t.previewToken),
    wsIdx: index("hosted_apps_ws_idx").on(t.workspaceId, t.status),
  }),
);

export const appDeployments = pgTable(
  "app_deployments",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    appId: varchar("app_id", { length: 32 }).notNull(),
    artifactId: varchar("artifact_id", { length: 32 }).notNull(),
    artifactSha256: varchar("artifact_sha256", { length: 64 }),
    status: varchar("status", { length: 20 }).notNull().default("preview"),
    healthStatus: varchar("health_status", { length: 20 }).notNull().default("healthy"),
    requestedBy: varchar("requested_by", { length: 32 }).notNull(),
    reviewedBy: varchar("reviewed_by", { length: 32 }),
    reviewNote: text("review_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => ({ appIdx: index("app_deployments_app_idx").on(t.appId, t.createdAt) }),
);

export const appLogs = pgTable(
  "app_logs",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    appId: varchar("app_id", { length: 32 }).notNull(),
    deploymentId: varchar("deployment_id", { length: 32 }),
    level: varchar("level", { length: 12 }).notNull().default("info"),
    event: varchar("event", { length: 80 }).notNull(),
    message: text("message").notNull().default(""),
    metaJson: jsonb("meta_json").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ appIdx: index("app_logs_app_idx").on(t.appId, t.createdAt) }),
);

export const prRooms = pgTable(
  "pr_rooms",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
    conversationId: varchar("conversation_id", { length: 32 }).notNull(),
    connectorId: varchar("connector_id", { length: 32 }),
    provider: varchar("provider", { length: 20 }).notNull(),
    repository: varchar("repository", { length: 240 }).notNull(),
    prNumber: integer("pr_number").notNull(),
    title: varchar("title", { length: 240 }).notNull().default(""),
    url: text("url").notNull().default(""),
    state: varchar("state", { length: 20 }).notNull().default("open"),
    headRef: varchar("head_ref", { length: 160 }).notNull().default(""),
    baseRef: varchar("base_ref", { length: 160 }).notNull().default(""),
    diffJson: jsonb("diff_json").$type<Array<Record<string, unknown>>>().notNull().default([]),
    checksJson: jsonb("checks_json").$type<Array<Record<string, unknown>>>().notNull().default([]),
    reviewsJson: jsonb("reviews_json").$type<Array<Record<string, unknown>>>().notNull().default([]),
    protectionJson: jsonb("protection_json").$type<Record<string, unknown>>().notNull().default({}),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdBy: varchar("created_by", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("pr_rooms_unique").on(t.workspaceId, t.provider, t.repository, t.prNumber),
    convIdx: index("pr_rooms_conv_idx").on(t.conversationId),
  }),
);

export const boardStages = pgTable(
  "board_stages",
  {
    workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
    stage: varchar("stage", { length: 20 }).notNull(),
    title: varchar("title", { length: 80 }).notNull(),
    position: integer("position").notNull().default(0),
    instructions: text("instructions").notNull().default(""),
    entryRulesJson: jsonb("entry_rules_json").$type<Record<string, unknown>>().notNull().default({}),
    exitRulesJson: jsonb("exit_rules_json").$type<Record<string, unknown>>().notNull().default({}),
    agentId: varchar("agent_id", { length: 32 }),
    skill: varchar("skill", { length: 120 }),
    verification: varchar("verification", { length: 20 }).notNull().default("none"),
    escalationMemberId: varchar("escalation_member_id", { length: 32 }),
    nextStage: varchar("next_stage", { length: 20 }),
    updatedBy: varchar("updated_by", { length: 32 }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.workspaceId, t.stage] }) }),
);

export type TeamBlueprintDefinition = {
  agents: Array<Record<string, unknown>>;
  relationships: Array<Record<string, unknown>>;
  skills: Array<Record<string, unknown>>;
  channels: Array<Record<string, unknown>>;
  workflows: Array<Record<string, unknown>>;
};

export const teamBlueprints = pgTable(
  "team_blueprints",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
    name: varchar("name", { length: 140 }).notNull(),
    description: text("description").notNull().default(""),
    version: integer("version").notNull().default(1),
    definitionJson: jsonb("definition_json").$type<TeamBlueprintDefinition>().notNull(),
    createdBy: varchar("created_by", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ uniq: uniqueIndex("team_blueprints_ws_name_ver_key").on(t.workspaceId, t.name, t.version) }),
);

export const workspaceRoles = pgTable(
  "workspace_roles",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
    key: varchar("key", { length: 40 }).notNull(),
    name: varchar("name", { length: 80 }).notNull(),
    permissionsJson: jsonb("permissions_json").$type<string[]>().notNull().default([]),
    isSystem: boolean("is_system").notNull().default(false),
    createdBy: varchar("created_by", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ uniq: uniqueIndex("workspace_roles_ws_key").on(t.workspaceId, t.key) }),
);

export const serviceAccounts = pgTable(
  "service_accounts",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    scopesJson: jsonb("scopes_json").$type<string[]>().notNull().default([]),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: varchar("created_by", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tokenKey: uniqueIndex("service_accounts_token_key").on(t.tokenHash),
    wsIdx: index("service_accounts_ws_idx").on(t.workspaceId, t.revokedAt),
  }),
);

export const ssoConnections = pgTable(
  "sso_connections",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
    issuer: text("issuer").notNull(),
    clientId: varchar("client_id", { length: 240 }).notNull(),
    clientSecretCiphertext: text("client_secret_ciphertext").notNull(),
    domainsJson: jsonb("domains_json").$type<string[]>().notNull().default([]),
    defaultRole: varchar("default_role", { length: 40 }).notNull().default("member"),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: varchar("created_by", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ wsKey: uniqueIndex("sso_connections_ws_key").on(t.workspaceId) }),
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
    actorType: varchar("actor_type", { length: 20 }).notNull(),
    actorId: varchar("actor_id", { length: 32 }).notNull(),
    action: varchar("action", { length: 100 }).notNull(),
    targetType: varchar("target_type", { length: 40 }).notNull(),
    targetId: varchar("target_id", { length: 64 }),
    metaJson: jsonb("meta_json").$type<Record<string, unknown>>().notNull().default({}),
    ipHash: varchar("ip_hash", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ wsTimeIdx: index("audit_events_ws_time_idx").on(t.workspaceId, t.createdAt) }),
);
