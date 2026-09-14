// OpenAI-compatible chat-completions client, configured entirely via env so it
// can point at any /v1/chat/completions backend (the FreeLLMAPI gateway,
// OpenAI, a local model). Used server-side by the goal planner to decompose a
// goal into a task graph and by the verification judge — the API doing the
// reasoning directly rather than routing through an agent runtime.
//
// Two targets resolve from env:
//
//   PLANNER (goal/mission planner):
//     PLANNER_BASE_URL   e.g. http://127.0.0.1:3001/v1  (the /v1 root)
//                        LEGACY fallback: EMBEDDINGS_BASE_URL (same gateway).
//                        The fallback is kept so existing deployments keep
//                        planning, but it is logged once — an embeddings
//                        endpoint is not guaranteed to serve chat.
//     PLANNER_API_KEY    bearer token; falls back to EMBEDDINGS_API_KEY
//     PLANNER_MODEL      model name; default "auto" (FreeLLMAPI picks the chain)
//
//   JUDGE (verification gate, see task-verifier.ts):
//     VERIFY_JUDGE_BASE_URL  falls back to PLANNER_BASE_URL — NEVER to
//                            EMBEDDINGS_BASE_URL. A judge that silently talks
//                            to an embeddings-only deployment produced weeks
//                            of "unreachable — failing open" rows; the judge
//                            must be pointed at a chat-capable URL explicitly.
//     VERIFY_JUDGE_API_KEY   falls back to PLANNER_API_KEY, then EMBEDDINGS_API_KEY
//     VERIFY_JUDGE_MODEL     falls back to PLANNER_MODEL, then "auto"
//
// Fully dormant unless a base URL resolves, so callers degrade to a clear
// "unconfigured" state rather than throwing.
//
// Callers get a TYPED outcome (see ChatOutcome below), because "the gateway is
// rate-limited" and "the model answered nonsense" need opposite responses: the
// first is retried later for free, the second is the prompt's own failure and
// costs a plan attempt / a judge slot / a proposal. Use chatOutcome() and
// chatJsonOutcome(); chat() and chatJson() are null-returning wrappers kept for
// callers that genuinely cannot act on the difference.

export interface ChatTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
}

type EnvLike = Record<string, string | undefined>;

const trimUrl = (u: string | undefined): string => (u || "").replace(/\/+$/, "");

// Planner target. Pure (takes env) so it can be unit-tested.
export function resolvePlannerTarget(env: EnvLike = process.env): ChatTarget | null {
  const baseUrl = trimUrl(env.PLANNER_BASE_URL) || trimUrl(env.EMBEDDINGS_BASE_URL);
  if (!baseUrl) return null;
  return {
    baseUrl,
    apiKey: env.PLANNER_API_KEY || env.EMBEDDINGS_API_KEY || "",
    model: env.PLANNER_MODEL || "auto",
  };
}

// True when the planner is only reachable via the legacy embeddings fallback.
export function plannerUsesEmbeddingsFallback(env: EnvLike = process.env): boolean {
  return !trimUrl(env.PLANNER_BASE_URL) && !!trimUrl(env.EMBEDDINGS_BASE_URL);
}

// Judge target. Requires an EXPLICIT chat URL (VERIFY_JUDGE_BASE_URL or
// PLANNER_BASE_URL); an embeddings-only configuration yields null.
export function resolveJudgeTarget(env: EnvLike = process.env): ChatTarget | null {
  const baseUrl = trimUrl(env.VERIFY_JUDGE_BASE_URL) || trimUrl(env.PLANNER_BASE_URL);
  if (!baseUrl) return null;
  return {
    baseUrl,
    apiKey: env.VERIFY_JUDGE_API_KEY || env.PLANNER_API_KEY || env.EMBEDDINGS_API_KEY || "",
    model: env.VERIFY_JUDGE_MODEL || env.PLANNER_MODEL || "auto",
  };
}

let warnedFallback = false;
export function plannerEnabled(): boolean {
  const t = resolvePlannerTarget();
  if (t && !warnedFallback && plannerUsesEmbeddingsFallback()) {
    warnedFallback = true;
    console.warn(
      `[completion] PLANNER_BASE_URL is not set — the planner is using EMBEDDINGS_BASE_URL (${t.baseUrl}) for chat/completions with model=${t.model}. ` +
        `Set PLANNER_BASE_URL (+ PLANNER_MODEL, PLANNER_API_KEY) explicitly to a chat-capable endpoint.`,
    );
  }
  return !!t;
}

