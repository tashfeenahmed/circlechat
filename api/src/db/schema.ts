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
    errorText: text("error_text"),
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
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  },
  (t) => ({
    tokenIdx: uniqueIndex("invites_token_key").on(t.token),
    wsIdx: index("invites_ws_idx").on(t.workspaceId),
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
