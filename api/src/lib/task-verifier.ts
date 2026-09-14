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
import { chatJsonOutcome, judgeConfigured, resolveJudgeTarget, type ChatMessage } from "./completion.js";
import { liveArtifactRows, isSubstantiveArtifact, isTextualContentType } from "./task-artifacts.js";
import {
  selectDeliverables,
  deliverableSetKey,
  looksLikePaperworkText,
  type DeliverableCandidate,
} from "./deliverable-select.js";
import { readObject } from "./storage.js";
import { coerceInt, envNum } from "./env.js";
import { renderWebDeliverable, type RenderObservation } from "./deliverable-render.js";
import { audit } from "./audit.js";
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
  return coerceInt(env.VERIFY_JUDGE_TIMEOUT_MS, 180_000, { min: 1 });
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
  return envNum("VERIFY_REJUDGE_MIN_MS", 10 * 60 * 1000, { min: 0 });
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
  // An EMPTY VERIFIER_PASS_THRESHOLD used to become a threshold of 0 — every
  // deliverable passing the judge. See lib/env.ts.
  return envNum("VERIFIER_PASS_THRESHOLD", 0.6, { min: 0, max: 1 });
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

  // Which web deliverable to render? The same ranking the judge uses, not
  // whatever was attached last — otherwise a wireframe or a stub version gets
  // rendered and a working dashboard is hard-blocked for "rendering blank".
  const rows = await liveArtifactRows(opts.taskId).catch(() => []);
  const html = rows.filter((r) => /\.html?$/i.test(r.name || ""));
  if (!html.length) return { blocked: false, obs: null };
  const htmlEntry =
    selectDeliverables(html as unknown as DeliverableCandidate[], opts.title, opts.bodyMd).primary ??
    (html[0] as unknown as DeliverableCandidate);
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

// ───────────────── judge plumbing (config, retry, budget) ─────────────────

// Announce WHICH endpoint and model the judge will call, once per process, at
// startup and again on the first judge error. On the live box every
// VERIFY_JUDGE_* var was empty, so the judge silently inherited PLANNER_BASE_URL
// with model "auto" — and nothing in the logs ever said so, which is how 541
// "judge unreachable" rows accumulated without anyone being able to see what
// was being called. Never logs the API key, only whether one is present.
let loggedJudgeConfig = false;
export function logJudgeConfigOnce(force = false): void {
  if (loggedJudgeConfig && !force) return;
  loggedJudgeConfig = true;
  if (process.env.VERIFY_GATE !== "on") {
    console.log("[verifier] VERIFY_GATE is not 'on' — the verification judge is OFF.");
    return;
  }
  const t = resolveJudgeTarget();
  if (!t) {
    console.error(
      "[verifier] VERIFY_GATE=on but NO judge endpoint resolves. Set VERIFY_JUDGE_BASE_URL (or PLANNER_BASE_URL). The gate is OFF.",
    );
    return;
  }
  const explicit = !!(process.env.VERIFY_JUDGE_BASE_URL || "").trim();
  const pinned = !!(process.env.VERIFY_JUDGE_MODEL || process.env.PLANNER_MODEL || "").trim();
  console.log(
    `[verifier] judge → ${t.baseUrl} model=${t.model}` +
      ` (base ${explicit ? "VERIFY_JUDGE_BASE_URL" : "inherited from PLANNER_BASE_URL"};` +
      ` model ${pinned ? "pinned" : "DEFAULTED to \"auto\" — pin VERIFY_JUDGE_MODEL for a consistent judge"};` +
      ` api key ${t.apiKey ? "present" : "ABSENT"};` +
      ` max_tokens=${judgeMaxTokens()}; timeout=${judgeTimeoutMs()}ms;` +
      ` fail_mode=${resolveFailMode()}; rejudge_min=${rejudgeMinMs()}ms; max_judges_per_set=${maxJudgesPerSet()})`,
  );
}

// Token budget for one verdict. The default was 800, which is fine for a plain
// chat model and useless for a reasoning one: probing the live gateway showed
// gemini-2.5-flash and the `auto` route both emit their chain of thought first
// and hit finish_reason:"length" BEFORE the JSON verdict — 0 of 15 probe calls
// produced parseable JSON at 800 tokens. Raise it. Override with
// VERIFY_JUDGE_MAX_TOKENS.
export function judgeMaxTokens(env: Record<string, string | undefined> = process.env): number {
  return coerceInt(env.VERIFY_JUDGE_MAX_TOKENS, 3000, { min: 1 });
}