export function judgeConfigured(): boolean {
  return !!resolveJudgeTarget();
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOpts {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  // Which endpoint/model to call. Defaults to the planner target.
  target?: ChatTarget | null;
  // Let a PINNED model that answered UNUSABLY (a malformed reply, a 4xx that
  // isn't a rate limit) be retried on the gateway's `auto` chain. OFF by
  // default and never set by a JSON/schema-constrained caller: the `auto`
  // route on this fleet's gateway answers `["deployment","publishing"]` to a
  // task-plan prompt, and structured callers then treat that garbage as a
  // genuine model answer. Free-text callers (the task condenser, the memory
  // janitor) can opt in — a drifting summary beats no summary. A TRANSPORT
  // failure NEVER falls back, opt-in or not: the whole gateway is rate-limited,
  // so `auto` is either exhausted too or is the worst model still standing.
  allowModelFallback?: boolean;
  // Ask a reasoning-capable model to think as little as possible. Probing the
  // live FreeLLMAPI gateway showed reasoning models emitting their whole chain
  // of thought and hitting finish_reason:"length" BEFORE the answer — the
  // caller gets a 200 with unusable content. Sent as BOTH spellings the
  // OpenAI-compatible ecosystem uses (`reasoning_effort` and `reasoning.effort`);
  // a gateway that rejects them with a 400 is retried once without them, so an
  // endpoint that has never heard of reasoning params still works.
  reasoningEffort?: string;
}

// ───────────────────────── typed call outcomes ─────────────────────────
//
// Every caller used to get `null` for four very different things: the client
// is unconfigured, the gateway is rate-limited/down, the model answered with
// something unusable, or the reply held no JSON. The goal planner counted all
// four as a failed plan attempt, so one hour of exhausted free-tier quota
// (`http_429 "All models exhausted: 3 routes checked … Soonest reset ~57m"`)
// burned GOAL_MAX_PLAN_ATTEMPTS on every open goal and abandoned them
// permanently. A TRANSPORT failure is the gateway's problem, not the prompt's:
// it is reported as its own kind so callers can retry later instead of
// spending an attempt, a judge slot, or a proposal on it.

/** The pinned model never produced an answer, and the fault is the transport. */
export interface ChatTransportFailure {
  kind: "transport";
  /** HTTP status, or 0 for a network error and 408 for our own timeout. */
  status: number;
  /** From `Retry-After` when the gateway sent one, else null. */
  retryAfterMs: number | null;
  /** Short, truncated router detail for logs. */
  detail: string;
}

export type ChatFailure =
  | { kind: "unconfigured" }
  | ChatTransportFailure
  /** The model was REACHED and its answer was unusable (bad shape, no JSON, a
   *  non-retryable 4xx). This is a real, attempt-consuming outcome. */
  | { kind: "invalid"; detail: string };

export type ChatOutcome<T> = { kind: "ok"; value: T } | ChatFailure;

export function isTransportFailure(o: { kind: string }): o is ChatTransportFailure {
  return o.kind === "transport";
}

// Which HTTP statuses mean "the gateway, not the prompt": rate limits, request
// timeouts, and every server-side error. A 400/401/403/404/422 is a request or
// credential problem that retrying identically will never fix.
export function isTransportStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
}

