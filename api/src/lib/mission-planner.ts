import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { goals, workspaces, workspaceMembers, members } from "../db/schema.js";
import { chatJsonOutcome, plannerEnabled } from "./completion.js";
import { createGoal } from "./goals-core.js";
import { notify } from "./notifications.js";
import { envInt } from "./env.js";
import { checkProposal, GOAL_LIMITS, STRICTER_RETRY_NOTE } from "./llm-proposal-guard.js";

// ─────────────────────────────────────────────────────────────────────────
// The mission planner — a daily pass that turns the workspace MISSION into
// fresh goals. Where the goal planner decomposes one goal into tasks, this
// sits one tier up: it reads the mission, looks at the projects and goals
// that already exist, and proposes the next few goals worth pursuing —
// attached to the best-fit existing project. Created goals are ordinary
// `open` goals, so the existing auto-planner immediately decomposes them
// into tasks and the board starts moving.
// ─────────────────────────────────────────────────────────────────────────

// New goals per workspace per run — deliberately small so a mission drips
// steady work onto the board instead of flooding it.
const GOALS_PER_RUN = envInt("MISSION_GOALS_PER_RUN", 2, { min: 1 });
// Backpressure: skip a workspace that already has this many non-done goals.
// The mission shouldn't pile new intent onto a board the team can't clear.
const MAX_OPEN_GOALS = envInt("MISSION_MAX_OPEN_GOALS", 12, { min: 1 });

const ProposalSchema = z.object({
  goals: z
    .array(
      z.object({
        title: z.string().min(1).max(300),
        description: z.string().max(4000).optional().default(""),
        // Exact title of an EXISTING project to file the goal under ("" = none fits).
        project: z.string().max(300).optional().default(""),
        rationale: z.string().max(500).optional().default(""),
      }),
    )
    .max(10),
});

function buildMessages(
  mission: string,
  projects: Array<{ title: string }>,
  existingTitles: string[],
  // Set on the one retry after a run where every proposal was prompt filler.
  strictNote = "",
): Array<{ role: "system" | "user"; content: string }> {
  const system = [
    "You are the strategy manager for a workspace of AI agents and humans. Once a day you review the workspace MISSION and propose the next goals worth pursuing.",
    `Propose at most ${GOALS_PER_RUN} new goals. Quality over quantity — if the existing goals already cover the mission's next steps, return an empty list.`,
    "Each goal must be a concrete, finishable outcome that advances the mission (not a vague theme, not a task — a goal a small team completes in days).",
    "Never duplicate or trivially rephrase an EXISTING goal. Build on what exists: prefer the natural next step after the goals already there.",
    "If a PROJECT clearly covers the goal, set `project` to that project's exact title; otherwise leave it empty.",
    "Return ONLY a JSON object of this exact shape, no prose, no markdown fence:",
    '{"goals":[{"title":"...","description":"what done looks like","project":"exact project title or empty","rationale":"why this is the next move for the mission"}]}',
    "The strings above are a SHAPE, not content — never return them verbatim.",
    strictNote,
  ]
    .filter(Boolean)
    .join("\n");

  const user = [
    `WORKSPACE MISSION: ${mission}`,
    "",
    "PROJECTS:",
    projects.length ? projects.map((p) => `- ${p.title}`).join("\n") : "(none yet)",
    "",
    "EXISTING GOALS (do not duplicate):",
    existingTitles.length ? existingTitles.map((t) => `- ${t}`).join("\n") : "(none yet)",
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// The workspace's first human admin — the actor the daily goals are created
// and owned by, so stall/plan-failure notifications have a human target.
async function findAdminMember(workspaceId: string): Promise<string | null> {
  const admins = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "admin")));
  if (!admins.length) return null;
  const [m] = await db
    .select({ id: members.id })
    .from(members)
    .where(
      and(
        eq(members.workspaceId, workspaceId),
        eq(members.kind, "user"),
        inArray(
          members.refId,
          admins.map((a) => a.userId),
        ),
      ),
    )
    .limit(1);
  return m?.id ?? null;
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

