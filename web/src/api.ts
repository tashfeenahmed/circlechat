// SPDX-License-Identifier: AGPL-3.0-only
// One fetch wrapper for the CircleChat JSON API, plus the shapes it returns.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = (data && data.error) || `Something went wrong (${res.status})`;
    if (res.status === 401 && path !== "/api/login") window.dispatchEvent(new CustomEvent("cc:signedout"));
    throw new ApiError(res.status, msg.charAt(0).toUpperCase() + msg.slice(1));
  }
  return data as T;
}

export const api = {
  get: <T = any>(p: string) => call<T>("GET", p),
  post: <T = any>(p: string, b: unknown = {}) => call<T>("POST", p, b),
  put: <T = any>(p: string, b: unknown = {}) => call<T>("PUT", p, b),
  patch: <T = any>(p: string, b: unknown = {}) => call<T>("PATCH", p, b),
  del: <T = any>(p: string) => call<T>("DELETE", p),
};

// ---------------------------------------------------------------- shapes
export type Role = "owner" | "admin" | "builder" | "member";
export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt?: number;
}
export type AgentState = "stopped" | "starting" | "idle" | "working" | "waiting_approval" | "crashed" | "sleeping" | "budget";
export interface AgentStatus {
  state: AgentState;
  detail: string;
  since: number;
  heartbeat: number;
  chatId?: string;
}
export interface Agent {
  id: string;
  handle: string;
  name: string;
  roleTitle: string;
  style: string;
  colour: string;
  engine: string;
  model: string;
  instructions: string;
  autonomy: "ask" | "act" | "auto";
  sandbox: "docker" | "local";
  email: string;
  budgetCents: number;
  createdBy: string;
  createdAt: number;
  status: AgentStatus;
  monthCostMicros: number;
}
export interface Member {
  type: "user" | "agent";
  id: string;
}
export type MsgKind = "text" | "plan" | "approval" | "handoff" | "memory" | "system" | "error" | "trigger";
export interface Message {
  id: string;
  chatId: string;
  authorType: "user" | "agent" | "system";
  authorId: string;
  kind: MsgKind;
  body: string;
  meta: Record<string, any>;
  ts: number;
}
export interface Chat {
  id: string;
  kind: "group" | "dm" | "agents";
  name: string;
  createdAt: number;
  members: Member[];
  last?: Message | null;
  unread?: number;
}
export interface Approval {
  id: string;
  agentId: string;
  chatId: string;
  source: "acp" | "gateway";
  title: string;
  detail: any;
  options: { id: string; label: string }[];
  state: "pending" | "approved" | "denied" | "expired" | "cancelled";
  decision: string | null;
  decidedBy: string | null;
  reason: string | null;
  createdAt: number;
  expiresAt: number;
}
export interface Task {
  id: string;
  chatId: string;
  title: string;
  assigneeType: string;
  assigneeId: string;
  status: "todo" | "working" | "needs_you" | "checking" | "done";
  planId: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}
export interface Memory {
  id: string;
  scope: "team" | "chat" | "agent";
  scopeId: string;
  text: string;
  source: string;
  byType: "user" | "agent";
  byId: string;
  createdAt: number;
  forgottenAt: number | null;
  forgottenBy: string | null;
}
export interface ActivityEntry {
  ts: number;
  kind: "message" | "thought" | "tool" | "plan" | "usage" | "lifecycle" | "error" | "stderr" | "prompt";
  text: string;
  status?: string;
  toolCallId?: string;
  toolKind?: string;
}
export interface Delivery {
  id: string;
  agentId: string;
  chatId: string;
  fromType: string;
  fromId: string;
  text: string;
  hop: number;
  state: string;
  createdAt: number;
}
export interface Grant {
  type: "workspace" | "chat" | "agent";
  id?: string;
}

export type BusEvent =
  | { type: "hello" }
  | { type: "message"; chatId: string; message: Message }
  | { type: "message_updated"; chatId: string; message: Message }
  | { type: "agent_status"; agentId: string; status: AgentStatus }
  | { type: "agent_activity"; agentId: string; chatId: string; entry: ActivityEntry; append?: boolean }
  | { type: "typing"; chatId: string; agentId: string; on: boolean }
  | { type: "approval"; approval: Approval }
  | { type: "task"; chatId: string; task: Task }
  | { type: "memory"; memory: Memory }
  | { type: "chat"; chat: Chat }
  | { type: "delivery"; delivery: Delivery };
