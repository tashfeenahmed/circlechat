// OpenAI-compatible chat-completions client, configured entirely via env so it
// can point at any /v1/chat/completions backend (the FreeLLMAPI gateway,
// OpenAI, a local model). Used server-side by the goal planner to decompose a
// goal into a task graph — the API doing the reasoning directly rather than
// routing through an agent runtime, so planning works even with zero agents
// online and is deterministic enough to validate against a schema.
//
//   PLANNER_BASE_URL  e.g. http://127.0.0.1:3001/v1  (the /v1 root)
//                     falls back to EMBEDDINGS_BASE_URL (same gateway)
//   PLANNER_API_KEY   bearer token; falls back to EMBEDDINGS_API_KEY
//   PLANNER_MODEL     model name; default "auto" (FreeLLMAPI picks the chain)
//
// Fully dormant unless a base URL resolves, so the planner degrades to a clear
// "planner_unconfigured" error rather than throwing.
const baseUrl = (): string =>
  (process.env.PLANNER_BASE_URL || process.env.EMBEDDINGS_BASE_URL || "").replace(/\/+$/, "");
const apiKey = (): string => process.env.PLANNER_API_KEY || process.env.EMBEDDINGS_API_KEY || "";
const model = (): string => process.env.PLANNER_MODEL || "auto";

export function plannerEnabled(): boolean {
  return !!baseUrl();
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// Call chat/completions and return the assistant's raw text, or null on any
// failure (unconfigured, network, bad shape). Callers decide how to treat null.
export async function chat(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; timeoutMs?: number } = {},
): Promise<string | null> {
  if (!plannerEnabled()) return null;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  try {
    const res = await fetch(`${baseUrl()}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(apiKey() ? { Authorization: `Bearer ${apiKey()}` } : {}),
      },
      body: JSON.stringify({
        model: model(),
        messages,
        temperature: opts.temperature ?? 0.2,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content;
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Pull the first JSON object/array out of a model response. Tolerates ```json
// fences and leading/trailing prose — small models rarely return clean JSON.
// Returns null if nothing parses.
export function extractJson<T = unknown>(text: string | null): T | null {
  if (!text) return null;
  // Strip a ```json … ``` (or bare ```) fence if present.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  // Find the outermost {...} or [...] span.
  const firstObj = candidate.search(/[[{]/);
  if (firstObj === -1) return null;
  const opener = candidate[firstObj];
  const closer = opener === "{" ? "}" : "]";
  const lastClose = candidate.lastIndexOf(closer);
  if (lastClose <= firstObj) return null;
  const slice = candidate.slice(firstObj, lastClose + 1);
  try {
    return JSON.parse(slice) as T;
  } catch {
    try {
      return JSON.parse(candidate.trim()) as T;
    } catch {
      return null;
    }
  }
}

// Convenience: chat() then extractJson(). Retries once with a terser nudge if
// the first reply doesn't parse — small models sometimes need a second push.
export async function chatJson<T = unknown>(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; timeoutMs?: number } = {},
): Promise<T | null> {
  const first = await chat(messages, opts);
  const parsed = extractJson<T>(first);
  if (parsed !== null) return parsed;
  const retry = await chat(
    [...messages, { role: "user", content: "Return ONLY the JSON, no prose, no code fence." }],
    opts,
  );
  return extractJson<T>(retry);
}