// The goal body exactly as it will be stored — built once so the content gate
// judges the same text the board would show. Exported for tests.
export function composeBody(p: { description?: string; rationale?: string }): string {
  return [p.description ?? "", p.rationale ? `_Why now: ${p.rationale}_` : ""].filter(Boolean).join("\n\n");
}

// What one workspace's pass produced. `transport` means the gateway never
// answered — the run stops rather than walking the remaining workspaces and
// hammering an exhausted router with the same 429.
interface WorkspaceResult {
  created: number;
  transport?: { status: number };
}

// One workspace: mission → up to GOALS_PER_RUN new goals.
async function planWorkspace(ws: { id: string; mission: string }): Promise<WorkspaceResult> {
  const rows = await db
    .select({ id: goals.id, title: goals.title, kind: goals.kind, status: goals.status })
    .from(goals)
    .where(eq(goals.workspaceId, ws.id));

  const live = rows.filter((g) => g.status !== "archived");
  const openCount = live.filter((g) => g.kind === "goal" && g.status !== "done").length;
  if (openCount >= MAX_OPEN_GOALS) {
    console.log(`[mission-planner] ${ws.id}: ${openCount} open goals ≥ cap ${MAX_OPEN_GOALS}, skipping`);
    return { created: 0 };
  }

  const projects = live.filter((g) => g.kind === "project" && g.status !== "done");
  // Feed every non-archived title (done included) as dedupe context — a goal
  // finished last week shouldn't be re-proposed this week.
  const existingTitles = live.map((g) => g.title).slice(0, 200);

  // One completion → parsed proposals. A TRANSPORT failure is reported as its
  // own kind: the model never saw the prompt, so it is not "the model proposed
  // nothing" and must not trigger the stricter retry below (a second call
  // against a rate-limited router just deepens the outage).
  type ProposeResult =
    | { kind: "goals"; goals: z.infer<typeof ProposalSchema>["goals"] }
    | { kind: "transport"; status: number }
    | { kind: "invalid" };
  const propose = async (strictNote: string): Promise<ProposeResult> => {
    const outcome = await chatJsonOutcome<unknown>(buildMessages(ws.mission, projects, existingTitles, strictNote), {
      temperature: 0.3,
      maxTokens: 2000,
      timeoutMs: 150_000,
    });
    if (outcome.kind === "transport") {
      console.warn(
        `[mission-planner] transport failure (${outcome.status}) for ${ws.id}, will retry next run` +
          (outcome.retryAfterMs == null ? "" : ` (retry after ~${Math.round(outcome.retryAfterMs / 1000)}s)`),
      );
      return { kind: "transport", status: outcome.status };
    }
    if (outcome.kind === "unconfigured") return { kind: "invalid" };
    const raw = outcome.kind === "ok" ? outcome.value : null;
    const parsed = ProposalSchema.safeParse(raw);
    if (!parsed.success) {
      console.error(
        `[mission-planner] proposal failed for ${ws.id}: ` +
          (raw === null
            ? `the model answered but the reply was unusable (${outcome.kind === "invalid" ? outcome.detail : "no JSON"})`
            : `schema rejected: ${JSON.stringify(raw).slice(0, 200)}`),
      );
      return { kind: "invalid" };
    }
    return { kind: "goals", goals: parsed.data.goals };
  };

  // Content gate. The schema only checks shapes, so a model that echoes the
  // prompt's example JSON back at us parses perfectly — that is how a goal
  // titled "..." reached a live board. Drop anything that is prompt filler or
  // too thin to be a real outcome, and say why.
  const keep = (proposals: z.infer<typeof ProposalSchema>["goals"]) =>
    proposals.filter((p) => {
      const body = composeBody(p);
      const verdict = checkProposal({ title: p.title, body }, GOAL_LIMITS);
      if (!verdict.ok) console.warn(`[mission-planner] rejected proposal: ${verdict.reason}`);
      return verdict.ok;
    });

  const first = await propose("");
  if (first.kind === "transport") return { created: 0, transport: { status: first.status } };
  if (first.kind === "invalid") return { created: 0 };
  let proposed = first.goals;
  let usable = keep(proposed);
  // All filler (but the model did propose something) — one stricter retry, then
  // give up for this run rather than putting junk on someone's board.
  if (proposed.length && !usable.length) {
    console.warn(`[mission-planner] ${ws.id}: every proposal rejected, retrying once with stricter instructions`);
    const retry = await propose(STRICTER_RETRY_NOTE);
    if (retry.kind === "transport") return { created: 0, transport: { status: retry.status } };
    proposed = retry.kind === "goals" ? retry.goals : [];
    usable = keep(proposed);
    if (!usable.length) {
      console.warn(`[mission-planner] ${ws.id}: retry still produced no usable proposal, no goal created`);
      return { created: 0 };
    }
  }
  if (!usable.length) return { created: 0 }; // model returned an empty list — nothing to do

  const actor = await findAdminMember(ws.id);
  if (!actor) {
    console.error(`[mission-planner] ${ws.id}: no human admin member, skipping`);
    return { created: 0 };
  }

  const seen = new Set(live.map((g) => norm(g.title)));
  const projectByTitle = new Map(projects.map((p) => [norm(p.title), p]));
  const createdTitles: string[] = [];
  for (const p of usable.slice(0, GOALS_PER_RUN)) {
    if (seen.has(norm(p.title))) continue; // model ignored the dedupe instruction
    const project = projectByTitle.get(norm(p.project));
    const body = composeBody(p);
    const r = await createGoal(
      { title: p.title, bodyMd: body, parentGoalId: project?.id ?? null, kind: "goal" },
      actor,
      ws.id,
    );
    if ("error" in r) {
      console.error(`[mission-planner] create failed for "${p.title}": ${r.error}`);
      continue;
    }
    seen.add(norm(p.title));
    createdTitles.push(p.title + (project ? ` (→ ${project.title})` : ""));
  }

  if (createdTitles.length) {
    await notify({
      workspaceId: ws.id,
      memberId: actor,
      kind: "system",
      title: `Daily planning added ${createdTitles.length} goal${createdTitles.length > 1 ? "s" : ""} from your mission`,
      body: createdTitles.join(" · "),
      link: `/goals`,
    }).catch(() => {});
  }
  return { created: createdTitles.length };
}

// Entry point for the repeatable "mission" job: every auto-planning workspace
// with a non-empty mission gets its daily goal proposals.
export async function runMissionPlanning(): Promise<void> {
  if (!plannerEnabled()) return;
  const wss = await db
    .select({ id: workspaces.id, mission: workspaces.mission })
    .from(workspaces)
    .where(eq(workspaces.autoPlan, "auto"));
  let total = 0;
  let stoppedOn: number | null = null;
  for (const ws of wss) {
    if (!ws.mission.trim()) continue;
    const r = await planWorkspace(ws).catch((e) => {
      console.error(`[mission-planner] workspace ${ws.id} failed`, e);
      return { created: 0 } as WorkspaceResult;
    });
    total += r.created;
    if (r.transport) {
      // The router is rate-limited for everyone, not just this workspace. Stop
      // the run here: the next daily pass (or sweep) picks it up, and nothing
      // has been recorded as a failed proposal.
      stoppedOn = r.transport.status;
      break;
    }
  }
  console.log(
    `[mission-planner] run complete: ${total} goal(s) created across ${wss.length} workspace(s)` +
      (stoppedOn ? ` — stopped early on a transport failure (${stoppedOn}), will retry next run` : ""),
  );
}
