const BASE = import.meta.env.VITE_API_URL ?? "/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: {
      accept: "application/json",
      ...(init?.body && !(init.body instanceof FormData)
        ? { "content-type": "application/json" }
        : {}),
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  if (!res.ok) {
    let err: { error?: string; issues?: unknown } = {};
    try {
      err = await res.json();
    } catch {
      // ignore
    }
    throw Object.assign(new Error(err.error ?? `http_${res.status}`), {
      status: res.status,
      body: err,
    });
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(p: string, opts?: { signal?: AbortSignal }) => req<T>(p, { signal: opts?.signal }),
  post: <T>(p: string, body?: unknown) =>
    req<T>(p, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(p: string, body?: unknown) =>
    req<T>(p, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  put: <T>(p: string, body?: unknown) =>
    req<T>(p, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  del: <T>(p: string) => req<T>(p, { method: "DELETE" }),
  upload: <T>(p: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return req<T>(p, { method: "POST", body: fd });
  },
};

// ─────────── typed helpers ───────────

export interface User {
  id: string;
  email: string;
  name: string;
  handle: string;
  avatarColor: string;
  createdAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  handle: string;
  role: string;
}

export interface Me {
  user: User;
  memberId: string | null;
  workspaceId: string | null;
  workspaces: Workspace[];
}

export type ConversationKind = "channel" | "dm";
export interface Conversation {
  id: string;
  kind: ConversationKind;
  name: string | null;
  topic: string;
  isPrivate: boolean;
  archived: boolean;
  createdAt: string;
  role: string;
  lastReadAt: string | null;
  muted: boolean;
  memberIds: string[];
  lastMessageAt: string | null;
  unreadCount: number;
  unreadMentions: number;
}

export interface Message {
  id: string;
  conversationId: string;
  memberId: string;
  parentId: string | null;
  bodyMd: string;
  attachmentsJson: Attachment[];
  mentions: string[];
  ts: string;
  editedAt?: string | null;
  deletedAt?: string | null;
  reactions: Array<{ emoji: string; memberId: string }>;
  replyCount: number;
}

export interface Attachment {
  key: string;
  name: string;
  contentType: string;
  size: number;
  url: string;
}

export interface HumanMember {
  memberId: string;
  id: string;
  kind: "user";
  name: string;
  handle: string;
  avatarColor: string;
  email: string;
  createdAt: string;
}

export interface AgentMember {
  memberId: string;
  id: string;
  kind: "agent";
  name: string;
  handle: string;
  avatarColor: string;
  agentKind: string;
  status: string;
  title: string;
  brief: string;
  createdAt: string;
}

export type DirMember = HumanMember | AgentMember;

export interface AgentRow {
  id: string;
  handle: string;
  name: string;
  avatarColor: string;
  kind: string;
  adapter: "webhook" | "socket";
  configJson: Record<string, unknown>;
  model: string;
  scopes: string[];
  status: string;
  title: string;
  brief: string;
  heartbeatIntervalSec: number;
  botToken: string;
  callbackUrl: string | null;
  createdBy: string;
  createdAt: string;
  memberId?: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  trigger: string;
  status: string;
  contextJson: Record<string, unknown>;
  resultJson: Record<string, unknown>;
  traceJson: string[];
  conversationId: string | null;
  startedAt: string;
  finishedAt: string | null;
  costUsd: number | null;
  errorText: string | null;
}

export interface ApprovalRow {
  id: string;
  agentRunId: string;
  agentId: string;
  conversationId: string | null;
  scope: string;
  action: string;
  payloadJson: Record<string, unknown>;
  status: string;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}
