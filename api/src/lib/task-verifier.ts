// Verification gate — an LLM-as-judge that scores a task's deliverable against
// the task's acceptance criteria BEFORE the review→done flip is allowed. The
// existing byte-heuristic (isSubstantiveArtifact) only proves a deliverable
// EXISTS; this proves it's RELEVANT and not fabricated. Mirrors how the leading
// harnesses gate "done" on a verifiable final state (Anthropic's LLM-judge
// rubric, Devin's verifiable merges) rather than a reviewer's rubber-stamp.
//
// Reuses the server-side OpenAI-compatible chat client (chatJson), so it needs
// no new infra and is provider-agnostic. The judge needs an EXPLICIT
// chat-capable endpoint (VERIFY_JUDGE_BASE_URL or PLANNER_BASE_URL) — an
// embeddings-only deployment leaves it NOT CONFIGURED (logged once), never
// "unreachable" on every flip. What happens on a judge OUTAGE is configurable
// via VERIFY_FAIL_MODE (open = allow the flip, closed = block, hold = block and
// post one comment so a human reviews); the default stays fail-OPEN.
import { z } from "zod";
import { chatJson, judgeConfigured, resolveJudgeTarget } from "./completion.js";
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
// VERIFY_GATE=on. Still requires a chat-capable judge endpoint; when VERIFY_GATE
// is on but no judge URL resolves, say so ONCE and stay dormant (the old code
// fell back to EMBEDDINGS_BASE_URL and then logged an "outage" per flip).
let warnedUnconfigured = false;
export function verifierEnabled(): boolean {
  if (process.env.VERIFY_GATE !== "on") return false;
  if (judgeConfigured()) return true;
  if (!warnedUnconfigured) {
    warnedUnconfigured = true;
    console.error(
      "[verifier] VERIFY_GATE=on but the judge is NOT CONFIGURED: no chat-capable endpoint. " +
        "Set PLANNER_BASE_URL (+ PLANNER_MODEL / PLANNER_API_KEY) or VERIFY_JUDGE_BASE_URL (+ VERIFY_JUDGE_MODEL / VERIFY_JUDGE_API_KEY). " +
        "EMBEDDINGS_BASE_URL alone is NOT used for the judge. The verification gate is OFF until this is fixed.",
    );
  }
  return false;
}

// What to do when the judge is configured but unreachable/unparseable.
//   open   — allow the flip (heuristic gate stands alone). DEFAULT.
//   closed — block the flip silently (recorded as an error verdict).
//   hold   — block the flip AND post one comment on the task so a human
//            knows it is waiting on them, not on the agent.
// How long one judge call may take. Free/`auto` gateways often land on
// reasoning models that need well over a minute on a prompt carrying a whole
// deliverable; the only live outage reason after the 5 Sep deploy was
// `timeout_60000ms`. Override with VERIFY_JUDGE_TIMEOUT_MS.
export function judgeTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.VERIFY_JUDGE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 180_000;
}

export type VerifyFailMode = "open" | "closed" | "hold";
export function resolveFailMode(raw: string | undefined = process.env.VERIFY_FAIL_MODE): VerifyFailMode {
  const v = (raw || "").trim().toLowerCase();
  return v === "closed" || v === "hold" ? v : "open";
}
// Pure decision for the done-flip caller: does a judge outage block, and
// should a hold comment be posted? Exported for tests.
export function decideOnJudgeOutage(mode: VerifyFailMode): { block: boolean; comment: boolean } {
  if (mode === "closed") return { block: true, comment: false };
  if (mode === "hold") return { block: true, comment: true };
  return { block: false, comment: false };
}

