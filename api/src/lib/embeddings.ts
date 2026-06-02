// OpenAI-compatible embeddings client, configured entirely via env so it can
// point at any /v1/embeddings backend (the FreeLLMAPI gateway, OpenAI, a local
// model). Fully no-op unless EMBEDDINGS_BASE_URL is set, so RAG features stay
// dormant until an operator wires an embeddings backend.
//   EMBEDDINGS_BASE_URL  e.g. http://127.0.0.1:3001/v1   (the /v1 root)
//   EMBEDDINGS_API_KEY   bearer token for that endpoint (optional)
//   EMBEDDINGS_MODEL     e.g. text-embedding-004 (default)
const baseUrl = (): string => (process.env.EMBEDDINGS_BASE_URL || "").replace(/\/+$/, "");
const apiKey = (): string => process.env.EMBEDDINGS_API_KEY || "";
const model = (): string => process.env.EMBEDDINGS_MODEL || "text-embedding-004";

export function embeddingsEnabled(): boolean {
  return !!baseUrl();
}

// Embed one or more texts. Returns a vector per input, or null on any failure
// (unconfigured, network, bad response) — callers treat null as "skip".
export async function embed(texts: string[]): Promise<number[][] | null> {
  if (!embeddingsEnabled() || texts.length === 0) return null;
  try {
    const res = await fetch(`${baseUrl()}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey() ? { Authorization: `Bearer ${apiKey()}` } : {}),
      },
      body: JSON.stringify({ model: model(), input: texts }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Array<{ embedding: number[]; index?: number }> };
    if (!Array.isArray(json.data)) return null;
    // Preserve input order (OpenAI returns an `index` per item).
    const out: number[][] = [];
    json.data.forEach((d, i) => {
      out[d.index ?? i] = d.embedding;
    });
    return out;
  } catch {
    return null;
  }
}

export async function embedOne(text: string): Promise<number[] | null> {
  const v = await embed([text]);
  return v?.[0] ?? null;
}

// Cosine similarity of two equal-length vectors. Returns -1 on mismatch.
export function cosine(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return -1;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
