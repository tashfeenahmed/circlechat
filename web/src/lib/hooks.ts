import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type Me,
  type Conversation,
  type Message,
  type AgentRow,
  type AgentRun,
  type DirMember,
  type ApprovalRow,
  type Task,
  type TaskDetail,
  type TaskComment,
} from "../api/client";
import { bus } from "../ws/client";
import { useBus } from "../state/store";

export function useMe() {
  return useQuery<Me | null>({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await api.get<Me>("/me");
      } catch (e) {
        const err = e as { status?: number };
        if (err.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useConversations() {
  const qc = useQueryClient();
  const q = useQuery<{ conversations: Conversation[] }>({
    queryKey: ["conversations"],
    queryFn: () => api.get("/conversations"),
    staleTime: 15_000,
  });
  useEffect(() => {
    return bus.on((ev) => {
      if (ev.type === "message.new") {
        // Bump unread for the conversation receiving the new message so the
        // sidebar reflects activity immediately. Active conversation's read
        // receipt will zero it again on next poll.
        qc.setQueryData<{ conversations: Conversation[] }>(["conversations"], (old) => {
          if (!old) return old;
          const cid = ev.conversationId as string;
          const msg = ev.message as { memberId: string; mentions?: string[] };
          return {
            conversations: old.conversations.map((c) => {
              if (c.id !== cid) return c;
              const meMember = (qc.getQueryData(["me"]) as Me | null)?.memberId;
              const fromMe = meMember && msg.memberId === meMember;
              const mentionsMe = meMember && (msg.mentions ?? []).includes(meMember);
              if (fromMe) return c;
              return {
                ...c,
                unreadCount: (c.unreadCount ?? 0) + 1,
                unreadMentions: (c.unreadMentions ?? 0) + (mentionsMe ? 1 : 0),
                lastMessageAt: new Date().toISOString(),
              };
            }),
          };
        });
      }
    });
  }, [qc]);
  return q;
}

export function useMarkRead(conversationId: string | undefined) {
  const qc = useQueryClient();
  return async () => {
    if (!conversationId) return;
    try { await api.post(`/conversations/${conversationId}/read`); } catch {}
    qc.setQueryData<{ conversations: Conversation[] }>(["conversations"], (old) =>
      old
        ? {
            conversations: old.conversations.map((c) =>
              c.id === conversationId ? { ...c, unreadCount: 0, unreadMentions: 0 } : c,
            ),
          }
        : old,
    );
  };
}

export function useMembersDirectory() {
  return useQuery<{ humans: DirMember[]; agents: DirMember[] }>({
    queryKey: ["members"],
    queryFn: () => api.get("/members"),
    staleTime: 15_000,
  });
}

export function useConversation(id: string | undefined) {
  return useQuery({
    queryKey: ["conversation", id],
    queryFn: () => api.get<{ conversation: Conversation; members: Array<{ memberId: string; role: string }> }>(`/conversations/${id}`),
    enabled: !!id,
    staleTime: 15_000,
  });
}

export function useMessages(convId: string | undefined, parentId?: string | null) {
  const qc = useQueryClient();
  const key = ["messages", convId, parentId ?? "root"] as const;
  const q = useQuery({
    queryKey: key,
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (parentId) qs.set("parent_id", parentId);
      qs.set("limit", "200");
      return api.get<{ messages: Message[] }>(`/conversations/${convId}/messages?${qs}`);
    },
    enabled: !!convId,
  });

  // Keep cache updated as new messages stream in over WS.
  useEffect(() => {
    if (!convId) return;
    return bus.on((ev) => {
      if (ev.type === "message.new" && ev.conversationId === convId) {
        const m = ev.message as Message;
        const paneParent = parentId ?? null;
        const msgParent = m.parentId ?? null;
        if (paneParent !== msgParent) {
          // For our pane: no append. But bump replyCount on the parent if we're
          // the root pane and the new message is a thread reply.
          if (!parentId && m.parentId) {
            qc.setQueryData<{ messages: Message[] }>(["messages", convId, "root"], (old) => {
              if (!old) return old;
              return {
                messages: old.messages.map((x) =>
                  x.id === m.parentId ? { ...x, replyCount: (x.replyCount ?? 0) + 1 } : x,
                ),
              };
            });
          }
          return;
        }
        // Append, but dedupe by id (optimistic/echo collisions).
        qc.setQueryData<{ messages: Message[] }>(key, (old) => {
          if (!old) return { messages: [m] };
          if (old.messages.some((x) => x.id === m.id)) return old;
          return { messages: [...old.messages, m] };
        });
      }
      if (ev.type === "message.edited" && ev.conversationId === convId) {
        qc.setQueryData<{ messages: Message[] }>(key, (old) =>
          old
            ? {
                messages: old.messages.map((m) =>
                  m.id === ev.messageId
                    ? { ...m, bodyMd: ev.bodyMd as string, editedAt: ev.editedAt as string }
                    : m,
                ),
              }
            : old,
        );
      }
      if (ev.type === "message.deleted" && ev.conversationId === convId) {
        qc.setQueryData<{ messages: Message[] }>(key, (old) =>
          old ? { messages: old.messages.filter((m) => m.id !== ev.messageId) } : old,
        );
      }
      if (ev.type === "reaction.toggled" && ev.conversationId === convId) {
        qc.setQueryData<{ messages: Message[] }>(key, (old) => {
          if (!old) return old;
          return {
            messages: old.messages.map((m) => {
              if (m.id !== ev.messageId) return m;
              const base = (m.reactions ?? []).filter(
                (r) => !(r.emoji === ev.emoji && r.memberId === ev.memberId),
              );
              return ev.added
                ? { ...m, reactions: [...base, { emoji: ev.emoji as string, memberId: ev.memberId as string }] }
                : { ...m, reactions: base };
            }),
          };
        });
      }
    });
  }, [convId, parentId, qc, key]);

  return q;
}

export function usePostMessage(convId: string | undefined, parentId?: string | null) {
  const qc = useQueryClient();
  const key = ["messages", convId, parentId ?? "root"] as const;
  return useMutation({
    mutationFn: (body: { bodyMd: string; attachments?: unknown[] }) =>
      api.post<{ message: Message }>(`/conversations/${convId}/messages`, {
        bodyMd: body.bodyMd,
        parentId,
        attachments: body.attachments,
      }),
    onMutate: async (vars) => {
      const optimistic: Message = {
        id: `tmp_${Math.random().toString(36).slice(2)}`,
        conversationId: convId ?? "",
        memberId: "me",
        parentId: parentId ?? null,
        bodyMd: vars.bodyMd,
        attachmentsJson: (vars.attachments ?? []) as never,
        mentions: [],
        ts: new Date().toISOString(),
        reactions: [],
        replyCount: 0,
      };
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<{ messages: Message[] }>(key);
      qc.setQueryData<{ messages: Message[] }>(key, (old) =>
        old ? { messages: [...old.messages, optimistic] } : { messages: [optimistic] },
      );
      return { optimistic, prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) {
        // Reassign previous state on failure.
        // We intentionally don't remove the optimistic message if it already landed.
      }
    },
    onSuccess: (res, _v, ctx) => {
      qc.setQueryData<{ messages: Message[] }>(key, (old) => {
        if (!old) return { messages: [res.message] };
        // Strip the optimistic row; skip append if WS already delivered the real one.
        const withoutTmp = old.messages.filter((m) => m.id !== ctx?.optimistic.id);
        if (withoutTmp.some((m) => m.id === res.message.id)) {
          return { messages: withoutTmp };
        }
        return { messages: [...withoutTmp, res.message] };
      });
    },
  });
}

export function useAgents() {
  return useQuery<{ agents: AgentRow[] }>({
    queryKey: ["agents"],
    queryFn: () => api.get("/agents"),
    staleTime: 10_000,
  });
}

export function useApprovals() {
  const qc = useQueryClient();
  const q = useQuery<{ approvals: ApprovalRow[] }>({
    queryKey: ["approvals"],
    queryFn: () => api.get("/approvals"),
    staleTime: 10_000,
  });
  useEffect(() => {
    return bus.on((ev) => {
      if (ev.type === "approval.new" || ev.type === "approval.decided") {
        qc.invalidateQueries({ queryKey: ["approvals"] });
      }
    });
  }, [qc]);
  return q;
}

export function useAgent(id: string | undefined) {
  return useQuery({
    queryKey: ["agent", id],
    queryFn: () =>
      api.get<{ agent: AgentRow; channels: Conversation[]; recentRuns: AgentRun[] }>(
        `/agents/${id}`,
      ),
    enabled: !!id,
    staleTime: 10_000,
  });
}

export function usePresenceBus() {
  const set = useBus.getState();
  useEffect(() => {
    return bus.on((ev) => {
      if (ev.type === "presence.update") {
        set.setPresence(ev.memberId as string, ev.status as string);
      }
      if (ev.type === "typing") {
        set.touchTyping(ev.conversationId as string, ev.memberId as string);
      }
      if (ev.type === "agent.run.started") {
        set.beginRun(
          ev.runId as string,
          ev.agentId as string,
          (ev.trigger as string) ?? "scheduled",
          (ev.agentName as string | null | undefined) ?? null,
          (ev.agentHandle as string | null | undefined) ?? null,
        );
      }
      if (ev.type === "agent.run.finished") {
        set.endRun(ev.runId as string);
      }
      if (ev.type === "agent.runs.snapshot") {
        // Replay in-flight runs from the server after (re)connect.
        const runs = (ev.runs as Array<{
          runId: string;
          agentId: string;
          agentName: string | null;
          agentHandle: string | null;
          trigger: string;
          startedAt: string;
        }>) ?? [];
        set.syncRuns(runs);
      }
    });
  }, []);
}

// ─────────────────── Tasks / Boards ───────────────────

export function useTasks(convId: string | undefined) {
  const qc = useQueryClient();
  const key = ["tasks", convId] as const;
  const q = useQuery<{ tasks: Task[] }>({
    queryKey: key,
    queryFn: () => api.get(`/conversations/${convId}/tasks`),
    enabled: !!convId,
    staleTime: 15_000,
  });
  useEffect(() => {
    if (!convId) return;
    return bus.on((ev) => {
      if (typeof ev.type !== "string") return;
      if (!String(ev.type).startsWith("task.")) return;
      if (ev.conversationId !== convId) return;
      if (ev.type === "task.new") {
        const t = ev.task as Task;
        qc.setQueryData<{ tasks: Task[] }>(key, (old) => {
          if (!old) return { tasks: [t] };
          if (old.tasks.some((x) => x.id === t.id)) return old;
          return { tasks: [...old.tasks, t] };
        });
      } else if (ev.type === "task.updated") {
        const t = ev.task as Task;
        qc.setQueryData<{ tasks: Task[] }>(key, (old) => {
          if (!old) return old;
          return { tasks: old.tasks.map((x) => (x.id === t.id ? t : x)) };
        });
      } else if (ev.type === "task.deleted") {
        qc.setQueryData<{ tasks: Task[] }>(key, (old) =>
          old ? { tasks: old.tasks.filter((x) => x.id !== ev.taskId) } : old,
        );
      }
      // task.assigned / task.unassigned always arrive paired with task.updated
      // so the hydrated row already reflects the state change.
    });
  }, [convId, qc, key]);
  return q;
}

export function useTaskDetail(taskId: string | undefined) {
  const qc = useQueryClient();
  const key = ["task", taskId] as const;
  const q = useQuery<TaskDetail>({
    queryKey: key,
    queryFn: () => api.get(`/tasks/${taskId}`),
    enabled: !!taskId,
    staleTime: 10_000,
  });
  useEffect(() => {
    if (!taskId) return;
    return bus.on((ev) => {
      if (typeof ev.type !== "string" || !String(ev.type).startsWith("task.")) return;
      const t = ev as unknown as { taskId?: string; comment?: TaskComment; commentId?: string; task?: Task };
      if (ev.type === "task.comment.new" && t.taskId === taskId) {
        qc.setQueryData<TaskDetail>(key, (old) =>
          old && t.comment ? { ...old, comments: [...old.comments, t.comment] } : old,
        );
      } else if (ev.type === "task.comment.deleted" && t.taskId === taskId) {
        qc.setQueryData<TaskDetail>(key, (old) =>
          old ? { ...old, comments: old.comments.filter((c) => c.id !== t.commentId) } : old,
        );
      } else if (
        (ev.type === "task.updated" || ev.type === "task.assigned" || ev.type === "task.unassigned") &&
        t.taskId === taskId
      ) {
        qc.invalidateQueries({ queryKey: key });
      }
    });
  }, [taskId, qc, key]);
  return q;
}

export function useIsClient() {
  const [c, s] = useState(false);
  useEffect(() => s(true), []);
  return c;
}