// `Retry-After` is either delta-seconds or an HTTP-date. Returns ms, or null
// when the header is absent/unparseable. Never negative.
export function parseRetryAfter(raw: string | null | undefined, now: number = Date.now()): number | null {
  const v = (raw || "").trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

// The gateway's own words about why it said 429, collapsed to one line. The
// FreeLLMAPI router explains itself in the body ("3 routes checked (3
// rate-limited or on cooldown)… Soonest reset ~57m") and that sentence is the
// difference between "wait an hour" and "something is misconfigured".
export function summariseRouterBody(body: string, max = 240): string {
  const flat = (body || "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// Diagnostics for the failure paths. Every consumer of this client fails soft
// (planner errors out, verifier fails open/holds), so without a log line here
// a dead gateway is invisible. Throttled per (target, reason) so a
// rate-limited gateway doesn't flood the log on every retry.
const lastDiag = new Map<string, number>();
const DIAG_THROTTLE_MS = 60_000;
export function noteChatFailure(target: ChatTarget, reason: string, detail = ""): void {
  const key = `${target.baseUrl}|${target.model}|${reason}`;
  const now = Date.now();
  const last = lastDiag.get(key) ?? 0;
  if (now - last < DIAG_THROTTLE_MS) return;
  lastDiag.set(key, now);
  console.warn(
    `[completion] chat/completions failed: ${reason} (${target.baseUrl} model=${target.model})${detail ? ` — ${detail.slice(0, 300)}` : ""}`,
  );
}

// ONE line per model per minute describing the router's state when it rate-
// limits us: which model was asked, how long it wants us to wait, and the
// router's own explanation. Separate from noteChatFailure so the 429 story
// (the only failure an operator can act on by waiting) reads in one line.
const lastRateLimitLog = new Map<string, number>();
export const RATE_LIMIT_LOG_THROTTLE_MS = 60_000;
export function noteRouterRateLimit(
  target: ChatTarget,
  status: number,
  retryAfterMs: number | null,
  body: string,
  now: number = Date.now(),
): boolean {
  const key = `${target.baseUrl}|${target.model}`;
  const last = lastRateLimitLog.get(key) ?? 0;
  if (now - last < RATE_LIMIT_LOG_THROTTLE_MS) return false;
  lastRateLimitLog.set(key, now);
  const wait = retryAfterMs == null ? "not stated" : `${Math.round(retryAfterMs / 1000)}s`;
  console.warn(
    `[completion] router rate-limited (${status}) model=${target.model} at ${target.baseUrl} — retry_after=${wait}; router says: ${summariseRouterBody(body) || "(no body)"}`,
  );
  return true;
}

// In-call retry budget for transport failures. Deliberately SHORT: the callers
// are sweeps that come back in minutes, so this only rides out a blip. A
// `Retry-After` longer than what is left of the budget is honoured by giving
// up NOW and telling the caller how long to wait — never by sleeping an hour
// inside a worker job.
const RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1_000, 4_000];
const RETRY_BUDGET_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Call chat/completions and return the assistant's raw text, or null on any
// failure. Kept for callers that genuinely cannot act on the difference;
// prefer chatOutcome()/chatJsonOutcome() where a transport failure must not be
// mistaken for a bad answer.
export async function chat(messages: ChatMessage[], opts: ChatOpts = {}): Promise<string | null> {
  const r = await chatOutcome(messages, opts);
  return r.kind === "ok" ? r.value : null;
}

// Call chat/completions with the typed outcome. A PINNED model that fails on
// TRANSPORT is reported as such — it is NOT retried on "auto", which is how
// `["deployment","publishing"]` ended up in a goal's task plan. A pinned model
// that answers unusably may still be retried on "auto", but only when the
// caller opts in with allowModelFallback (free-text callers only).
export async function chatOutcome(messages: ChatMessage[], opts: ChatOpts = {}): Promise<ChatOutcome<string>> {
  const target = opts.target === undefined ? resolvePlannerTarget() : opts.target;
  if (!target) return { kind: "unconfigured" };
  const first = await callWithRetries(target, target.model, messages, opts);
  if (first.kind === "ok" || target.model === "auto") return first;
  if (first.kind === "transport") return first;
  if (!opts.allowModelFallback) return first;
  console.warn(
    `[completion] pinned model ${target.model} answered unusably (${first.kind === "invalid" ? first.detail.slice(0, 120) : first.kind}) — retrying with model=auto`,
  );
  return callWithRetries(target, "auto", messages, opts);
}

// Three attempts against ONE model, retrying transport failures only, inside a
// bounded wall-clock budget.
async function callWithRetries(
  target: ChatTarget,
  modelName: string,
  messages: ChatMessage[],
  opts: ChatOpts,
): Promise<ChatOutcome<string>> {
  let budgetMs = RETRY_BUDGET_MS;
  let last: ChatOutcome<string> = { kind: "invalid", detail: "no attempt made" };
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    last = await chatWithModel(target, modelName, messages, opts);
    if (last.kind !== "transport") return last;
    if (attempt === RETRY_ATTEMPTS - 1) break;
    const wait = last.retryAfterMs ?? RETRY_BACKOFF_MS[attempt];
    // The gateway asked for longer than we are willing to hold a worker job:
    // stop and let the caller's next sweep pick it up.
    if (wait > budgetMs) break;
    budgetMs -= wait;
    if (wait > 0) await sleep(wait);
  }
  return last;
}

async function chatWithModel(
  target: ChatTarget,
  modelName: string,
  messages: ChatMessage[],
  opts: ChatOpts = {},
  withReasoningParam = true,
): Promise<ChatOutcome<string>> {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const t = setTimeout(() => controller.abort(), timeoutMs);
  const at = { ...target, model: modelName };
  const reasoning =
    withReasoningParam && opts.reasoningEffort
      ? { reasoning_effort: opts.reasoningEffort, reasoning: { effort: opts.reasoningEffort } }
      : {};
  try {
    const res = await fetch(`${target.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: modelName,
        messages,
        temperature: opts.temperature ?? 0.2,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        ...reasoning,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // A 400 while we are sending reasoning params is most likely the gateway
      // rejecting a param it doesn't know. Drop them and try once more before
      // reporting the endpoint as broken.
      if (res.status === 400 && withReasoningParam && opts.reasoningEffort) {
        clearTimeout(t);
        console.warn(
          `[completion] ${target.baseUrl} rejected the reasoning parameter (400) — retrying without it (model=${modelName}).`,
        );
        return chatWithModel(target, modelName, messages, opts, false);
      }
      if (isTransportStatus(res.status)) {
        const retryAfterMs = parseRetryAfter(res.headers?.get?.("retry-after"));
        if (res.status === 429) noteRouterRateLimit(at, res.status, retryAfterMs, body);
        else noteChatFailure(at, `http_${res.status}`, body);
        return { kind: "transport", status: res.status, retryAfterMs, detail: summariseRouterBody(body) };
      }
      noteChatFailure(at, `http_${res.status}`, body);
      return { kind: "invalid", detail: `http_${res.status}: ${summariseRouterBody(body, 120)}` };
    }
    const json = (await res.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: unknown;
    } | null;
    const text = json?.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      const detail = JSON.stringify(json?.error ?? json ?? {}).slice(0, 200);
      noteChatFailure(at, "bad_shape", detail);
      return { kind: "invalid", detail: `bad_shape: ${detail}` };
    }
    return { kind: "ok", value: text };
  } catch (e) {
    const aborted = (e as Error)?.name === "AbortError";
    const msg = (e as Error)?.message ?? "";
    noteChatFailure(at, aborted ? `timeout_${timeoutMs}ms` : "network", aborted ? "" : msg);
    return {
      kind: "transport",
      status: aborted ? 408 : 0,
      retryAfterMs: null,
      detail: aborted ? `timeout after ${timeoutMs}ms` : `network: ${msg.slice(0, 200)}`,
    };
  } finally {
    clearTimeout(t);
  }
}

// Every balanced top-level {...} / [...] span in the text, string-aware so
// braces inside JSON strings don't break the scan.
function scanJsonCandidates(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const open = text[i];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (esc) {
        esc = false;
        continue;
      }
      if (inStr) {
        if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          out.push(text.slice(i, j + 1));
          i = j; // resume after this candidate
          break;
        }
      }
    }
  }
  return out;
}

// Pull a JSON object/array out of a model response. Tolerates ```json fences,
// leading/trailing prose, AND reasoning-style replies that quote example JSON
// in their analysis before emitting the real answer — the old first-brace/
// last-closer slice broke on those (it spanned the prose in between). We scan
// every balanced candidate and return the LAST one that parses: models put
// the final answer at the end. Returns null if nothing parses.
export function extractJson<T = unknown>(text: string | null): T | null {
  if (!text) return null;
  // Prefer the contents of a ```json … ``` (or bare ```) fence if present —
  // a fence is an explicit "here is the answer" marker.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim()) as T;
    } catch {
      /* fall through to the scanner */
    }
  }
  const candidates = scanJsonCandidates(text);
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(candidates[i]) as T;
    } catch {
      /* try the next-earlier candidate */
    }
  }
  return null;
}

