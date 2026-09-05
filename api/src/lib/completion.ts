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
}

// Diagnostics for the "returned null" path. Every consumer of this client
// fails soft (planner errors out, verifier fails open/holds), so without a log
// line here a dead gateway is invisible. Throttled per (target, reason) so a
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

// Call chat/completions and return the assistant's raw text, or null on any
// failure (unconfigured, network, bad shape). Callers decide how to treat null.
//
// A PINNED model (model set to something other than "auto") falls back to
// "auto" when the pinned call fails. Rationale: the pin exists for judge
// consistency, but pinned free-tier models get rate-limited for hours at a
// time, and every consumer of this client fails soft — so a dead pin silently
// disables planning AND verification until someone notices. A drifting judge
// beats a dormant one.
export async function chat(messages: ChatMessage[], opts: ChatOpts = {}): Promise<string | null> {
  const target = opts.target === undefined ? resolvePlannerTarget() : opts.target;
  if (!target) return null;
  const first = await chatWithModel(target, target.model, messages, opts);
  if (first !== null || target.model === "auto") return first;
  console.warn(`[completion] pinned model ${target.model} failed — retrying with model=auto`);
  return chatWithModel(target, "auto", messages, opts);
}

async function chatWithModel(
  target: ChatTarget,
  modelName: string,
  messages: ChatMessage[],
  opts: ChatOpts = {},
): Promise<string | null> {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const t = setTimeout(() => controller.abort(), timeoutMs);
  const at = { ...target, model: modelName };
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
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      noteChatFailure(at, `http_${res.status}`, body);
      return null;
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: unknown;
    };
    const text = json.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      noteChatFailure(at, "bad_shape", JSON.stringify(json.error ?? json).slice(0, 200));
      return null;
    }
    return text;
  } catch (e) {
    const aborted = (e as Error)?.name === "AbortError";
    noteChatFailure(at, aborted ? `timeout_${timeoutMs}ms` : "network", aborted ? "" : (e as Error)?.message ?? "");
    return null;
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

// Convenience: chat() then extractJson(). Retries once with a terser nudge if
// the first reply doesn't parse — small models sometimes need a second push.
// A null FIRST reply (transport failure) is NOT retried with the nudge: the
// nudge fixes formatting, not a dead gateway, and doubling calls against a
// rate-limited endpoint only deepens the outage.
export async function chatJson<T = unknown>(messages: ChatMessage[], opts: ChatOpts = {}): Promise<T | null> {
  const first = await chat(messages, opts);
  if (first === null) return null;
  const parsed = extractJson<T>(first);
  if (parsed !== null) return parsed;
  const retry = await chat(
    [
      ...messages,
      {
        role: "user",
        content:
          "Return ONLY the final JSON object, starting with { and ending with } — no reasoning, no analysis, no prose, no code fence.",
      },
    ],
    opts,
  );
  return extractJson<T>(retry);
}
