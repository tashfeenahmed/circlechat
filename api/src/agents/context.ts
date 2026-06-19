import { and, eq, gt, inArray, desc, asc, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  agents,
  members,
  conversations,
  conversationMembers,
  messages,
  approvals,
  memoryKv,
  reactions,
  users,
  tasks,
  taskAssignees,
  taskLabels,
  taskComments,
  workspaces,
} from "../db/schema.js";
import { loadReportingFor, type ReportingBundle } from "../routes/org.js";
import { listGoals, getGoalAncestry } from "../lib/goals-core.js";
import { loadLedgers } from "../lib/ledger-core.js";
import { ensureAndLoadBlocks } from "../lib/memory-blocks.js";
import { loadTaskSummary, maybeSummarizeTaskThread } from "../lib/task-condenser.js";
import { latestVerdictSummary } from "../lib/task-verifier.js";
import { buildProjectContext } from "../lib/project-files.js";

export interface MemberInfo {
  memberId: string;
  kind: "user" | "agent";
  name: string;
  handle: string;
  isMe?: boolean;
}

export interface InboxReaction {
  emoji: string;
  memberId: string;
  memberHandle: string;
}

export interface InboxAttachment {
  key: string;
  name: string;
  contentType: string;
  size: number;
  url: string;
}

export interface InboxMessage {
  id: string;
  memberId: string;
  memberHandle: string;
  memberName: string;
  bodyMd: string;
  parentId: string | null;
  ts: string;
  mentions: string[];
  reactions: InboxReaction[];
  attachments: InboxAttachment[];
}

export interface ContextPacket {
  agent: {
    id: string;
    memberId: string;
    handle: string;
    name: string;
    model: string;
    scopes: string[];
    brief: string;
  };
  // Workspace-level context shared by every agent in this workspace.
  // The mission is injected into the runtime prompt so all agents agree on
  // "what we build" without needing it repeated in each agent's brief.
  workspace: {
    id: string;
    name: string;
    handle: string;
    mission: string;
    // Canonical project brief, read fresh from <workspace mount>/BRIEF.md every
    // run. This is the single source of truth a human pins for the team (brand,
    // acceptance criteria, the deploy/preview story, "never ask for creds").
    // Weak models won't `cat` it on their own, so we inject it — the steering
    // that was silently invisible before. Empty string when no BRIEF.md exists.
    brief: string;
    // Live manifest of the shared /workspace dir (names + sizes), so agents see
    // what already exists on disk instead of asking teammates in chat or
    // re-deriving files that are right there. Capped; null when unreadable.
    files: Array<{ path: string; size: number }> | null;
    // Trigger-gated knowledge: markdown files under <mount>/knowledge/ whose
    // `triggers:` keywords matched this run's text (always-on files have no
    // triggers). Keeps situational guidance OUT of every prompt — it appears
    // only when relevant — unlike the always-injected brief. Empty when none match.
    knowledge: Array<{ name: string; content: string }>;
    // Shared, multi-file PROJECT memory under <mount>/projects/<slug>/*.md —
    // the file-based "blackboard" agents form and manage themselves (see
    // lib/project-files.ts). `projectIndex` is a per-turn DERIVED map of every
    // tracked project + its files (always injected, never drifts). `projectFiles`
    // are the file BODIES whose triggers/slug matched this run, fetched on demand
    // within a token budget so the layer scales without bloating every prompt.
    projectIndex: string;
    projectFiles: Array<{ project: string; name: string; content: string }>;
  };
  trigger: string;
  triggerConversationId?: string | null;
  triggerMessageId?: string;
  // Set when the agent's PREVIOUS run ended in failure (crash, gateway error,
  // reaped after a worker death). Continuity: without this the agent has
  // amnesia about its own dead run and silently drops whatever it was doing.
  previousRunFailure?: { errorText: string; finishedAt: string | null } | null;
  // One-shot directive set when the agent was detected in a run-level loop
  // (see lib/stuck-detector.ts), telling it to break the pattern this turn.
  stuckBreak?: string | null;
  // One-shot output from a run_code action the agent issued last turn (the
  // sandbox runs after the LLM turn, so its result is fed back here next turn).
  lastCodeResult?: string | null;
  members: Record<string, MemberInfo>; // member directory keyed by memberId
  thread: null | {
    conversationId: string;
    conversationKind: string;
    conversationName: string | null;
    rootMessageId: string;
    messages: InboxMessage[];
  };
  inbox: Array<{
    conversationId: string;
    conversationKind: string;
    conversationName: string | null;
    conversationTopic: string;
    conversationMembers: string[]; // memberIds
    messages: InboxMessage[];
  }>;
  openApprovals: Array<{
    id: string;
    scope: string;
    action: string;
    status: string;
    createdAt: string;
    // Workspace-wide visibility: whose request this is, and whether it's the
    // packet-owner's own (mine=false ⇒ a teammate already asked — don't dupe).
    agentHandle: string;
    mine: boolean;
  }>;
  // Present only on approval_response wakes: the approval that was just
  // decided, including the human's optional note, so the agent knows exactly
  // what was approved/denied and any guidance attached to the decision.
  approvalResponse?: {
    id: string;
    scope: string;
    action: string;
    status: string; // approved | denied
    note: string | null;
    decidedByHandle: string | null;
    payload: Record<string, unknown>;
    // Env-var names the human attached to an approve — the values are already
    // installed in the agent's runtime environment (never shown in chat/DB).
    deliveredSecrets: string[] | null;
  };
  // Scoped agent memory. `global` is workspace-wide and always present.
  // `byConversation` is keyed by conversationId — only includes scopes for
  // conversations that appear in this packet's inbox or trigger conversation.
  // `byTask` is keyed by taskId — only includes scopes for tasks in `myTasks`
  // or the active task. Old code reading the flat shape can fall back to
  // `global`.
  memory: {
    global: Record<string, unknown>;
    byConversation: Record<string, Record<string, unknown>>;
    byTask: Record<string, Record<string, unknown>>;
  };
  // Letta-style in-context memory blocks (always shown, self-edited). `team` is
  // shared across the workspace; `notes` is private. See lib/memory-blocks.ts.
  memoryBlocks: Array<{
    label: string;
    description: string;
    value: string;
    charLimit: number;
    shared: boolean;
  }>;
  reporting: ReportingBundle;
  // Active goals in the workspace (not done/archived) with their task tally, so
  // an agent — especially a manager — can see what the team is driving toward,
  // pick up an unplanned goal and decompose it, or set a new one. Bounded.
  goals: Array<{
    id: string;
    title: string;
    status: string;
    kind: string; // 'project' | 'goal'
    parentGoalId: string | null;
    ownerMemberId: string | null;
    taskCounts: { total: number; done: number; inProgress: number };
    // Magentic-One-style externalized ledger: the plan, established facts,
    // dead-ends not to repeat, and recent progress. Null until the goal is
    // planned. Agents read this instead of reconstructing intent from chat.
    ledger: {
      plan: string;
      facts: string[];
      triedDeadEnds: string[];
      recentProgress: string[];
      stallCount: number;
      progress: { isInLoop: boolean; nextStep: string } | null;
    } | null;
  }>;
  // Open tasks assigned to this agent, freshest first. Present on every
  // trigger so heartbeats have a "what am I working on?" list — the agent
  // can pick one up, move status, drop a progress comment, attach artifacts.
  myTasks: Array<{
    id: string;
    title: string;
    status: string;
    progress: number;
    dueAt: string | null;
    conversationId: string | null;
    conversationName: string | null;
    labels: string[];
    commentCount: number;
    latestComment: {
      memberId: string;
      memberHandle: string;
      bodyMd: string;
      ts: string;
    } | null;
  }>;
  task?: {
    id: string;
    conversationId: string | null;
    conversationName: string | null;
    title: string;
    bodyMd: string;
    status: string;
    progress: number;
    dueAt: string | null;
    labels: string[];
    assignees: string[];
    assigneeHandles: string[];
    parentId: string | null;
    createdBy: string;
    subtasks: Array<{ id: string; title: string; status: string; assignees: string[] }>;
    recentComments: Array<{ id: string; memberId: string; memberHandle: string; bodyMd: string; ts: string }>;
    // Rolling summary of the OLDER comments (beyond the recent window) on a long
    // thread, so the agent sees what was decided/tried without every comment.
    // Null when the thread is short or the condenser is off. See task-condenser.
    historySummary?: string | null;
    // The goal chain this task serves, top-first (root project → … → direct
    // goal), so the agent sees the "why", not just a title. Empty when the
    // task isn't attached to a goal.
    goalAncestry: Array<{ id: string; title: string; kind: string; status: string }>;
    // Latest automated quality verdict on the deliverable (pre-computed on
    // review entry), so a reviewing manager acts on a signal instead of cold.
    // Null when the verifier never ran for this task.
    latestVerdict: { verdict: string; score: number | null; rationale: string } | null;
  };
}

