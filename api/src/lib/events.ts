import { pub } from "./redis.js";

export type Event =
  | { type: "message.new"; conversationId: string; message: unknown }
  | { type: "message.edited"; conversationId: string; messageId: string; bodyMd: string; editedAt: string }
  | { type: "message.deleted"; conversationId: string; messageId: string }
  | { type: "reaction.toggled"; conversationId: string; messageId: string; memberId: string; emoji: string; added: boolean }
  | { type: "typing"; conversationId: string; memberId: string }
  | { type: "presence.update"; memberId: string; status: string }
  | { type: "agent.run.started"; conversationId?: string | null; agentId: string; agentName?: string | null; agentHandle?: string | null; runId: string; trigger: string }
  | { type: "agent.run.tool_call"; conversationId?: string | null; agentId: string; runId: string; tool: string; args: unknown }
  | { type: "agent.run.finished"; conversationId?: string | null; agentId: string; runId: string; status: string }
  | { type: "approval.new"; approvalId: string; agentId: string; scope: string; action: string; conversationId?: string | null }
  | { type: "approval.decided"; approvalId: string; status: string }
  | { type: "task.new"; workspaceId: string; task: unknown }
  | { type: "task.updated"; workspaceId: string; taskId: string; task: unknown }
  | { type: "task.deleted"; workspaceId: string; taskId: string }
  | { type: "task.assigned"; workspaceId: string; taskId: string; memberId: string; assignedBy: string }
  | { type: "task.unassigned"; workspaceId: string; taskId: string; memberId: string }
  | { type: "task.comment.new"; workspaceId: string; taskId: string; comment: unknown }
  | { type: "task.comment.deleted"; workspaceId: string; taskId: string; commentId: string };

const CONV_CHANNEL = (conversationId: string): string => `cc:conv:${conversationId}`;
const WORKSPACE_CHANNEL = (workspaceId: string): string => `cc:workspace:${workspaceId}`;
const USER_CHANNEL = (memberId: string): string => `cc:member:${memberId}`;
const GLOBAL_CHANNEL = "cc:global";

export async function publishToConversation(conversationId: string, ev: Event): Promise<void> {
  await pub.publish(CONV_CHANNEL(conversationId), JSON.stringify(ev));
}
export async function publishToWorkspace(workspaceId: string, ev: Event): Promise<void> {
  await pub.publish(WORKSPACE_CHANNEL(workspaceId), JSON.stringify(ev));
}
export async function publishToMember(memberId: string, ev: Event): Promise<void> {
  await pub.publish(USER_CHANNEL(memberId), JSON.stringify(ev));
}
export async function publishGlobal(ev: Event): Promise<void> {
  await pub.publish(GLOBAL_CHANNEL, JSON.stringify(ev));
}

export { CONV_CHANNEL, WORKSPACE_CHANNEL, USER_CHANNEL, GLOBAL_CHANNEL };
