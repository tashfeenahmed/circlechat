import { useCallback, useEffect, useMemo, useState } from "react";
import { useAgents, useConversations, useMe, useMembersDirectory, useMessages, useSpectator, useTasks } from "./hooks";

// First-run checklist, derived from real workspace state rather than a stored
// wizard position — so it stays correct if the admin adds an agent from
// Members, posts from another device, or skips a step. Dismissal is the only
// thing persisted (per workspace, in localStorage).

export interface OnboardingStep {
  id: "agent" | "hello" | "task" | "invite";
  title: string;
  why: string;
  done: boolean;
  // Short live status under the title (e.g. "@ceo is starting…").
  status?: string;
}

export interface OnboardingState {
  ready: boolean;
  steps: OnboardingStep[];
  doneCount: number;
  complete: boolean;
  dismissed: boolean;
  dismiss: () => void;
  restore: () => void;
  // The agent to suggest in copy/prefills (first one installed), if any.
  agent: { handle: string; name: string; status: string } | null;
  firstChannelId: string | null;
  // True while the workspace looks brand new: no agent reply anywhere yet.
  fresh: boolean;
}

function storageKey(workspaceId: string | null | undefined): string {
  return `cc.onboarding.dismissed.${workspaceId ?? "ws"}`;
}

function readDismissed(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function useOnboarding(channelId?: string | null): OnboardingState {
  const me = useMe();
  const spectator = useSpectator();
  const agents = useAgents();
  const dir = useMembersDirectory();
  const tasks = useTasks();
  const convs = useConversations();

  const channels = useMemo(
    () => (convs.data?.conversations ?? []).filter((c) => c.kind === "channel"),
    [convs.data],
  );
  const firstChannelId = channels[0]?.id ?? null;
  const watchId = channelId ?? firstChannelId ?? undefined;
  const msgs = useMessages(watchId);

  const key = storageKey(me.data?.workspaceId);
  const [dismissed, setDismissed] = useState<boolean>(() => readDismissed(key));
  useEffect(() => setDismissed(readDismissed(key)), [key]);

  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(key, "1");
    } catch {
      // private mode etc. — in-memory state still hides it for this session
    }
    setDismissed(true);
  }, [key]);
  const restore = useCallback(() => {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
    setDismissed(false);
  }, [key]);

  const agentRows = agents.data?.agents ?? [];
  const first = agentRows[0] ?? null;
  const agentMemberIds = useMemo(
    () => new Set((dir.data?.agents ?? []).map((a) => a.memberId)),
    [dir.data],
  );
  const humans = dir.data?.humans ?? [];

  const agentReplied = (msgs.messages ?? []).some((m) => agentMemberIds.has(m.memberId));
  const hasTask = (tasks.data?.tasks ?? []).length > 0;

  const agentStatus = first
    ? first.status === "provisioning"
      ? `@${first.handle} is starting — first boot pulls the runtime image and can take a few minutes`
      : first.status === "paused"
        ? `@${first.handle} is paused — resume it from its profile`
        : `@${first.handle} is connected`
    : undefined;

  const steps: OnboardingStep[] = [
    {
      id: "agent",
      title: "Add an agent",
      why: "Agents are members here, not bots: they have a handle, a role, and they read the same channels you do.",
      done: agentRows.length > 0,
      status: agentStatus,
    },
    {
      id: "hello",
      title: first ? `Say hello to @${first.handle}` : "Say hello to your agent",
      why: "Agents reply when @-mentioned or DM'd. Ask what it can do — it will tell you in its own words.",
      done: agentReplied,
    },
    {
      id: "task",
      title: "Give it a task on the Board",
      why: "The Board is the work queue. Assign a card to an agent; it picks it up on its next beat, works in its own sandbox, and attaches the deliverable to the card.",
      done: hasTask,
    },
    {
      id: "invite",
      title: "Invite a teammate",
      why: "Humans and agents sit in the same channels. Invites go out from Members; teammates see the same history.",
      done: humans.length > 1,
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const ready = !agents.isLoading && !dir.isLoading && !tasks.isLoading && !convs.isLoading && !msgs.isLoading;

  return {
    ready,
    steps,
    doneCount,
    complete: doneCount === steps.length,
    dismissed: dismissed || spectator,
    dismiss,
    restore,
    agent: first ? { handle: first.handle, name: first.name, status: first.status } : null,
    firstChannelId,
    fresh: !agentReplied,
  };
}
