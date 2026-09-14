import { describe, it, expect } from "vitest";
import { gte, ne, or } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { goals, tasks } from "../db/schema.js";
import {
  clampLimit,
  cursorTimestamp,
  decodeCursor,
  encodeCursor,
  keysetCondition,
  takePage,
} from "../lib/list-page.js";

// The board (GET /tasks) returned 500 for every caller on release af6761a, and
// GET /goals 500'd the moment you followed a cursor. Both for the same reason:
// a `new Date(...)` interpolated into a raw `sql` template reaches postgres.js
// as a bind parameter, and postgres.js serialises a described parameter by
// calling Buffer.byteLength on it —
//   TypeError [ERR_INVALID_ARG_TYPE]: The "string" argument must be of type
//   string or an instance of Buffer or ArrayBuffer. Received an instance of Date
//
// So these suites run the real SQL builder over a real Date and assert on the
// BOUND PARAMETERS. A regression that puts a Date back in a template fails
// here, without needing a database.

const dialect = new PgDialect();
function compile(sql: Parameters<PgDialect["sqlToQuery"]>[0]): {
  sql: string;
  params: unknown[];
} {
  const q = dialect.sqlToQuery(sql);
  return { sql: q.sql, params: q.params };
}
function hasDate(params: unknown[]): boolean {
  return params.some((p) => p instanceof Date);
}

const ISO = "2026-09-11T08:30:00.000Z";

describe("cursor encode/decode round-trip", () => {
  it("round-trips the board's four-member tuple", () => {
    const parts = ["review", 1.5, ISO, "task_5qkzfn2v5bcs06c6vdme"];
    const decoded = decodeCursor(encodeCursor(parts), 4);
    expect(decoded).toEqual(parts);
  });

  it("round-trips a Date written as its ISO string", () => {
    const d = new Date(ISO);
    const decoded = decodeCursor(encodeCursor([d.toISOString(), "goal_abc123def456"]), 2);
    expect(decoded).toEqual([ISO, "goal_abc123def456"]);
    expect(typeof decoded![0]).toBe("string");
  });

  it("ignores a cursor of the wrong arity, a foreign string, or junk", () => {
    expect(decodeCursor(encodeCursor([ISO, "x"]), 4)).toBeNull();
    expect(decodeCursor("not-a-cursor", 2)).toBeNull();
    expect(decodeCursor(undefined, 2)).toBeNull();
    expect(decodeCursor(Buffer.from('["a",{}]', "utf8").toString("base64url"), 2)).toBeNull();
  });

  it("clamps the page limit", () => {
    expect(clampLimit(undefined)).toBe(100);
    expect(clampLimit("abc")).toBe(100);
    expect(clampLimit(5000)).toBe(500);
    expect(clampLimit(0)).toBe(1);
  });

  it("takePage reports another page only when the probe row came back", () => {
    expect(takePage([1, 2, 3], 2)).toEqual({ page: [1, 2], hasMore: true });
    expect(takePage([1, 2], 2)).toEqual({ page: [1, 2], hasMore: false });
  });
});

describe("cursorTimestamp", () => {
  it("normalises to an ISO string, never a Date", () => {
    const out = cursorTimestamp(ISO);
    expect(typeof out).toBe("string");
    expect(out).toBe(ISO);
  });

  it("accepts anything Date can parse and still yields a string", () => {
    expect(cursorTimestamp(new Date(ISO).toString())).toBe(ISO);
    expect(typeof cursorTimestamp(Date.parse(ISO))).toBe("string");
  });

  it("returns null for an unparseable member instead of throwing", () => {
    expect(cursorTimestamp("not-a-date")).toBeNull();
    expect(cursorTimestamp("")).toBeNull();
    expect(cursorTimestamp(undefined)).toBeNull();
  });
});

describe("keysetCondition binds strings, not Dates", () => {
  it("builds the board's row-wise comparison", () => {
    const cond = keysetCondition(
      [tasks.status, tasks.position, tasks.createdAt, tasks.id],
      ["review", 1.5, ISO, "task_5qkzfn2v5bcs06c6vdme"],
      "after",
      [2],
    )!;
    expect(cond).not.toBeNull();
    const { sql, params } = compile(cond);
    expect(hasDate(params)).toBe(false);
    for (const p of params) expect(["string", "number"]).toContain(typeof p);
    expect(params).toContain(ISO);
    // The timestamp member is cast, so postgres compares timestamptz to
    // timestamptz rather than guessing from an untyped literal.
    expect(sql).toContain("::timestamptz");
    expect(sql).toContain(">");
  });

  it("builds the goal list's descending comparison", () => {
    const cond = keysetCondition([goals.createdAt, goals.id], [ISO, "goal_abc123def456"], "before", [
      0,
    ])!;
    const { sql, params } = compile(cond);
    expect(hasDate(params)).toBe(false);
    expect(params).toEqual([ISO, "goal_abc123def456"]);
    expect(sql).toContain("<");
  });

  it("normalises a timestamp member that arrives in another shape", () => {
    const cond = keysetCondition(
      [goals.createdAt, goals.id],
      [new Date(ISO).toString(), "goal_abc123def456"],
      "before",
      [0],
    )!;
    const { params } = compile(cond);
    expect(hasDate(params)).toBe(false);
    expect(params[0]).toBe(ISO);
  });

  it("returns null (→ first page) rather than building a broken comparison", () => {
    expect(
      keysetCondition([goals.createdAt, goals.id], ["not-a-date", "goal_x"], "before", [0]),
    ).toBeNull();
    expect(keysetCondition([goals.createdAt, goals.id], [ISO], "before", [0])).toBeNull();
    expect(keysetCondition([], [], "before")).toBeNull();
  });
});

describe("the Done-window cutoff", () => {
  // listTasks caps how far back the Done column reaches for the public board.
  // It used to interpolate the cutoff Date into a template; it now goes through
  // drizzle's own operator, which maps the value with the COLUMN's driver
  // mapper. This asserts that mapping really does produce a string.
  it("binds the cutoff Date as a string through gte()", () => {
    const cutoff = new Date(ISO);
    const cond = or(ne(tasks.status, "done"), gte(tasks.updatedAt, cutoff))!;
    const { params } = compile(cond);
    expect(hasDate(params)).toBe(false);
    for (const p of params) expect(typeof p).toBe("string");
    expect(params).toContain("done");
  });
});