// Reasoning effort asked of the judge. The verdict is a short rubric call — it
// does not need extended thinking, and on this fleet's gateway mandatory
// reasoning is exactly what eats the token budget. "minimal" by default; set
// VERIFY_JUDGE_REASONING_EFFORT="" to send no reasoning parameter at all.
export function judgeReasoningEffort(env: Record<string, string | undefined> = process.env): string {
  const raw = env.VERIFY_JUDGE_REASONING_EFFORT;
  return raw === undefined ? "minimal" : raw.trim();
}

// How many times one UNCHANGED artifact set may be judged before the verifier
// stops calling out. Guards the re-judge loop (125 verdicts on one live task).
export function maxJudgesPerSet(env: Record<string, string | undefined> = process.env): number {
  return coerceInt(env.VERIFY_MAX_JUDGES_PER_SET, 3, { min: 1 });
}

// Pure: given what we already know about this artifact set, should the judge
// be called again — and if not, what does the caller get? Exported for tests.
//   • under the cap                 → call the judge
//   • capped with a real verdict    → answer from it (no new row, no new comment)
//   • capped with only outages      → treat as an outage and let VERIFY_FAIL_MODE
//                                     decide; the hold comment is deduped by the
//                                     caller, so the card keeps ONE comment.
// The `total` fed in EXCLUDES transport failures (see tallyVerdictRows): a
// rate-limited gateway must never eat the three judge slots an unchanged
// deliverable gets, or the first quota outage permanently retires the gate for
// that card.
export function decideOnRejudgeCap(
  prior: { total: number; lastVerdict: "pass" | "fail" | "error" | null },
  cap: number = maxJudgesPerSet(),
): { judge: true } | { judge: false; outcome: VerifyOutcome } {
  if (prior.total < cap) return { judge: true };
  if (prior.lastVerdict === "pass") return { judge: false, outcome: null };
  if (prior.lastVerdict === "fail") return { judge: false, outcome: "verification_failed" };
  return { judge: false, outcome: "judge_unavailable" };
}

// What one judge call produced. A TRANSPORT failure (429 / 5xx / timeout /
// network) is kept apart from "the judge answered something unusable": only
// the latter is evidence about this deliverable, so only the latter is worth
// recording as an `error` verdict and spending a re-judge slot on.
export type JudgeCallResult =
  | { kind: "ok"; raw: unknown }
  | { kind: "transport"; status: number; retryAfterMs: number | null }
  | { kind: "invalid" };

