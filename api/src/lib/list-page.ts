// Keyset pagination shared by the board (`GET /tasks`) and the goal list
// (`GET /goals`). Both used to return the whole workspace in one response —
// live.circlechat.co served 73 KB for 66 hydrated tasks on every board load,
// and it only grows.
//
// Keyset, not OFFSET: the board's sort key is stable, and a cursor over the
// last row's sort tuple can't skip or duplicate a row when a card moves
// between two page fetches (an OFFSET page would).
//
// The cursor is an opaque base64url string. Callers must treat it as opaque;
// an unparseable one is ignored (first page) rather than erroring, so a stale
// bookmark degrades instead of breaking.

export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 500;

export function clampLimit(raw: unknown, fallback = DEFAULT_PAGE_LIMIT): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(n)));
}

export function encodeCursor(parts: Array<string | number>): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}

// Returns null for anything that isn't a cursor we wrote. `expect` is the
// number of tuple members; a cursor of the wrong arity belongs to a different
// endpoint (or an older release) and is ignored.
export function decodeCursor(raw: unknown, expect: number): Array<string | number> | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== expect) return null;
    if (!parsed.every((v) => typeof v === "string" || typeof v === "number")) return null;
    return parsed as Array<string | number>;
  } catch {
    return null;
  }
}

// Fetch `limit + 1` rows, then split: the extra row proves there is another
// page without a second count query.
export function takePage<T>(rows: T[], limit: number): { page: T[]; hasMore: boolean } {
  if (rows.length > limit) return { page: rows.slice(0, limit), hasMore: true };
  return { page: rows, hasMore: false };
}
