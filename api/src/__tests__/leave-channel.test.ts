import { describe, expect, it } from "vitest";
import { leaveChannelRejection } from "../lib/leave-channel.js";

// "Leave channel" (DELETE /conversations/:id/leave) — Slack/Discord/Teams
// parity. The guards are pure (same style as lib/unread.js) so the whole
// decision table is covered without a database.

const WS = "ws_1";
const channel = { kind: "channel", workspaceId: WS };
const dm = { kind: "dm", workspaceId: WS };
const member = { role: "member" };
const admin = { role: "admin" };

describe("leave channel guards", () => {
  it("lets a plain member leave a channel in their workspace", () => {
    expect(leaveChannelRejection(channel, member, WS)).toBeNull();
  });

  it("lets an admin leave too — no last-admin trap", () => {
    expect(leaveChannelRejection(channel, admin, WS)).toBeNull();
  });

  it("404s an unknown conversation before membership is even considered", () => {
    expect(leaveChannelRejection(undefined, member, WS)).toEqual({
      status: 404,
      error: "not_found",
    });
  });

  it("404s (not 403) a conversation from another workspace — no enumeration", () => {
    expect(leaveChannelRejection({ kind: "channel", workspaceId: "ws_other" }, undefined, WS)).toEqual(
      { status: 404, error: "not_found" },
    );
  });

  it("400s a DM — the exit for a DM is archive, not a membership delete", () => {
    expect(leaveChannelRejection(dm, member, WS)).toEqual({ status: 400, error: "not_a_channel" });
  });

  it("403s a non-member (also covers DELETE .../members/self removals)", () => {
    expect(leaveChannelRejection(channel, undefined, WS)).toEqual({
      status: 403,
      error: "not_a_member",
    });
  });
});
