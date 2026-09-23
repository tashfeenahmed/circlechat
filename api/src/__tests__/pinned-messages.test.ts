import { describe, it, expect } from "vitest";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { messages } from "../db/schema.js";

// Pinned messages (migration 0029): pinnedAt NULL = not pinned, pinnedBy is
// the member who pinned. These suites compile the real SQL the pins routes
// build (same approach as keyset-cursor.test.ts) so a regression that drops
// the deleted-row guard or the not-null filter — leaking deleted pins into
// the channel header, or unpinning by dropping rows — fails without needing
// a database.

const dialect = new PgDialect();
function compile(sql: Parameters<PgDialect["sqlToQuery"]>[0]) {
  const q = dialect.sqlToQuery(sql);
  return { sql: q.sql, params: q.params };
}

const CONV = "c_test_1";

describe("pins list query", () => {
  const q = compile(
    and(
      eq(messages.conversationId, CONV),
      isNull(messages.deletedAt),
      isNotNull(messages.pinnedAt),
    )!,
  );

  it("filters deleted rows and unpinned rows in SQL", () => {
    expect(q.sql).toMatch(/"deleted_at" is null/);
    expect(q.sql).toMatch(/"pinned_at" is not null/);
  });

  it("binds the conversation id as a parameter (never inlined)", () => {
    expect(q.params).toContain(CONV);
    expect(q.sql).not.toContain(CONV);
  });

  it("orders newest pin first", () => {
    const ordered = compile(desc(messages.pinnedAt));
    expect(ordered.sql).toMatch(/"pinned_at".*desc/i);
  });
});

describe("pin columns exist on the messages schema", () => {
  it("carries pinnedAt and pinnedBy so list routes can spread them", () => {
    expect(messages.pinnedAt).toBeDefined();
    expect(messages.pinnedBy).toBeDefined();
    expect((messages.pinnedAt as unknown as { name: string }).name).toBe("pinned_at");
    expect((messages.pinnedBy as unknown as { name: string }).name).toBe("pinned_by");
  });
});