// Re-judging the SAME deliverable within this window reuses the last verdict.
// Agents retry a rejected done-flip on every heartbeat (147 retries on one card
// were observed); each retry cost a 60s judge call against a rate-limited
// gateway, which is how the judge ended up "unreachable" most of the time.
function rejudgeMinMs(): number {
  const n = Number(process.env.VERIFY_REJUDGE_MIN_MS);
  return Number.isFinite(n) && n >= 0 ? n : 10 * 60 * 1000;
}
export function shouldReuseVerdict(
  last: { artifactId: string | null; verdict: string; createdAt: Date } | null | undefined,
  artifactId: string,
  now: number = Date.now(),
  minMs: number = rejudgeMinMs(),
): boolean {
  if (!last || !last.artifactId || last.artifactId !== artifactId) return false;
  if (last.verdict !== "pass" && last.verdict !== "fail") return false; // never reuse an outage
  return now - last.createdAt.getTime() < minMs;
}
function passThreshold(): number {
  const n = Number(process.env.VERIFIER_PASS_THRESHOLD);
  return Number.isFinite(n) ? n : 0.6;
}
// The execution check (headless render) is separately opt-in: it spawns a
// Chromium subprocess, so it must never surprise a deployment that didn't ask
// for it or lacks the binary. DECOUPLED from the LLM judge: with VERIFY_EXEC=on
// the render runs as a deterministic, fail-CLOSED gate (a web deliverable that
// demonstrably fails to load blocks the done-flip even when the judge is
// dormant or unreachable), and its observation also enriches the judge when
// VERIFY_GATE is on. A page that didn't load is not a matter of opinion.
function execGateEnabled(): boolean {
  return process.env.VERIFY_EXEC === "on";
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

// In-memory outage streak for the fail-open path — resets on any successful
// judge verdict. Process-local by design: the goal is a loud log signal, not
// durable accounting (the task_verifications table already records each error).
let consecutiveJudgeOutages = 0;
const JUDGE_OUTAGE_ALERT_AFTER = 3;

// Tier 1 — DETERMINISTIC, fail-CLOSED. Renders a web deliverable in headless
// Chromium and BLOCKS the done-flip on an unambiguous load failure (the page
// rendered blank, or threw resource/JS errors), independent of whether the LLM
// judge is configured. Ambiguous outcomes never block: a missing chromium
// binary, a non-web deliverable, a render timeout, or any error all return
// "not blocked" + a (possibly null) observation the caller threads into the
// judge so chromium runs at most once per flip. Returns the observation so the
// fail-open judge tier can reuse it without re-rendering.
export async function deterministicGateForDone(opts: {
  taskId: string;
  workspaceId: string;
  title: string;
  bodyMd: string;
  decidedBy: string | null;
}): Promise<{ blocked: boolean; obs: RenderObservation | null }> {
  if (!execGateEnabled()) return { blocked: false, obs: null };

  // Only attempt a render when the latest textual deliverable is web markup.
  const rows = await liveArtifactRows(opts.taskId).catch(() => []);
  rows.sort((a, b) => (b.createdAt?.getTime?.() ?? 0) - (a.createdAt?.getTime?.() ?? 0));
  const htmlEntry = rows.find((r) => /\.html?$/i.test(r.name || ""));
  if (!htmlEntry) return { blocked: false, obs: null };

  const obs = await renderWebDeliverable({ taskId: opts.taskId, entryName: htmlEntry.name }).catch(() => null);
  // Null = couldn't render (chromium absent / not web / error): ambiguous, never block.
  if (!obs) return { blocked: false, obs: null };

  const decision = classifyRenderForGate(obs);
  if (!decision.block) return { blocked: false, obs };
  await record(opts, "code", htmlEntry.id, "fail", 0, { render: obs }, decision.reason, "render");
  return { blocked: true, obs };
}

// Pure decision: should a render observation HARD-block the done-flip? Blocks
// only on unambiguous breakage — the page loaded but rendered blank, or threw
// resource/JS errors. A successful load (obs.ok) or a render TIMEOUT (a slow
// page is not proof of a broken deliverable) never blocks. Extracted for tests.
export function classifyRenderForGate(
  obs: RenderObservation,
): { block: false } | { block: true; reason: string } {
  if (obs.ok) return { block: false };
  if (/timed out/i.test(obs.note)) return { block: false };
  if (obs.consoleErrors.length > 0) {
    return {
      block: true,
      reason: `Deliverable failed to load: ${obs.consoleErrors.length} load/JS error(s) — ${obs.consoleErrors
        .slice(0, 3)
        .join(" | ")}`,
    };
  }
  return {
    block: true,
    reason: `Deliverable rendered blank in a real browser (${obs.renderedTextLen} visible chars). It is broken or empty, not done.`,
  };
}

// Tier 2 — LLM-as-judge. Returns null = pass/allow (let the done flip
// proceed); "verification_failed" = the judge rejected the deliverable;
// "judge_unavailable" = the judge could not be reached/parsed — the CALLER
// applies VERIFY_FAIL_MODE (see decideOnJudgeOutage), because only the
// done-flip path should hold/comment; the review-entry pre-check just ignores
// it. Only meant to be called once a candidate substantive artifact has been
// found by the heuristic gate and the deterministic tier has not already
// blocked. `preRendered` is the observation from the deterministic tier,
// reused so chromium runs only once.
export type VerifyOutcome = "verification_failed" | "judge_unavailable" | null;
export async function verifyTaskForDone(
  opts: {
    taskId: string;
    workspaceId: string;
    title: string;
    bodyMd: string;
    decidedBy: string | null;
  },
  preRendered?: RenderObservation | null,
): Promise<VerifyOutcome> {
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

  // Same deliverable, recent real verdict → reuse it instead of re-calling the
  // judge. The agent retrying the flip did not change the work product.
  const last = await latestVerificationRow(opts.taskId);
  if (shouldReuseVerdict(last, chosen.id)) {
    return last!.verdict === "pass" ? null : "verification_failed";
  }

  // EXECUTION CHECK: feed what ACTUALLY loaded to the judge so it scores an
  // observed final state, not source that merely looks complete. The render
  // already happened in the deterministic tier (deterministicGateForDone) and
  // is passed in as `preRendered` — we never re-render here. A null observation
  // (chromium absent, error, not web) just means the judge runs text-only.
  const obs: RenderObservation | null = preRendered ?? null;
  let renderBlock = "";
  if (obs) {
    renderBlock =
      `\n\nRENDER OBSERVATION (headless Chromium actually loaded this deliverable):\n` +
      `- loaded_ok: ${obs.ok}\n` +
      `- rendered_visible_text_chars: ${obs.renderedTextLen}\n` +
      `- console_errors: ${obs.consoleErrors.length ? obs.consoleErrors.slice(0, 5).join(" | ") : "none"}\n`;
  }

  const target = resolveJudgeTarget();
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
    { temperature: 0, maxTokens: 800, timeoutMs: judgeTimeoutMs(), target },
  );

  const method = obs ? "render" : taskType === "code" ? "test" : "rubric";
  const parsed = VerdictSchema.safeParse(raw);
  if (!parsed.success) {
    // A judge we can't reach/parse must not be SILENT — a broken judge once
    // went unnoticed for 11 days because every outage just recorded an error
    // row and allowed the flip. Log loudly (escalating once outages repeat)
    // and hand the decision to the caller via VERIFY_FAIL_MODE.
    consecutiveJudgeOutages++;
    const mode = resolveFailMode();
    const effect = mode === "open" ? "failing open" : mode === "hold" ? "holding in review" : "failing closed";
    const where = target ? `${target.baseUrl} model=${target.model}` : "no target";
    const msg = `[verifier] judge unreachable/unparseable for task ${opts.taskId} — ${effect} (VERIFY_FAIL_MODE=${mode}; ${consecutiveJudgeOutages} consecutive outage${consecutiveJudgeOutages === 1 ? "" : "s"}; ${where})`;
    if (consecutiveJudgeOutages >= JUDGE_OUTAGE_ALERT_AFTER && mode === "open") {
      console.error(`${msg}. The verification gate has been effectively OFF for the last ${consecutiveJudgeOutages} flips — check the judge gateway/model.`);
    } else if (consecutiveJudgeOutages >= JUDGE_OUTAGE_ALERT_AFTER) {
      console.error(`${msg}. Done-flips are being held/blocked until the judge recovers.`);
    } else {
      console.warn(msg);
    }
    await record(
      opts,
      taskType,
      chosen.id,
      "error",
      null,
      obs ? { render: obs, failMode: mode } : { failMode: mode },
      `judge unreachable or unparseable — ${effect} (VERIFY_FAIL_MODE=${mode})`,
      method,
    );
    return "judge_unavailable";
  }
  consecutiveJudgeOutages = 0;
  const v: Verdict = parsed.data;
  const pass = v.verdict === "pass" && v.not_fabricated && v.score >= passThreshold();
  await record(opts, taskType, chosen.id, pass ? "pass" : "fail", v.score, obs ? { ...v, render: obs } : v, v.rationale, method);
  return pass ? null : "verification_failed";
}

