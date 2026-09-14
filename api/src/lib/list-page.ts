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

import { sql as dsql, type SQL, type AnyColumn } from "drizzle-orm";

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

// ───────────────────── keyset comparison ─────────────────────
//
// A cursor's timestamp member must reach postgres as a STRING, never a Date.
//
// Drizzle's own operators (eq/gte/lt/…) know the column they are comparing
// against and run the value through that column's driver mapper, which turns a
// Date into an ISO string. A raw `sql` template does not: whatever JS value is
// interpolated is handed to postgres.js as a bind parameter verbatim, and
// postgres.js serialises a Date for a described parameter by calling
// Buffer.byteLength on it —
//   TypeError [ERR_INVALID_ARG_TYPE]: The "string" argument must be of type
//   string or an instance of Buffer or ArrayBuffer. Received an instance of Date
// which is a 500 on every request. That took `GET /tasks` down for the whole
// public board on release af6761a, and made `GET /goals?cursor=…` 500 on the
// second page (the first page has no cursor, so it looked fine).
//
// So the row-wise comparison both lists page on is built HERE, once, with the
// timestamp members normalised to an ISO string and cast in SQL. Nothing else
// in the api should interpolate a Date into a `sql` template.

// The ISO form of a cursor's timestamp member, or null when the cursor carries
// something that isn't a date. Null means "ignore this cursor" — the caller
// falls back to the first page rather than erroring, which is how every other
// unparseable cursor is already treated.
export function cursorTimestamp(raw: unknown): string | null {
  // A number is epoch milliseconds; `new Date(String(1789…))` would not parse
  // it and the cursor would silently drop back to the first page.
  const d = typeof raw === "number" ? new Date(raw) : new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * `(col, col, …) > (val, val, …)` — the row-wise comparison that makes a
 * keyset page start exactly after the previous page's last row.
 *
 * `direction` is "after" for an ascending list (the board) and "before" for a
 * descending one (goals, newest first). `timestampIndexes` names the members
 * that are timestamps; those are bound as `$n::timestamptz` from an ISO
 * string. Returns null when the cursor is unusable, which the caller treats as
 * "no cursor".
 */
export function keysetCondition(
  columns: AnyColumn[],
  values: Array<string | number>,
  direction: "after" | "before",
  timestampIndexes: readonly number[] = [],
): SQL | null {
  if (!columns.length || columns.length !== values.length) return null;
  const ts = new Set(timestampIndexes);
  const bound: SQL[] = [];
  for (let i = 0; i < values.length; i++) {
    if (ts.has(i)) {
      const iso = cursorTimestamp(values[i]);
      if (iso === null) return null;
      bound.push(dsql`${iso}::timestamptz`);
    } else if (typeof values[i] === "number") {
      bound.push(dsql`${Number(values[i])}`);
    } else {
      bound.push(dsql`${String(values[i])}`);
    }
  }
  const lhs = dsql.join(
    columns.map((c) => dsql`${c}`),
    dsql`, `,
  );
  const rhs = dsql.join(bound, dsql`, `);
  const op = dsql.raw(direction === "after" ? ">" : "<");
  return dsql`(${lhs}) ${op} (${rhs})`;
}

// Fetch `limit + 1` rows, then split: the extra row proves there is another
// page without a second count query.
export function takePage<T>(rows: T[], limit: number): { page: T[]; hasMore: boolean } {
  if (rows.length > limit) return { page: rows.slice(0, limit), hasMore: true };
  return { page: rows, hasMore: false };
}