export async function buildContext(opts: {
  agentId: string;
  trigger: string;
  sinceTs: Date;
  untilTs: Date;
  conversationId?: string | null;
  messageId?: string;
  taskId?: string;
  approvalId?: string;
  previousRunFailure?: { errorText: string; finishedAt: string | null } | null;
  stuckBreak?: string | null;
  lastCodeResult?: string | null;
}): Promise<ContextPacket> {
  const [a] = await db.select().from(agents).where(eq(agents.id, opts.agentId)).limit(1);
  if (!a) throw new Error("agent_not_found");

  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, a.workspaceId)).limit(1);
  if (!ws) throw new Error("workspace_not_found");

  const [agentMember] = await db
    .select()
    .from(members)
    .where(and(eq(members.kind, "agent"), eq(members.refId, opts.agentId)))
    .limit(1);
  const agentMemberId = agentMember?.id ?? "";

  // Conversations the agent belongs to. For event-triggered runs (mention,
  // dm, thread_reply, channel_post, task_*) we narrow the scope to the one
  // conversation that woke the agent so the context packet doesn't balloon
  // with every channel's history — that was blowing past OpenClaw's 16k
  // context window in channel mentions while DMs stayed small.
  // Heartbeat-style triggers (scheduled, ambient, and the immediate
  // continuation that follows a work action) get the BROAD proactive-work view
  // — open tasks, goals — not a single narrowed conversation.
  const narrowToTrigger =
    opts.trigger !== "scheduled" &&
    opts.trigger !== "ambient" &&
    opts.trigger !== "continuation" &&
    !!opts.conversationId;
  const myConvsAll = await db
    .select({ conversation: conversations })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(eq(conversationMembers.memberId, agentMemberId));
  const myConvs = narrowToTrigger
    ? myConvsAll.filter((c) => c.conversation.id === opts.conversationId)
    : myConvsAll;

  const convIds = myConvs.map((c) => c.conversation.id);

  // For channel context — include the LAST N messages (not just since last beat) when
  // we've been woken by mention/dm so the agent knows what's already been said.
  const includeHistory = opts.trigger !== "scheduled" && opts.trigger !== "continuation";
  const historyLimit = 20;
  const historyMsgs = convIds.length && includeHistory
    ? await db
        .select()
        .from(messages)
        .where(and(inArray(messages.conversationId, convIds), isNull(messages.deletedAt)))
        .orderBy(desc(messages.ts))
        .limit(historyLimit * convIds.length)
    : [];
  const newMsgs = convIds.length
    ? await db
        .select()
        .from(messages)
        .where(
          and(
            inArray(messages.conversationId, convIds),
            gt(messages.ts, opts.sinceTs),
            isNull(messages.deletedAt),
          ),
        )
        .orderBy(desc(messages.ts))
        .limit(200)
    : [];

  // Merge-deduped by id, most-recent-first.
  const byId = new Map<string, (typeof newMsgs)[number]>();
  for (const m of [...newMsgs, ...historyMsgs]) if (!byId.has(m.id)) byId.set(m.id, m);
  const all = Array.from(byId.values()).sort((a, b) => +b.ts - +a.ts);

  const byConv = new Map<string, typeof newMsgs>();
  for (const m of all) {
    const list = byConv.get(m.conversationId) ?? [];
    if (list.length < historyLimit) list.push(m);
    byConv.set(m.conversationId, list);
  }

  // Resolve every memberId referenced into a directory.
  const relatedConvMemberRows = convIds.length
    ? await db
        .select({ memberId: conversationMembers.memberId, conversationId: conversationMembers.conversationId })
        .from(conversationMembers)
        .where(inArray(conversationMembers.conversationId, convIds))
    : [];
  const memberIds = new Set<string>();
  for (const r of relatedConvMemberRows) memberIds.add(r.memberId);
  for (const m of all) memberIds.add(m.memberId);
  memberIds.add(agentMemberId);

  const memberDirectory: Record<string, MemberInfo> = {};
  if (memberIds.size) {
    const memberRows = await db
      .select()
      .from(members)
      .where(inArray(members.id, Array.from(memberIds)));
    const userRefs = memberRows.filter((m) => m.kind === "user").map((m) => m.refId);
    const agentRefs = memberRows.filter((m) => m.kind === "agent").map((m) => m.refId);
    const uRows = userRefs.length
      ? await db.select().from(users).where(inArray(users.id, userRefs))
      : [];
    const aRows = agentRefs.length
      ? await db.select().from(agents).where(inArray(agents.id, agentRefs))
      : [];
    const uMap = new Map(uRows.map((u) => [u.id, u]));
    const aMap = new Map(aRows.map((a) => [a.id, a]));
    for (const m of memberRows) {
      if (m.kind === "user") {
        const u = uMap.get(m.refId);
        if (u) memberDirectory[m.id] = { memberId: m.id, kind: "user", name: u.name, handle: u.handle };
      } else {
        const ag = aMap.get(m.refId);
        if (ag) memberDirectory[m.id] = {
          memberId: m.id,
          kind: "agent",
          name: ag.name,
          handle: ag.handle,
          isMe: m.id === agentMemberId,
        };
      }
    }
  }

  const convMembersByConv = new Map<string, string[]>();
  for (const r of relatedConvMemberRows) {
    const arr = convMembersByConv.get(r.conversationId) ?? [];
    arr.push(r.memberId);
    convMembersByConv.set(r.conversationId, arr);
  }

  // Pull reactions for every message id we might return (inbox + thread).
  const candidateMsgIds = new Set<string>();
  for (const m of all) candidateMsgIds.add(m.id);
  if (opts.messageId) candidateMsgIds.add(opts.messageId);
  const rxRows = candidateMsgIds.size
    ? await db.select().from(reactions).where(inArray(reactions.messageId, Array.from(candidateMsgIds)))
    : [];
  const rxByMsg = new Map<string, InboxReaction[]>();
  for (const r of rxRows) {
    const list = rxByMsg.get(r.messageId) ?? [];
    list.push({
      emoji: r.emoji,
      memberId: r.memberId,
      memberHandle: memberDirectory[r.memberId]?.handle ?? "unknown",
    });
    rxByMsg.set(r.messageId, list);
  }

  const inbox = myConvs
    .map(({ conversation }) => {
      const convMsgs = (byConv.get(conversation.id) ?? [])
        .reverse()
        .slice(-historyLimit)
        .map((m) => {
          const who = memberDirectory[m.memberId];
          return {
            id: m.id,
            memberId: m.memberId,
            memberHandle: who?.handle ?? "unknown",
            memberName: who?.name ?? "unknown",
            bodyMd: m.bodyMd,
            parentId: m.parentId,
            ts: m.ts.toISOString(),
            mentions: m.mentions,
            reactions: rxByMsg.get(m.id) ?? [],
            attachments: (m.attachmentsJson ?? []) as InboxAttachment[],
          };
        });
      return {
        conversationId: conversation.id,
        conversationKind: conversation.kind,
        conversationName: conversation.name,
        conversationTopic: conversation.topic,
        conversationMembers: convMembersByConv.get(conversation.id) ?? [],
        messages: convMsgs,
      };
    })
    .filter((c) => c.messages.length > 0)
    // Sort so the triggering conversation is first.
    .sort((a, b) => (a.conversationId === opts.conversationId ? -1 : b.conversationId === opts.conversationId ? 1 : 0));

  // Workspace-wide, not per-agent: teammates' pending approvals are visible so
  // an agent doesn't file its own copy of a request a colleague already has
  // sitting in the human's queue (three agents each begged for the same deploy
  // credential because none could see the others' cards).
  const openRows = await db
    .select({ approval: approvals, agentHandle: agents.handle })
    .from(approvals)
    .innerJoin(agents, eq(agents.id, approvals.agentId))
    .where(and(eq(agents.workspaceId, a.workspaceId), eq(approvals.status, "pending")))
    .orderBy(desc(approvals.createdAt))
    .limit(50);
  const open = openRows.map((r) => ({
    ...r.approval,
    agentHandle: r.agentHandle,
    mine: r.approval.agentId === opts.agentId,
  }));

  // On approval_response wakes, load the approval that was just decided so
  // the agent sees the verdict + the human's optional note, not just a bare
  // trigger name.
  let approvalResponse: ContextPacket["approvalResponse"];
  if (opts.approvalId) {
    const [ap] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, opts.approvalId))
      .limit(1);
    if (ap) {
      let decidedByHandle: string | null = null;
      if (ap.decidedBy) {
        const [dm] = await db.select().from(members).where(eq(members.id, ap.decidedBy)).limit(1);
        if (dm) {
          if (dm.kind === "user") {
            const [du] = await db.select().from(users).where(eq(users.id, dm.refId)).limit(1);
            decidedByHandle = du?.handle ?? null;
          } else {
            const [da] = await db.select().from(agents).where(eq(agents.id, dm.refId)).limit(1);
            decidedByHandle = da?.handle ?? null;
          }
        }
      }
      approvalResponse = {
        id: ap.id,
        scope: ap.scope,
        action: ap.action,
        status: ap.status,
        note: ap.decisionNote ?? null,
        decidedByHandle,
        payload: ap.payloadJson ?? {},
        deliveredSecrets: ap.deliveredSecrets ?? null,
      };
    }
  }

  // Bucket memory by scope. We load everything in one query and filter in
  // memory — the volume is per-agent and small. byConversation/byTask are
  // pruned later to only include scopes actually relevant to this packet.
  const memRows = await db.select().from(memoryKv).where(eq(memoryKv.agentId, opts.agentId));
  const memGlobal: Record<string, unknown> = {};
  const memByConv: Record<string, Record<string, unknown>> = {};
  const memByTask: Record<string, Record<string, unknown>> = {};
  for (const r of memRows) {
    if (r.scope === "global") {
      memGlobal[r.key] = r.valueJson;
    } else if (r.scope === "conversation") {
      (memByConv[r.scopeId] ??= {})[r.key] = r.valueJson;
    } else if (r.scope === "task") {
      (memByTask[r.scopeId] ??= {})[r.key] = r.valueJson;
    }
  }

  // If the triggering message is inside (or is the root of) a thread, pull the
  // whole thread regardless of age so the agent has the full local context.
  let thread: ContextPacket["thread"] = null;
  if (opts.messageId) {
    const [trig] = await db.select().from(messages).where(eq(messages.id, opts.messageId)).limit(1);
    if (trig) {
      const rootId = trig.parentId ?? trig.id;
      const [rootMsg] = await db.select().from(messages).where(eq(messages.id, rootId)).limit(1);
      const replies = await db
        .select()
        .from(messages)
        .where(and(eq(messages.parentId, rootId), isNull(messages.deletedAt)))
        .orderBy(asc(messages.ts));
      const chain = [rootMsg, ...replies].filter(Boolean) as typeof replies;
      // Ensure every author is in the directory.
      const missing = chain
        .map((m) => m.memberId)
        .filter((mid) => !memberDirectory[mid]);
      if (missing.length) {
        const extra = await db.select().from(members).where(inArray(members.id, missing));
        const uRefs = extra.filter((m) => m.kind === "user").map((m) => m.refId);
        const aRefs = extra.filter((m) => m.kind === "agent").map((m) => m.refId);
        const uX = uRefs.length ? await db.select().from(users).where(inArray(users.id, uRefs)) : [];
        const aX = aRefs.length ? await db.select().from(agents).where(inArray(agents.id, aRefs)) : [];
        const uXM = new Map(uX.map((u) => [u.id, u]));
        const aXM = new Map(aX.map((a) => [a.id, a]));
        for (const m of extra) {
          if (m.kind === "user") {
            const u = uXM.get(m.refId);
            if (u) memberDirectory[m.id] = { memberId: m.id, kind: "user", name: u.name, handle: u.handle };
          } else {
            const ag = aXM.get(m.refId);
            if (ag) memberDirectory[m.id] = {
              memberId: m.id,
              kind: "agent",
              name: ag.name,
              handle: ag.handle,
              isMe: m.id === agentMemberId,
            };
          }
        }
      }
      if (chain.length > 1 || (rootMsg && trig.parentId)) {
        const [conv] = await db
          .select()
          .from(conversations)
          .where(eq(conversations.id, chain[0]!.conversationId))
          .limit(1);
        // Thread reactions — fetch fresh if we haven't already pulled them.
        const threadIds = chain.map((m) => m.id);
        const missingIds = threadIds.filter((id) => !rxByMsg.has(id));
        if (missingIds.length) {
          const extraRx = await db
            .select()
            .from(reactions)
            .where(inArray(reactions.messageId, missingIds));
          for (const r of extraRx) {
            const list = rxByMsg.get(r.messageId) ?? [];
            list.push({
              emoji: r.emoji,
              memberId: r.memberId,
              memberHandle: memberDirectory[r.memberId]?.handle ?? "unknown",
            });
            rxByMsg.set(r.messageId, list);
          }
        }
        thread = {
          conversationId: chain[0]!.conversationId,
          conversationKind: conv?.kind ?? "channel",
          conversationName: conv?.name ?? null,
          rootMessageId: rootId,
          messages: chain.map((m) => ({
            id: m.id,
            memberId: m.memberId,
            memberHandle: memberDirectory[m.memberId]?.handle ?? "unknown",
            memberName: memberDirectory[m.memberId]?.name ?? "unknown",
            bodyMd: m.bodyMd,
            parentId: m.parentId,
            ts: m.ts.toISOString(),
            mentions: m.mentions,
            reactions: rxByMsg.get(m.id) ?? [],
            attachments: (m.attachmentsJson ?? []) as InboxAttachment[],
          })),
        };
      }
    }
  }

  const reporting = await loadReportingFor(a.workspaceId, agentMemberId);

  // In-context memory blocks (lazily seeded): the shared team whiteboard + the
  // agent's private notes, compiled into the prompt and self-edited each run.
  const memoryBlocks = (await ensureAndLoadBlocks(a.id, a.workspaceId).catch(() => [])).map((b) => ({
    label: b.label,
    description: b.description,
    value: b.value,
    charLimit: b.charLimit,
    shared: b.shared,
  }));

  // Pinned brief + live workspace file manifest (fail-safe, read fresh).
  const [workspaceBrief, workspaceFiles] = await Promise.all([
    readWorkspaceBrief(),
    readWorkspaceManifest(),
  ]);

  // Active goals (not done/archived), most recent first, bounded for prompt size.
  const allGoals = (await listGoals(a.workspaceId)).goals;
  const activeGoalsRaw = allGoals
    .filter((g) => g.status !== "done" && g.status !== "archived")
    .slice(0, 10);
  // Attach each goal's ledger (plan + facts + dead-ends + recent progress) so an
  // agent reads the externalized state instead of re-deriving intent from chat.
  const ledgerMap = await loadLedgers(activeGoalsRaw.map((g) => g.id));
  const activeGoals = activeGoalsRaw.map((g) => {
    const led = ledgerMap.get(g.id);
    return {
      id: g.id,
      title: g.title,
      status: g.status,
      kind: g.kind ?? "goal",
      parentGoalId: g.parentGoalId ?? null,
      ownerMemberId: g.ownerMemberId ?? null,
      taskCounts: g.taskCounts,
      ledger: led
        ? {
            plan: led.plan,
            facts: led.facts,
            triedDeadEnds: led.triedDeadEnds,
            recentProgress: led.progressNotes.slice(-5).map((p) => p.note),
            stallCount: led.stallCount,
            // Typed per-round progress signal — when the sweeper has flagged the
            // team as looping, surface it so the agent changes approach instead
            // of repeating the same step. Only attached when there's something
            // actionable to say (looping or no progress).
            progress:
              led.progressLedger && (led.progressLedger.isInLoop || !led.progressLedger.isProgressBeingMade)
                ? { isInLoop: led.progressLedger.isInLoop, nextStep: led.progressLedger.nextStep }
                : null,
          }
        : null,
    };
  });

  let taskCtx: ContextPacket["task"];
  if (opts.taskId) {
    const [t] = await db.select().from(tasks).where(eq(tasks.id, opts.taskId)).limit(1);
    if (t) {
      const [conv] = t.conversationId
        ? await db
            .select({ name: conversations.name })
            .from(conversations)
            .where(eq(conversations.id, t.conversationId))
            .limit(1)
        : [];
      const as = await db
        .select({ memberId: taskAssignees.memberId })
        .from(taskAssignees)
        .where(eq(taskAssignees.taskId, opts.taskId));
      const assigneeIds = as.map((r) => r.memberId);
      // Ensure assignee members are in the directory (for handle rendering).
      const missingAssignees = assigneeIds.filter((mid) => !memberDirectory[mid]);
      if (missingAssignees.length) {
        const extra = await db.select().from(members).where(inArray(members.id, missingAssignees));
        const uRefs = extra.filter((m) => m.kind === "user").map((m) => m.refId);
        const aRefs = extra.filter((m) => m.kind === "agent").map((m) => m.refId);
        const uX = uRefs.length ? await db.select().from(users).where(inArray(users.id, uRefs)) : [];
        const aX = aRefs.length ? await db.select().from(agents).where(inArray(agents.id, aRefs)) : [];
        const uXM = new Map(uX.map((u) => [u.id, u]));
        const aXM = new Map(aX.map((ag) => [ag.id, ag]));
        for (const m of extra) {
          if (m.kind === "user") {
            const u = uXM.get(m.refId);
            if (u) memberDirectory[m.id] = { memberId: m.id, kind: "user", name: u.name, handle: u.handle };
          } else {
            const ag = aXM.get(m.refId);
            if (ag)
              memberDirectory[m.id] = {
                memberId: m.id,
                kind: "agent",
                name: ag.name,
                handle: ag.handle,
                isMe: m.id === agentMemberId,
              };
          }
        }
      }
      const labels = (
        await db.select({ label: taskLabels.label }).from(taskLabels).where(eq(taskLabels.taskId, opts.taskId))
      ).map((r) => r.label);
      const subs = await db
        .select()
        .from(tasks)
        .where(eq(tasks.parentId, opts.taskId))
        .orderBy(asc(tasks.position));
      const subIds = subs.map((s) => s.id);
      const subAssignRows = subIds.length
        ? await db.select().from(taskAssignees).where(inArray(taskAssignees.taskId, subIds))
        : [];
      const subAssignMap = new Map<string, string[]>();
      for (const r of subAssignRows) {
        const arr = subAssignMap.get(r.taskId) ?? [];
        arr.push(r.memberId);
        subAssignMap.set(r.taskId, arr);
      }
      const recentComments = await db
        .select()
        .from(taskComments)
        .where(and(eq(taskComments.taskId, opts.taskId)))
        .orderBy(desc(taskComments.ts))
        .limit(10);
      // Long thread? Surface a rolling summary of the older comments (and
      // refresh it in the background) so the agent sees the head, not just the
      // last 10. No-op/null unless the condenser is enabled and the thread is
      // long. Counting only when the window is full avoids a query on short threads.
      let historySummary: string | null = null;
      if (recentComments.length >= 10) {
        historySummary = await loadTaskSummary(opts.taskId).catch(() => null);
        void maybeSummarizeTaskThread(opts.taskId);
      }
      // Full "why" chain: the goal this task serves, up through its parent
      // goals/project. Top-first so the prompt reads mission ▸ project ▸ goal.
      const goalAncestry = t.goalId
        ? (await getGoalAncestry(t.goalId)).map((g) => ({
            id: g.id,
            title: g.title,
            kind: g.kind ?? "goal",
            status: g.status,
          }))
        : [];
      // Surface the pre-computed quality verdict only while the task is in
      // review (that's when a reviewer needs it); skip the lookup otherwise.
      const latestVerdict = t.status === "review" ? await latestVerdictSummary(opts.taskId).catch(() => null) : null;
      taskCtx = {
        id: t.id,
        conversationId: t.conversationId,
        conversationName: conv?.name ?? null,
        title: t.title,
        bodyMd: t.bodyMd,
        status: t.status,
        progress: t.progress,
        dueAt: t.dueAt ? t.dueAt.toISOString() : null,
        labels,
        assignees: assigneeIds,
        assigneeHandles: assigneeIds.map((mid) => memberDirectory[mid]?.handle ?? "unknown"),
        parentId: t.parentId,
        createdBy: t.createdBy,
        subtasks: subs.map((s) => ({
          id: s.id,
          title: s.title,
          status: s.status,
          assignees: subAssignMap.get(s.id) ?? [],
        })),
        recentComments: recentComments
          .slice()
          .reverse()
          .map((c) => ({
            id: c.id,
            memberId: c.memberId,
            memberHandle: memberDirectory[c.memberId]?.handle ?? "unknown",
            bodyMd: c.bodyMd,
            ts: c.ts.toISOString(),
          })),
        historySummary,
        goalAncestry,
        latestVerdict,
      };
    }
  }

  // Agent's open workload — assigned tasks not yet `done` or archived.
  // Bounded to 12 to keep prompts small; sorted freshest-activity-first so
  // when the inbox wake fires, the most-active cards are at the top.
  const myAssigned = agentMemberId
    ? await db
        .select({ taskId: taskAssignees.taskId })
        .from(taskAssignees)
        .where(eq(taskAssignees.memberId, agentMemberId))
    : [];
  const myTaskIds = myAssigned.map((r) => r.taskId);
  const myTaskRows = myTaskIds.length
    ? await db
        .select()
        .from(tasks)
        .where(and(inArray(tasks.id, myTaskIds), eq(tasks.archived, false)))
        .orderBy(desc(tasks.updatedAt))
        .limit(20)
    : [];
  const openMyTaskRows = myTaskRows.filter((t) => t.status !== "done").slice(0, 12);
  const myTaskIdsOpen = openMyTaskRows.map((t) => t.id);

  const myLatestComments = myTaskIdsOpen.length
    ? await db
        .select({
          taskId: taskComments.taskId,
          memberId: taskComments.memberId,
          bodyMd: taskComments.bodyMd,
          ts: taskComments.ts,
        })
        .from(taskComments)
        .where(and(inArray(taskComments.taskId, myTaskIdsOpen), isNull(taskComments.deletedAt)))
        .orderBy(desc(taskComments.ts))
    : [];
  const myLatestByTask = new Map<string, (typeof myLatestComments)[number]>();
  for (const c of myLatestComments) if (!myLatestByTask.has(c.taskId)) myLatestByTask.set(c.taskId, c);
  const myCommentCount = new Map<string, number>();
  for (const c of myLatestComments) myCommentCount.set(c.taskId, (myCommentCount.get(c.taskId) ?? 0) + 1);

  // Resolve any comment authors we haven't already pulled into memberDirectory.
  const myCommentMemberIds = Array.from(new Set(myLatestComments.map((c) => c.memberId))).filter(
    (m) => !memberDirectory[m],
  );
  if (myCommentMemberIds.length) {
    const extraMembers = await db
      .select()
      .from(members)
      .where(inArray(members.id, myCommentMemberIds));
    const uRefs = extraMembers.filter((m) => m.kind === "user").map((m) => m.refId);
    const aRefs = extraMembers.filter((m) => m.kind === "agent").map((m) => m.refId);
    const uX = uRefs.length ? await db.select().from(users).where(inArray(users.id, uRefs)) : [];
    const aX = aRefs.length ? await db.select().from(agents).where(inArray(agents.id, aRefs)) : [];
    const uXM = new Map(uX.map((u) => [u.id, u]));
    const aXM = new Map(aX.map((a) => [a.id, a]));
    for (const m of extraMembers) {
      if (m.kind === "user") {
        const u = uXM.get(m.refId);
        if (u) memberDirectory[m.id] = { memberId: m.id, kind: "user", name: u.name, handle: u.handle };
      } else {
        const ag = aXM.get(m.refId);
        if (ag) memberDirectory[m.id] = {
          memberId: m.id,
          kind: "agent",
          name: ag.name,
          handle: ag.handle,
          isMe: m.id === agentMemberId,
        };
      }
    }
  }

  const myTaskLabelRows = myTaskIdsOpen.length
    ? await db
        .select()
        .from(taskLabels)
        .where(inArray(taskLabels.taskId, myTaskIdsOpen))
    : [];
  const labelsByTask = new Map<string, string[]>();
  for (const l of myTaskLabelRows) {
    const arr = labelsByTask.get(l.taskId) ?? [];
    arr.push(l.label);
    labelsByTask.set(l.taskId, arr);
  }

  const myTaskConvIds = Array.from(
    new Set(openMyTaskRows.map((t) => t.conversationId).filter((id): id is string => !!id)),
  );
  const myTaskConvs = myTaskConvIds.length
    ? await db
        .select({ id: conversations.id, name: conversations.name, kind: conversations.kind })
        .from(conversations)
        .where(inArray(conversations.id, myTaskConvIds))
    : [];
  const convNameById = new Map(myTaskConvs.map((c) => [c.id, c]));

  const myTasks = openMyTaskRows.map((t) => {
    const latest = myLatestByTask.get(t.id);
    const conv = t.conversationId ? convNameById.get(t.conversationId) : null;
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      progress: t.progress,
      dueAt: t.dueAt?.toISOString() ?? null,
      conversationId: t.conversationId ?? null,
      conversationName: conv?.name ?? null,
      labels: labelsByTask.get(t.id) ?? [],
      commentCount: myCommentCount.get(t.id) ?? 0,
      latestComment: latest
        ? {
            memberId: latest.memberId,
            memberHandle: memberDirectory[latest.memberId]?.handle ?? "unknown",
            bodyMd: latest.bodyMd.slice(0, 400),
            ts: latest.ts.toISOString(),
          }
        : null,
    };
  });

  // Trigger text for knowledge matching: what this run is "about" — the thread
  // it's replying in, recent inbox chatter, and the agent's open work. Keyword
  // matches against this decide which gated knowledge files get injected.
  const triggerText = [
    ...(thread?.messages ?? []).map((m) => m.bodyMd),
    ...inbox.slice(0, 2).flatMap((c) => (c.messages ?? []).slice(-4).map((m) => m.bodyMd)),
    ...myTasks.map((t) => t.title),
    ...activeGoals.map((g) => g.title),
  ]
    .join("\n")
    .slice(0, 8000);
  const workspaceKnowledge = await readWorkspaceKnowledge(triggerText);
  // Shared multi-file project memory: always-injected index + trigger-matched
  // file bodies (both budget-bounded, fail-safe → empty). Same triggerText the
  // knowledge layer uses, so a run "about" a project pulls that project's files.
  const projectCtx = await buildProjectContext(triggerText);

  return {
    agent: {
      id: a.id,
      memberId: agentMemberId,
      handle: a.handle,
      name: a.name,
      model: a.model,
      scopes: a.scopes,
      brief: a.brief,
    },
    workspace: {
      id: ws.id,
      name: ws.name,
      handle: ws.handle,
      mission: ws.mission,
      brief: workspaceBrief,
      files: workspaceFiles,
      knowledge: workspaceKnowledge,
      projectIndex: projectCtx.index,
      projectFiles: projectCtx.files,
    },
    trigger: opts.trigger,
    triggerConversationId: opts.conversationId ?? null,
    triggerMessageId: opts.messageId,
    previousRunFailure: opts.previousRunFailure ?? null,
    stuckBreak: opts.stuckBreak ?? null,
    lastCodeResult: opts.lastCodeResult ?? null,
    members: memberDirectory,
    thread,
    inbox,
    openApprovals: open.map((o) => ({
      id: o.id,
      scope: o.scope,
      action: o.action,
      status: o.status,
      createdAt: o.createdAt.toISOString(),
      agentHandle: o.agentHandle,
      mine: o.mine,
    })),
    approvalResponse,
    memory: {
      global: memGlobal,
      byConversation: pickKeys(memByConv, [
        ...inbox.map((c) => c.conversationId),
        ...(opts.conversationId ? [opts.conversationId] : []),
      ]),
      byTask: pickKeys(memByTask, [
        ...myTasks.map((t) => t.id),
        ...(taskCtx ? [taskCtx.id] : []),
      ]),
    },
    memoryBlocks,
    reporting,
    goals: activeGoals,
    myTasks,
    task: taskCtx,
  };
}

