// Verification gate — an LLM-as-judge that scores a task's deliverable against
// the task's acceptance criteria BEFORE the review→done flip is allowed. The
// existing byte-heuristic (isSubstantiveArtifact) only proves a deliverable
// EXISTS; this proves it's RELEVANT and not fabricated. Mirrors how the leading
// harnesses gate "done" on a verifiable final state (Anthropic's LLM-judge
// rubric, Devin's verifiable merges) rather than a reviewer's rubber-stamp.
//
// Reuses the planner's server-side LLM client (chatJson → the FreeLLMAPI
// gateway), so it needs no new infra and is provider-agnostic. Dormant unless a
// planner/embeddings base URL is configured, and FAIL-OPEN on any judge outage:
// a gateway hiccup must never freeze the board, so an unreachable/unparseable
// judge returns "allow" and the heuristic gate stands on its own.
import { z } from "zod";
import { chatJson, plannerEnabled } from "./completion.js";
import { liveArtifactRows, isSubstantiveArtifact, isTextualContentType } from "./task-artifacts.js";
import { readObject } from "./storage.js";
import { renderWebDeliverable, type RenderObservation } from "./deliverable-render.js";
import { db } from "../db/index.js";
import { taskVerifications, type TaskArtifact } from "../db/schema.js";
import { id } from "./ids.js";

const VerdictSchema = z.object({
  meets_acceptance_criteria: z.number().min(0).max(1),
  artifact_present_substantive: z.boolean(),
  not_fabricated: z.boolean(),
  verdict: z.enum(["pass", "fail"]),
  score: z.number().min(0).max(1),
  rationale: z.string().max(1500).default(""),
});
type Verdict = z.infer<typeof VerdictSchema>;

// OPT-IN by default. This gate makes an extra LLM call and can block a
// done-flip, so it must never surprise a user who has a weak/idiosyncratic
// model wired or didn't ask for it — they enable it explicitly with
// VERIFY_GATE=on. Still requires a planner/embeddings backend to be configured
// (it reuses that client), and fails OPEN on any judge outage.
export function verifierEnabled(): boolean {
  return process.env.VERIFY_GATE === "on" && plannerEnabled();
}
function passThreshold(): number {
  const n = Number(process.env.VERIFIER_PASS_THRESHOLD);
  return Number.isFinite(n) ? n : 0.6;
}
// The execution check (headless render) is separately opt-in: it spawns a
// Chromium subprocess, so it must never surprise a deployment that didn't ask
// for it or lacks the binary. Requires the rubric gate to be on too.
function execEnabled(): boolean {
  return process.env.VERIFY_EXEC === "on" && verifierEnabled();
}