async function latestVerificationRow(
  taskId: string,
): Promise<{ artifactId: string | null; verdict: string; createdAt: Date } | null> {
  try {
    const [row] = await db
      .select({
        artifactId: taskVerifications.artifactId,
        verdict: taskVerifications.verdict,
        createdAt: taskVerifications.createdAt,
      })
      .from(taskVerifications)
      .where(eqTask(taskId))
      .orderBy(descCreated())
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

// The latest recorded verdict for a task, summarized for the reviewer's task
// context so they review WITH a pre-computed quality signal (pass/fail + score
// + rationale) instead of cold. Null when the verifier never ran (dormant, or
// no textual deliverable) — the reviewer then falls back to reading artifacts.
export async function latestVerdictSummary(
  taskId: string,
): Promise<{ verdict: string; score: number | null; rationale: string } | null> {
  const [row] = await db
    .select({
      verdict: taskVerifications.verdict,
      score: taskVerifications.score,
      rationale: taskVerifications.rationale,
    })
    .from(taskVerifications)
    .where(eqTask(taskId))
    .orderBy(descCreated())
    .limit(1);
  if (!row || row.verdict === "error") return null; // fail-open verdicts carry no signal
  return {
    verdict: row.verdict,
    score: row.score == null ? null : Number(row.score),
    rationale: row.rationale || "",
  };
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