// The shared workspace mount inside the api/worker container (same host dir the
// agent containers see at /workspace). Configurable for non-standard deploys;
// every read is fail-safe so a missing mount just yields empty brief/manifest.
const WORKSPACE_MOUNT = process.env.CC_WORKSPACE_MOUNT || "/workspace";
const BRIEF_MAX_CHARS = 6000;
const MANIFEST_MAX_ENTRIES = 80;
const MANIFEST_SKIP = /(^|\/)(node_modules|\.venv|\.git|__pycache__)(\/|$)/;

// Read <mount>/BRIEF.md (capped). Fresh every call so a human editing the brief
// steers the team on their next wake with no redeploy.
async function readWorkspaceBrief(): Promise<string> {
  try {
    const { promises: fsp } = await import("node:fs");
    const { join } = await import("node:path");
    const buf = await fsp.readFile(join(WORKSPACE_MOUNT, "BRIEF.md"), "utf8");
    return buf.length > BRIEF_MAX_CHARS ? buf.slice(0, BRIEF_MAX_CHARS) + "\n…(brief truncated)" : buf;
  } catch {
    return "";
  }
}

const KNOWLEDGE_MAX_FILES = 5;
const KNOWLEDGE_MAX_CHARS_PER_FILE = 2000;
const KNOWLEDGE_MAX_TOTAL_CHARS = 5000;

