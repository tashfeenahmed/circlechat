// "Leave channel" (Slack/Discord/Teams parity).
//
// Until now the only way out of a channel was an admin kicking you
// (DELETE /conversations/:id/members/:memberId explicitly rejects removing
// yourself). A workspace where someone created a channel you no longer want
// in had no exit for you. This module holds the pure decision so the guards
// are unit-testable without a database, mirroring lib/unread.js.
//
// Rules:
//  - unknown conversation (or one the caller can't see) → 404, so a probe
//    can't enumerate conversations in other workspaces
//  - DMs → 400: the DM list row is removed by archiving the DM (the sidebar
//    hides it); silently deleting the membership row would leave the other
//    person's DM still open with a ghost member and no way back for you
//  - non-member → 403, same shape the mute route uses
//  - everyone else may leave. Being the last admin is deliberately NOT a
//    blocker: channels have no paywall or ownership semantics, and blocking
//    the leave would trap people in archived leftovers. (An admin who leaves
//    a channel they created can re-add themselves; there is no "owner" row.)

export type LeaveChannelRejection = { status: 400 | 403 | 404; error: string };

export interface LeaveChannelConversation {
  kind: string; // "channel" | "dm"
  workspaceId: string;
}

export interface LeaveChannelMembership {
  role: string; // "admin" | "member"
}

export function leaveChannelRejection(
  conv: LeaveChannelConversation | undefined,
  membership: LeaveChannelMembership | undefined,
  callerWorkspaceId: string,
): LeaveChannelRejection | null {
  // Never confirm existence across workspaces: wrong-workspace and missing
  // both read as 404, matching POST /:id/members.
  if (!conv || conv.workspaceId !== callerWorkspaceId) return { status: 404, error: "not_found" };
  if (conv.kind !== "channel") return { status: 400, error: "not_a_channel" };
  if (!membership) return { status: 403, error: "not_a_member" };
  return null;
}
