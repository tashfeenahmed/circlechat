// Pure near-duplicate text matching shared by the cross-message dedupe
// (agents/dedupe.ts) and the project tracker's append dedupe
// (lib/project-files.ts). No db, no fs — unit-testable on its own.
//
// Strategy: 3-word shingles, Jaccard similarity. Normalization strips URLs,
// @mentions, and punctuation so "ping @nova" and "ping @ada" don't count as
// different, and lowercases so casing/markdown emphasis never matters.

export const DEFAULT_SIMILARITY_THRESHOLD = 0.85;
export const MIN_NORMALIZED_LEN = 30;
const SHINGLE_SIZE = 3;

export function normalizeText(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/@[a-z0-9_]+/g, " ")
    // Version tokens ("v28", "v1.2.3") collapse to a bare "v": the live
    // "Proof package vNN shipped" loop re-posted the same sentence with only
    // the counter bumped, and one differing token kills three 3-shingles.
    .replace(/\bv\d+(?:\.\d+)*\b/g, " v ")
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function shingles(normalized: string, k: number = SHINGLE_SIZE): Set<string> {
  const words = normalized.split(" ").filter(Boolean);
  if (words.length < k) return new Set([words.join(" ")]);
  const out = new Set<string>();
  for (let i = 0; i <= words.length - k; i++) {
    out.add(words.slice(i, i + k).join(" "));
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Similarity of two raw texts in [0,1]. Returns 0 when either side is too
// short to compare meaningfully (short bodies repeat naturally — "ok",
// "thanks", "👍" — and the false-positive cost is high).
export function textSimilarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na.length < MIN_NORMALIZED_LEN || nb.length < MIN_NORMALIZED_LEN) return 0;
  return jaccard(shingles(na), shingles(nb));
}

export interface NearDuplicateHit<T> {
  candidate: T;
  score: number; // rounded to 2 dp
}

// Find the first candidate whose body is ≥ threshold similar to `incoming`.
// Candidates are checked in the order given (callers pass newest-first).
export function findNearDuplicate<T extends { bodyMd: string }>(
  incoming: string,
  candidates: Iterable<T>,
  threshold: number = DEFAULT_SIMILARITY_THRESHOLD,
): NearDuplicateHit<T> | null {
  const incomingNorm = normalizeText(incoming);
  if (incomingNorm.length < MIN_NORMALIZED_LEN) return null;
  const incomingShingles = shingles(incomingNorm);
  for (const c of candidates) {
    const norm = normalizeText(c.bodyMd);
    if (norm.length < MIN_NORMALIZED_LEN) continue;
    const score = jaccard(incomingShingles, shingles(norm));
    if (score >= threshold) {
      return { candidate: c, score: Math.round(score * 100) / 100 };
    }
  }
  return null;
}