// Convenience: chatOutcome() then extractJson(), with the typed outcome kept
// intact. Retries once with a terser nudge if the first reply doesn't parse —
// small models sometimes need a second push. A TRANSPORT failure is NOT
// nudged: the nudge fixes formatting, not a rate-limited gateway, and doubling
// calls against an exhausted router only deepens the outage.
//
// JSON callers NEVER fall back to model=auto (allowModelFallback is forced
// off): a schema-constrained prompt answered by whatever free model the router
// has left produces JSON-shaped garbage that parses, passes as a genuine model
// answer, and consumes a plan/judge attempt.
export async function chatJsonOutcome<T = unknown>(
  messages: ChatMessage[],
  opts: ChatOpts = {},
): Promise<ChatOutcome<T>> {
  const jsonOpts: ChatOpts = { ...opts, allowModelFallback: false };
  const first = await chatOutcome(messages, jsonOpts);
  if (first.kind !== "ok") return first;
  const parsed = extractJson<T>(first.value);
  if (parsed !== null) return { kind: "ok", value: parsed };
  const retry = await chatOutcome(
    [
      ...messages,
      {
        role: "user",
        content:
          "Return ONLY the final JSON object, starting with { and ending with } — no reasoning, no analysis, no prose, no code fence.",
      },
    ],
    jsonOpts,
  );
  if (retry.kind !== "ok") {
    // The model DID answer the first time; its answer just held no JSON. That
    // is a real (attempt-consuming) outcome even if the nudge then hit the
    // rate limit — don't launder a bad answer into a transport failure.
    return { kind: "invalid", detail: "no JSON in reply" };
  }
  const second = extractJson<T>(retry.value);
  return second !== null ? { kind: "ok", value: second } : { kind: "invalid", detail: "no JSON in reply" };
}

// Null-returning wrapper, kept for callers that cannot act on the difference.
export async function chatJson<T = unknown>(messages: ChatMessage[], opts: ChatOpts = {}): Promise<T | null> {
  const r = await chatJsonOutcome<T>(messages, opts);
  return r.kind === "ok" ? r.value : null;
}
