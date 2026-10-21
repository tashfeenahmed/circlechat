import { describe, expect, it } from "vitest";
import { editRejection, reactRejection } from "../lib/message-mutations.js";

// Message mutation guards (routes/messages.ts). A soft-deleted message is 404
// for every reader path (list filter, search, pins, unread-from) — edit and
// react used to disagree: PATCH on a deleted row answered 200 and wrote a live
// body back onto the tombstone, and reactions attached to invisible messages.

describe("editRejection", () => {
  it("404s a missing message", () => {
    expect(editRejection(undefined, "m_me")).toEqual({ status: 404, error: "not_found" });
  });

  it("404s a deleted message — never confirm or mutate a tombstone", () => {
    // Before this guard the route only checked existence, so this wrote a new
    // bodyMd + editedAt onto the deleted row and answered 200.
    expect(
      editRejection({ memberId: "m_me", deletedAt: new Date() }, "m_me"),
    ).toEqual({ status: 404, error: "not_found" });
  });

  it("403s a live message the caller didn't author", () => {
    expect(editRejection({ memberId: "m_other", deletedAt: null }, "m_me")).toEqual({
      status: 403,
      error: "not_author",
    });
  });

  it("404 outranks 403 (a deleted message by someone else leaks nothing)", () => {
    expect(editRejection({ memberId: "m_other", deletedAt: new Date() }, "m_me")).toEqual({
      status: 404,
      error: "not_found",
    });
  });

  it("allows the author to edit a live message", () => {
    expect(editRejection({ memberId: "m_me", deletedAt: null }, "m_me")).toBeNull();
  });
});

describe("reactRejection", () => {
  it("404s a missing or deleted message", () => {
    expect(reactRejection(undefined)).toEqual({ status: 404, error: "not_found" });
    expect(reactRejection({ deletedAt: new Date() })).toEqual({ status: 404, error: "not_found" });
  });

  it("allows reactions on a live message", () => {
    expect(reactRejection({ deletedAt: null })).toBeNull();
  });
});