// Parse a knowledge file's optional YAML-ish frontmatter. Supports a flow list
// (`triggers: [a, b]`), a block list (`triggers:\n  - a\n  - b`), and
// `always: true`. Hand-rolled (no yaml dep on this hot path); anything it can't
// parse just yields no triggers, so a malformed file is dormant, never fatal.
export function parseKnowledgeFrontmatter(raw: string): {
  triggers: string[];
  always: boolean;
  body: string;
} {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw);
  if (!m) return { triggers: [], always: false, body: raw.trim() };
  const [, fm, body] = m;
  let always = false;
  const triggers: string[] = [];
  const lines = fm.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*always\s*:\s*true\s*$/i.test(line)) always = true;
    const flow = /^\s*triggers\s*:\s*\[(.*)\]\s*$/i.exec(line);
    if (flow) {
      for (const t of flow[1].split(",")) {
        const v = t.trim().replace(/^["']|["']$/g, "");
        if (v) triggers.push(v.toLowerCase());
      }
      continue;
    }
    // Block list: `triggers:` then indented `- item` lines.
    if (/^\s*triggers\s*:\s*$/i.test(line)) {
      for (let j = i + 1; j < lines.length; j++) {
        const item = /^\s*-\s*(.+?)\s*$/.exec(lines[j]);
        if (!item) break;
        const v = item[1].trim().replace(/^["']|["']$/g, "");
        if (v) triggers.push(v.toLowerCase());
      }
    }
  }
  return { triggers, always, body: body.trim() };
}

// Decide which knowledge entries to inject for this run. Always-on entries
// (no triggers, or `always: true`) are always included; gated entries match if
// any of their lowercased trigger keywords is a substring of the run's trigger
// text. Pure + exported for tests.
export function selectKnowledge(
  entries: Array<{ name: string; triggers: string[]; always: boolean; body: string }>,
  triggerText: string,
): Array<{ name: string; content: string }> {
  const hay = triggerText.toLowerCase();
  const out: Array<{ name: string; content: string }> = [];
  let total = 0;
  for (const e of entries) {
    const matched = e.always || e.triggers.length === 0 || e.triggers.some((t) => hay.includes(t));
    if (!matched) continue;
    const content = e.body.slice(0, KNOWLEDGE_MAX_CHARS_PER_FILE);
    if (total + content.length > KNOWLEDGE_MAX_TOTAL_CHARS) break;
    total += content.length;
    out.push({ name: e.name, content });
    if (out.length >= KNOWLEDGE_MAX_FILES) break;
  }
  return out;
}

// Read <mount>/knowledge/*.md, parse frontmatter, and return the entries that
// apply to this run (always-on + keyword-matched). Fail-safe: a missing dir or
// unreadable file just yields fewer entries. Fresh every call so a human
// dropping a knowledge file steers the team on the next wake with no redeploy.
async function readWorkspaceKnowledge(
  triggerText: string,
): Promise<Array<{ name: string; content: string }>> {
  try {
    const { promises: fsp } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(WORKSPACE_MOUNT, "knowledge");
    const ents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = ents
      .filter((e) => e.isFile() && /\.(md|txt)$/i.test(e.name))
      .map((e) => e.name)
      .sort()
      .slice(0, 30);
    const parsed: Array<{ name: string; triggers: string[]; always: boolean; body: string }> = [];
    for (const name of files) {
      const raw = await fsp.readFile(join(dir, name), "utf8").catch(() => "");
      if (!raw.trim()) continue;
      const { triggers, always, body } = parseKnowledgeFrontmatter(raw);
      if (body) parsed.push({ name, triggers, always, body });
    }
    return selectKnowledge(parsed, triggerText);
  } catch {
    return [];
  }
}

// Shallow-recursive manifest of the shared workspace: relative path + size for
// each regular file, depth-bounded, junk dirs skipped, capped. Sorted by mtime
// so the freshest files are at the top of the (possibly truncated) list.
async function readWorkspaceManifest(): Promise<Array<{ path: string; size: number }> | null> {
  try {
    const { promises: fsp } = await import("node:fs");
    const { join, relative } = await import("node:path");
    const collected: Array<{ path: string; size: number; mtime: number }> = [];
    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > 4 || collected.length > MANIFEST_MAX_ENTRIES * 3) return;
      const ents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of ents) {
        const abs = join(dir, e.name);
        const rel = relative(WORKSPACE_MOUNT, abs);
        if (MANIFEST_SKIP.test(rel) || e.name.startsWith(".")) continue;
        if (e.isDirectory()) {
          await walk(abs, depth + 1);
        } else if (e.isFile()) {
          const st = await fsp.stat(abs).catch(() => null);
          if (st) collected.push({ path: rel, size: st.size, mtime: st.mtimeMs });
        }
      }
    }
    await walk(WORKSPACE_MOUNT, 0);
    if (!collected.length) return [];
    collected.sort((a, b) => b.mtime - a.mtime);
    return collected.slice(0, MANIFEST_MAX_ENTRIES).map(({ path, size }) => ({ path, size }));
  } catch {
    return null;
  }
}

// Prune a record-of-records to only include the requested keys. Used to
// strip per-scope memory down to scopes the agent actually needs in this
// packet (active inbox conversations, open tasks).
function pickKeys<V>(
  src: Record<string, V>,
  keys: string[],
): Record<string, V> {
  const out: Record<string, V> = {};
  const seen = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) continue;
    seen.add(k);
    if (src[k]) out[k] = src[k];
  }
  return out;
}