// Retry loop for UNUSABLE replies. The transport layer (lib/completion.ts)
// already does its own bounded retry on 429/5xx/timeouts, so a transport
// failure here returns immediately — retrying a rate-limited router three more
// times only deepens the outage. Each failed attempt names the endpoint and
// model so the log says what was called.
const JUDGE_ATTEMPTS = 3;
const JUDGE_BACKOFF_MS = [0, 1_500, 6_000];
export async function judgeWithRetry(
  messages: ChatMessage[],
  target: ReturnType<typeof resolveJudgeTarget>,
): Promise<JudgeCallResult> {
  const effort = judgeReasoningEffort();
  for (let attempt = 0; attempt < JUDGE_ATTEMPTS; attempt++) {
    if (JUDGE_BACKOFF_MS[attempt]) await sleep(JUDGE_BACKOFF_MS[attempt]);
    const outcome = await chatJsonOutcome<unknown>(messages, {
      temperature: 0,
      maxTokens: judgeMaxTokens(),
      timeoutMs: judgeTimeoutMs(),
      target,
      ...(effort ? { reasoningEffort: effort } : {}),
    });
    if (outcome.kind === "ok" && outcome.value !== null && outcome.value !== undefined) {
      return { kind: "ok", raw: outcome.value };
    }
    const where = target ? `${target.baseUrl} model=${target.model}` : "no target";
    if (outcome.kind === "transport") {
      console.warn(
        `[verifier] transport failure (${outcome.status}) calling the judge (${where}) — not retrying here, ` +
          `no verdict recorded and no re-judge slot consumed`,
      );
      return { kind: "transport", status: outcome.status, retryAfterMs: outcome.retryAfterMs };
    }
    console.warn(
      `[verifier] judge call attempt ${attempt + 1}/${JUDGE_ATTEMPTS} returned nothing (${where}, max_tokens=${judgeMaxTokens()})` +
        (attempt + 1 < JUDGE_ATTEMPTS ? ` — retrying in ${JUDGE_BACKOFF_MS[attempt + 1]}ms` : ""),
    );
  }
  logJudgeConfigOnce(true);
  return { kind: "invalid" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// How many verdicts already exist for this exact artifact set, and what the
// last real one said. Only the recent tail is scanned — a task with hundreds of
// rows (the bug this guards) still costs one bounded query.
const SET_HISTORY_SCAN = 40;
export interface VerdictRow {
  verdict: string;
  rubricJson: unknown;
}

// Pure tally over the recent verdict rows, newest first. Exported for tests.
//
// Rows flagged `transport` in their rubric are SKIPPED entirely: they record
// that the gateway was unreachable, which says nothing about the deliverable.
// Counting them was how a rate-limited router could retire the verification
// gate for a card — three 429s and `decideOnRejudgeCap` never calls the judge
// for that artifact set again.
export function tallyVerdictRows(
  rows: readonly VerdictRow[],
  setKey: string,
): { total: number; lastVerdict: "pass" | "fail" | "error" | null } {
  let total = 0;
  let real: "pass" | "fail" | null = null;
  let sawError = false;
  for (const r of rows) {
    // Rows are newest-first, so the first pass/fail we meet is the most
    // recent REAL verdict. A real verdict beats a newer judge error:
    // "the judge already said fail" is more useful to the caller than "the
    // last attempt came back unparseable".
    const rubric = r.rubricJson as { setKey?: unknown; transport?: unknown } | null;
    if (rubric?.setKey !== setKey) continue;
    if (rubric?.transport) continue;
    total++;
    if (!real && (r.verdict === "pass" || r.verdict === "fail")) real = r.verdict;
    if (r.verdict === "error") sawError = true;
  }
  return { total, lastVerdict: real ?? (sawError ? "error" : null) };
}

export async function countVerdictsForSet(
  taskId: string,
  setKey: string,
): Promise<{ total: number; lastVerdict: "pass" | "fail" | "error" | null }> {
  try {
    const rows = await db
      .select({ verdict: taskVerifications.verdict, rubricJson: taskVerifications.rubricJson })
      .from(taskVerifications)
      .where(eqTask(taskId))
      .orderBy(descCreated())
      .limit(SET_HISTORY_SCAN);
    return tallyVerdictRows(rows, setKey);
  } catch {
    return { total: 0, lastVerdict: null };
  }
}

// The DELIVERABLE block of the judge prompt. Shows every selected artifact with
// its name and size so the model can tell the work product from the supporting
// files, and splits the character budget across them (the primary — the
// highest-ranked artifact — always gets the largest share).
export const PAPERWORK_PROMPT_LINE =
  "These are the agent's own reports about the work; they are not evidence. Judge only the deliverables.";

// The block that NAMES the excluded paperwork without showing a byte of it.
// Listing it matters: the judge should know four verification write-ups were
// attached (and that they prove nothing) rather than wonder what it is missing.
export function renderPaperworkNotice(names: readonly string[]): string {
  if (!names.length) return "";
  return (
    `\nNOT EVIDENCE — the agent's own paperwork about this task, excluded from the deliverables above ` +
    `(${names.length} file${names.length === 1 ? "" : "s"}): ${names.join(", ")}\n` +
    `${PAPERWORK_PROMPT_LINE}\n`
  );
}

export function renderDeliverableSet(
  items: ReadonlyArray<{ row: { name: string; contentType: string; size: number }; text: string }>,
  paperworkNames: readonly string[] = [],
): string {
  if (!items.length) return `DELIVERABLES: (none)\n${renderPaperworkNotice(paperworkNames)}`;
  const budgets = splitBudget(MAX_DELIVERABLE_CHARS, items.length);
  const header =
    items.length === 1
      ? "DELIVERABLE"
      : `DELIVERABLE SET (${items.length} files; the FIRST is the primary work product, the rest are supporting)`;
  const blocks = items.map((it, i) => {
    const body = it.text.slice(0, budgets[i]);
    const truncated = it.text.length > budgets[i] ? `\n…[truncated, full file is ${it.row.size} bytes]` : "";
    return `--- FILE ${i + 1}: ${it.row.name} (${it.row.contentType}, ${it.row.size} bytes) ---\n${body}${truncated}`;
  });
  return `${header}:\n${blocks.join("\n\n")}\n${renderPaperworkNotice(paperworkNames)}`;
}

// Primary gets half the budget, the rest share the remainder evenly.
function splitBudget(total: number, n: number): number[] {
  if (n === 1) return [total];
  const primary = Math.floor(total * 0.5);
  const each = Math.floor((total - primary) / (n - 1));
  return [primary, ...Array(n - 1).fill(each)];
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

  // WHICH artifacts are the deliverable? Not "the newest one" — agents ship
  // the real work first and then attach their own paperwork (a verification
  // report, an audit log, a UX-research write-up), and the old newest-first
  // scan judged the paperwork. See deliverable-select.ts for the ranking.
  const rows = await liveArtifactRows(opts.taskId);
  const textual: TaskArtifact[] = [];
  for (const r of rows) {
    // Only judge TEXTUAL deliverables — utf8-decoding a PDF/image/zip yields
    // garbage the judge would wrongly fail. Binary deliverables that clear the
    // substance heuristic are allowed through (the heuristic stands alone).
    if (!isTextualContentType(r.contentType)) continue;
    if (!(await isSubstantiveArtifact(r, opts.title))) continue;
    textual.push(r);
  }
  const selection = selectDeliverables(textual as unknown as DeliverableCandidate[], opts.title, opts.bodyMd);
  if (!selection.primary) return null; // nothing readable to judge → defer to the heuristic outcome

  // Read the chosen set. A blob that has vanished from storage is dropped
  // rather than judged as an empty file.
  const fetched: Array<{ row: TaskArtifact; text: string }> = [];
  for (const cand of selection.set) {
    const row = textual.find((r) => r.id === cand.id);
    if (!row) continue;
    const buf = await readObject(row.storageKey);
    if (!buf) continue;
    fetched.push({ row, text: buf.toString("utf8") });
  }
  if (!fetched.length) return null;

  // SECOND paperwork pass, on the CONTENT this time. A name-based filter only
  // catches paperwork that is named like paperwork; a file called
  // `endpoints-2026-09-13.md` that is 40 lines of "200 OK" and "hash MATCH" is
  // still the agent marking its own homework. Drop those too — but only while
  // something that is NOT paperwork survives, so a doc-only task still gets
  // judged on the doc it shipped.
  const paperworkNames = selection.paperwork.map((r) => r.name);
  const byContent = fetched.filter((f) => looksLikePaperworkText(f.text));
  const realWork = fetched.filter((f) => !byContent.includes(f));
  const readable = realWork.length ? realWork : fetched;
  if (realWork.length) for (const f of byContent) paperworkNames.push(f.row.name);
  const chosen = readable[0].row;
  const judgedSet = readable.map((r) => r.row);
  const setKey = deliverableSetKey(judgedSet as unknown as DeliverableCandidate[]);
  // Recorded on every verdict row: WHICH files were judged (so a human reading
  // task_verifications can see the judge looked at dashboard.html and not at
  // dashboard-ux-research.md) and the set identity the re-judge cap keys on.
  const setRubric = {
    setKey,
    judged: judgedSet.map((r) => ({ id: r.id, name: r.name, version: r.version, size: r.size })),
    demoted: selection.ranked
      .filter((c) => !judgedSet.some((j) => j.id === c.row.id))
      .map((c) => ({ name: c.row.name, score: Number(c.score.toFixed(2)), why: c.reasons.join("; ") })),
    // The agent's own reports, named for the judge but never read to it.
    paperwork: paperworkNames,
  };

  const taskType = inferType(chosen.name, chosen.contentType);

  // Same deliverable, recent real verdict → reuse it instead of re-calling the
  // judge. The agent retrying the flip did not change the work product.
  const last = await latestVerificationRow(opts.taskId);
  if (shouldReuseVerdict(last, chosen.id)) {
    return last!.verdict === "pass" ? null : "verification_failed";
  }

  // RE-JUDGE CAP. The window above only reuses a recent PASS/FAIL, and an
  // `error` row is deliberately never reused — so while the judge gateway was
  // down, every heartbeat re-called it: one live task accumulated 125
  // verification rows, another 4 in three minutes. Once an unchanged artifact
  // SET has been judged VERIFY_MAX_JUDGES_PER_SET times, stop calling the judge
  // and answer from what we already know. Nothing new is recorded, so the card
  // keeps the single comment it already has instead of collecting another.
  const priorForSet = await countVerdictsForSet(opts.taskId, setKey);
  const capDecision = decideOnRejudgeCap(priorForSet);
  if (!capDecision.judge) {
    console.warn(
      `[verifier] re-judge cap hit for task ${opts.taskId}: this artifact set has already been judged ` +
        `${priorForSet.total} time(s) (last=${priorForSet.lastVerdict ?? "none"}). Not calling the judge again until the deliverables change.`,
    );
    return capDecision.outcome;
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
  const judged = await judgeWithRetry(
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
          "You may be shown SEVERAL files. Judge the deliverable SET as a whole against the brief: " +
          "PASS if the set together satisfies the acceptance criteria. Supporting material " +
          "(notes, a verification write-up, a manifest) alongside the real work product is normal " +
          "and is NOT a reason to fail — judge the work product, not the paperwork about it. " +
          "Files listed under NOT EVIDENCE are the agent's OWN reports about this task and have been " +
          "withheld on purpose: never treat an agent's claim that it verified, tested, deployed or " +
          "hash-checked something as proof that it happened. " +
          'Return ONLY a JSON object: {"meets_acceptance_criteria":0..1,' +
          '"artifact_present_substantive":true|false,"not_fabricated":true|false,' +
          '"verdict":"pass"|"fail","score":0..1,"rationale":"one short paragraph"}',
      },
      {
        role: "user",
        content:
          `TASK TITLE: ${opts.title}\n` +
          `ACCEPTANCE CRITERIA / DESCRIPTION:\n${opts.bodyMd || "(none stated — judge against the title)"}\n\n` +
          renderDeliverableSet(readable, paperworkNames) +
          renderBlock,
      },
    ],
    target,
  );

  const method = obs ? "render" : taskType === "code" ? "test" : "rubric";

  // TRANSPORT failure: the judge never saw the deliverable. Record NOTHING —
  // no verdict row, so `countVerdictsForSet` is unmoved and the next flip still
  // gets a real judge call once the router recovers — and let VERIFY_FAIL_MODE
  // decide this one flip exactly as it would for any other outage.
  if (judged.kind === "transport") {
    consecutiveJudgeOutages++;
    const mode = resolveFailMode();
    const effect = mode === "open" ? "failing open" : mode === "hold" ? "holding in review" : "failing closed";
    const where = target ? `${target.baseUrl} model=${target.model}` : "no target";
    const wait = judged.retryAfterMs == null ? "" : `, retry after ~${Math.round(judged.retryAfterMs / 1000)}s`;
    console.warn(
      `[verifier] transport failure (${judged.status}) for task ${opts.taskId} — ${effect} ` +
        `(VERIFY_FAIL_MODE=${mode}; ${where}${wait}). No verdict recorded and no re-judge attempt consumed; ` +
        `the judge runs again on the next flip.`,
    );
    return "judge_unavailable";
  }

  const raw = judged.kind === "ok" ? judged.raw : null;
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
      { ...setRubric, failMode: mode, ...(obs ? { render: obs } : {}) },
      `judge unreachable or unparseable — ${effect} (VERIFY_FAIL_MODE=${mode})`,
      method,
    );
    return "judge_unavailable";
  }
  consecutiveJudgeOutages = 0;
  const v: Verdict = parsed.data;
  const pass = v.verdict === "pass" && v.not_fabricated && v.score >= passThreshold();
  await record(
    opts,
    taskType,
    chosen.id,
    pass ? "pass" : "fail",
    v.score,
    { ...v, ...setRubric, ...(obs ? { render: obs } : {}) },
    v.rationale,
    method,
  );
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
  const verificationId = id("tver");
  await db
    .insert(taskVerifications)
    .values({
      id: verificationId,
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
  // Governance trail: every verdict is a gate decision on someone's work.
  void audit({
    workspaceId: opts.workspaceId,
    actorId: opts.decidedBy ?? "system",
    actorType: opts.decidedBy ? "user" : "system",
    action: "verification.verdict",
    targetType: "task",
    targetId: opts.taskId,
    meta: {
      verificationId,
      verdict,
      score,
      method,
      taskType,
      artifactId,
      artifactName: (rubric as { judged?: Array<{ name?: string }> }).judged?.[0]?.name ?? null,
      rationale,
    },
  });
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