function inferType(name: string, ct: string): "code" | "research" | "design" | "general" {
  const n = (name || "").toLowerCase();
  const c = (ct || "").toLowerCase();
  if (/\.(ts|tsx|js|jsx|py|sh|sql|go|rs|java|rb|php|c|cpp|css|html?)$/.test(n) || /javascript|typescript|x-sh|x-python/.test(c))
    return "code";
  if (/image\//.test(c) || /\.(fig|sketch|png|jpg|svg)$/.test(n)) return "design";
  if (/\.(md|txt|pdf|csv|json|docx?)$/.test(n) || /pdf|markdown|plain/.test(c)) return "research";
  return "general";
}

const MAX_DELIVERABLE_CHARS = 16_000;

// Returns null = pass/allow (let the done flip proceed); a string = block with
// that error code. Only meant to be called once a candidate substantive
// artifact has been found by the heuristic gate.
export async function verifyTaskForDone(opts: {
  taskId: string;
  workspaceId: string;
  title: string;
  bodyMd: string;
  decidedBy: string | null;
}): Promise<"verification_failed" | null> {
  if (!verifierEnabled()) return null; // dormant → heuristic gate stands alone

  // Pick the latest readable, substantive deliverable to judge.
  const rows = await liveArtifactRows(opts.taskId);
  // newest first
  rows.sort((a, b) => (b.createdAt?.getTime?.() ?? 0) - (a.createdAt?.getTime?.() ?? 0));
  let chosen: TaskArtifact | null = null;
  let chosenText = "";
  for (const r of rows) {
    // Only judge TEXTUAL deliverables — utf8-decoding a PDF/image/zip yields
    // garbage the judge would wrongly fail. Binary deliverables that clear the
    // substance heuristic are allowed through (the heuristic stands alone).
    if (!isTextualContentType(r.contentType)) continue;
    if (!(await isSubstantiveArtifact(r, opts.title))) continue;
    const buf = await readObject(r.storageKey);
    if (!buf) continue;
    chosen = r;
    chosenText = buf.toString("utf8").slice(0, MAX_DELIVERABLE_CHARS);
    break;
  }
  if (!chosen) return null; // no readable TEXT deliverable to judge → defer to heuristic outcome

  const taskType = inferType(chosen.name, chosen.contentType);

  // EXECUTION CHECK (opt-in, VERIFY_EXEC=on): for a web deliverable, render it
  // in headless Chromium and feed what ACTUALLY loaded to the judge, so it
  // scores an observed final state — not source that merely looks complete.
  // Strictly additive + fail-open: a null observation (chromium absent, error,
  // not web) just means the judge runs text-only, exactly as before.
  let obs: RenderObservation | null = null;
  let renderBlock = "";
  if (execEnabled() && taskType === "code" && /\.html?$/i.test(chosen.name)) {
    obs = await renderWebDeliverable({ taskId: opts.taskId, entryName: chosen.name }).catch(() => null);
    if (obs) {
      renderBlock =
        `\n\nRENDER OBSERVATION (headless Chromium actually loaded this deliverable):\n` +
        `- loaded_ok: ${obs.ok}\n` +
        `- rendered_visible_text_chars: ${obs.renderedTextLen}\n` +
        `- console_errors: ${obs.consoleErrors.length ? obs.consoleErrors.slice(0, 5).join(" | ") : "none"}\n`;
    }
  }

  const raw = await chatJson<unknown>(
    [
      {
        role: "system",
        content:
          "You are a STRICT deliverable verifier for a task board. Judge ONLY whether the " +
          "DELIVERABLE actually satisfies the TASK's acceptance criteria. Be skeptical. " +
          "FAIL if the deliverable is a plan/promise/placeholder/status-update instead of the " +
          "real work product, if it is off-topic, if it only restates the task, or if it " +
          "fabricates results (claims of tests passing, deploys, or data with no evidence). " +
          "If a RENDER OBSERVATION is present, weight it HEAVILY: a deliverable that failed to " +
          "load (loaded_ok:false), rendered almost no visible text, or threw console errors " +
          "FAILS regardless of how complete the source looks. " +
          'Return ONLY a JSON object: {"meets_acceptance_criteria":0..1,' +
          '"artifact_present_substantive":true|false,"not_fabricated":true|false,' +
          '"verdict":"pass"|"fail","score":0..1,"rationale":"one short paragraph"}',
      },
      {
        role: "user",
        content:
          `TASK TITLE: ${opts.title}\n` +
          `ACCEPTANCE CRITERIA / DESCRIPTION:\n${opts.bodyMd || "(none stated — judge against the title)"}\n\n` +
          `DELIVERABLE (${chosen.name}, ${chosen.contentType}):\n${chosenText}` +
          renderBlock,
      },
    ],
    { temperature: 0, maxTokens: 800, timeoutMs: 60_000 },
  );

  const method = obs ? "render" : taskType === "code" ? "test" : "rubric";
  const parsed = VerdictSchema.safeParse(raw);
  if (!parsed.success) {
    // Fail-open: a judge we can't reach/parse must not freeze the board.
    await record(opts, taskType, chosen.id, "error", null, obs ? { render: obs } : {}, "judge unreachable or unparseable — failing open", method);
    return null;
  }
  const v: Verdict = parsed.data;
  const pass = v.verdict === "pass" && v.not_fabricated && v.score >= passThreshold();
  await record(opts, taskType, chosen.id, pass ? "pass" : "fail", v.score, obs ? { ...v, render: obs } : v, v.rationale, method);
  return pass ? null : "verification_failed";
}

// The most recent verdict's rationale, so the reviewer agent learns WHAT the
// judge flagged instead of a bare "verification_failed".
export async function latestVerificationRationale(taskId: string): Promise<string | null> {
  const [row] = await db
    .select({ rationale: taskVerifications.rationale, verdict: taskVerifications.verdict })
    .from(taskVerifications)
    .where(eqTask(taskId))
    .orderBy(descCreated())
    .limit(1);
  if (!row || row.verdict === "pass") return null;
  return row.rationale || null;
}

async function record(
  opts: { taskId: string; workspaceId: string; decidedBy: string | null },
  taskType: string,
  artifactId: string,
  verdict: "pass" | "fail" | "error",
  score: number | null,
  rubric: Record<string, unknown>,
  rationale: string,
  method: string,
): Promise<void> {
  await db
    .insert(taskVerifications)
    .values({
      id: id("tver"),
      taskId: opts.taskId,
      workspaceId: opts.workspaceId,
      taskType,
      method,
      verdict,
      score: score ?? undefined,
      rubricJson: rubric,
      rationale,
      artifactId,
      decidedBy: opts.decidedBy ?? undefined,
    })
    .catch(() => {});
}

// Tiny local query helpers (kept here to avoid importing drizzle operators all
// over for one call).
import { eq, desc } from "drizzle-orm";
function eqTask(taskId: string) {
  return eq(taskVerifications.taskId, taskId);
}
function descCreated() {
  return desc(taskVerifications.createdAt);
}
