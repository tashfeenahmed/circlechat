import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { goals, workspaces, workspaceMembers, members } from "../db/schema.js";
import { chatJson, plannerEnabled } from "./completion.js";
import { createGoal } from "./goals-core.js";
import { notify } from "./notifications.js";

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
const GOALS_PER_RUN = Number(process.env.MISSION_GOALS_PER_RUN ?? 2);
// Backpressure: skip a workspace that already has this many non-done goals.
// The mission shouldn't pile new intent onto a board the team can't clear.
const MAX_OPEN_GOALS = Number(process.env.MISSION_MAX_OPEN_GOALS ?? 12);

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
): Array<{ role: "system" | "user"; content: string }> {
  const system = [
    "You are the strategy manager for a workspace of AI agents and humans. Once a day you review the workspace MISSION and propose the next goals worth pursuing.",
    `Propose at most ${GOALS_PER_RUN} new goals. Quality over quantity — if the existing goals already cover the mission's next steps, return an empty list.`,
    "Each goal must be a concrete, finishable outcome that advances the mission (not a vague theme, not a task — a goal a small team completes in days).",
    "Never duplicate or trivially rephrase an EXISTING goal. Build on what exists: prefer the natural next step after the goals already there.",
    "If a PROJECT clearly covers the goal, set `project` to that project's exact title; otherwise leave it empty.",
    "Return ONLY a JSON object of this exact shape, no prose, no markdown fence:",
    '{"goals":[{"title":"...","description":"what done looks like","project":"exact project title or empty","rationale":"why this is the next move for the mission"}]}',
  ].join("\n");

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

// One workspace: mission → up to GOALS_PER_RUN new goals. Returns #created.
async function planWorkspace(ws: { id: string; mission: string }): Promise<number> {
  const rows = await db
    .select({ id: goals.id, title: goals.title, kind: goals.kind, status: goals.status })
    .from(goals)
    .where(eq(goals.workspaceId, ws.id));

  const live = rows.filter((g) => g.status !== "archived");
  const openCount = live.filter((g) => g.kind === "goal" && g.status !== "done").length;
  if (openCount >= MAX_OPEN_GOALS) {
    console.log(`[mission-planner] ${ws.id}: ${openCount} open goals ≥ cap ${MAX_OPEN_GOALS}, skipping`);
    return 0;
  }

  const projects = live.filter((g) => g.kind === "project" && g.status !== "done");
  // Feed every non-archived title (done included) as dedupe context — a goal
  // finished last week shouldn't be re-proposed this week.
  const existingTitles = live.map((g) => g.title).slice(0, 200);

  const raw = await chatJson<unknown>(buildMessages(ws.mission, projects, existingTitles), {
    temperature: 0.3,
    maxTokens: 2000,
    timeoutMs: 150_000,
  });
  const parsed = ProposalSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(
      `[mission-planner] proposal failed for ${ws.id}: ` +
        (raw === null ? "chatJson returned null" : `schema rejected: ${JSON.stringify(raw).slice(0, 200)}`),
    );
    return 0;
  }

  const actor = await findAdminMember(ws.id);
  if (!actor) {
    console.error(`[mission-planner] ${ws.id}: no human admin member, skipping`);
    return 0;
  }

  const seen = new Set(live.map((g) => norm(g.title)));
  const projectByTitle = new Map(projects.map((p) => [norm(p.title), p]));
  const createdTitles: string[] = [];
  for (const p of parsed.data.goals.slice(0, GOALS_PER_RUN)) {
    if (seen.has(norm(p.title))) continue; // model ignored the dedupe instruction
    const project = projectByTitle.get(norm(p.project));
    const body = [p.description, p.rationale ? `_Why now: ${p.rationale}_` : ""]
      .filter(Boolean)
      .join("\n\n");
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
  return createdTitles.length;
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
  for (const ws of wss) {
    if (!ws.mission.trim()) continue;
    total += await planWorkspace(ws).catch((e) => {
      console.error(`[mission-planner] workspace ${ws.id} failed`, e);
      return 0;
    });
  }
  console.log(`[mission-planner] run complete: ${total} goal(s) created across ${wss.length} workspace(s)`);
}
