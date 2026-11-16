// SPDX-License-Identifier: AGPL-3.0-only
// App-wide state: who I am, agents, people, chats, pending approvals, the live
// websocket, a tiny router and toasts.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type Agent, type Approval, type BusEvent, type Chat, type User } from "./api.ts";

// ---------------------------------------------------------------- router
export function usePath(): [string, (to: string, replace?: boolean) => void] {
  const [path, setPath] = useState(location.pathname + location.search);
  useEffect(() => {
    const on = () => setPath(location.pathname + location.search);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  const go = useCallback((to: string, replace = false) => {
    if (to === location.pathname + location.search) return;
    if (replace) history.replaceState(null, "", to);
    else history.pushState(null, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);
  return [path, go];
}

// ---------------------------------------------------------------- websocket
type Listener = (e: BusEvent) => void;
const listeners = new Set<Listener>();
export function useBus(fn: Listener): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const l: Listener = (e) => ref.current(e);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
}

function useSocket(enabled: boolean, onOpen: () => void): boolean {
  const [up, setUp] = useState(false);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let stop = false;
    let delay = 500;
    let timer: number | undefined;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      ws.onopen = () => {
        delay = 500;
        setUp(true);
        openRef.current();
      };
      ws.onmessage = (m) => {
        let e: BusEvent;
        try {
          e = JSON.parse(String(m.data));
        } catch {
          return;
        }
        for (const l of [...listeners]) l(e);
      };
      ws.onclose = () => {
        setUp(false);
        if (stop) return;
        timer = window.setTimeout(connect, delay);
        delay = Math.min(delay * 2, 10_000);
      };
    };
    connect();
    return () => {
      stop = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [enabled]);
  return up;
}

// ---------------------------------------------------------------- store
interface Store {
  me: User;
  workspace: string;
  version: string;
  agents: Agent[];
  users: User[];
  chats: Chat[];
  pending: Approval[];
  online: boolean;
  path: string;
  go: (to: string, replace?: boolean) => void;
  toast: (msg: string, bad?: boolean) => void;
  fail: (e: unknown) => void;
  agent: (id: string) => Agent | undefined;
  user: (id: string) => User | undefined;
  chat: (id: string) => Chat | undefined;
  reloadAgents: () => Promise<void>;
  reloadUsers: () => Promise<void>;
  reloadChats: () => Promise<void>;
  reloadPending: () => Promise<void>;
  setWorkspace: (w: string) => void;
  upsertAgent: (a: Agent) => void;
  isAdmin: boolean;
  /** hosted by CircleChat Cloud: Settings shows Hosting */
  hosted: boolean;
  isBuilder: boolean;
  openChatId: string;
}
const Ctx = createContext<Store | null>(null);
export const useStore = (): Store => {
  const s = useContext(Ctx);
  if (!s) throw new Error("no store");
  return s;
};

export function StoreProvider(props: { me: User; workspace: string; version: string; hosted?: boolean; children: ReactNode; path: string; go: (to: string, replace?: boolean) => void }) {
  const { me, path, go } = props;
  const [workspace, setWorkspace] = useState(props.workspace);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [pending, setPending] = useState<Approval[]>([]);
  const [toastMsg, setToast] = useState<{ msg: string; bad: boolean } | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const toast = useCallback((msg: string, bad = false) => {
    setToast({ msg, bad });
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), bad ? 4500 : 2400);
  }, []);
  const fail = useCallback((e: unknown) => toast(e instanceof Error ? e.message : String(e), true), [toast]);

  const reloadAgents = useCallback(async () => setAgents((await api.get("/api/agents")).agents), []);
  const reloadUsers = useCallback(async () => setUsers((await api.get("/api/users")).users), []);
  const reloadChats = useCallback(async () => setChats((await api.get("/api/chats")).chats), []);
  const reloadPending = useCallback(async () => setPending((await api.get("/api/approvals?state=pending")).approvals), []);
  const reloadAll = useCallback(() => {
    Promise.all([reloadAgents(), reloadUsers(), reloadChats(), reloadPending()]).catch(fail);
  }, [reloadAgents, reloadUsers, reloadChats, reloadPending, fail]);

  useEffect(reloadAll, [reloadAll]);
  const online = useSocket(true, reloadAll);

  const openChatId = /^\/chats\/([^/?]+)/.exec(path)?.[1] ?? "";
  const openRef = useRef(openChatId);
  openRef.current = openChatId;

  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const chatsRef = useRef(chats);
  chatsRef.current = chats;

  // keep lists live
  const chatReload = useRef<number | undefined>(undefined);
  useBus((e) => {
    if (e.type === "agent_status") setAgents((list) => list.map((a) => (a.id === e.agentId ? { ...a, status: e.status } : a)));
    if (e.type === "approval") {
      setPending((list) => {
        const rest = list.filter((x) => x.id !== e.approval.id);
        return e.approval.state === "pending" ? [e.approval, ...rest] : rest;
      });
      if (e.approval.state === "pending") {
        const a = agentsRef.current.find((x) => x.id === e.approval.agentId);
        notify(a ? `${a.name} needs your OK` : "An agent needs your OK", e.approval.title, () => go(`/needs/${e.approval.id}`));
      }
    }
    if (e.type === "message" || e.type === "chat") {
      clearTimeout(chatReload.current);
      chatReload.current = window.setTimeout(() => reloadChats().catch(() => {}), 250);
    }
    if (e.type === "message" && e.message.authorType === "agent" && e.chatId !== openRef.current) {
      const a = agentsRef.current.find((x) => x.id === e.message.authorId);
      const c = chatsRef.current.find((x) => x.id === e.chatId);
      const isMine = c?.members.some((m) => m.type === "user" && m.id === me.id);
      if (a && isMine) notify(c && c.kind !== "dm" ? `${a.name} in ${c.name}` : a.name, e.message.body.slice(0, 140), () => go(`/chats/${e.chatId}`));
    }
  });

  // Dock badge in the desktop app: approvals waiting plus unread one-to-one chats
  const badge = pending.length + chats.filter((c) => c.kind === "dm" && (c.unread ?? 0) > 0).length;
  useEffect(() => {
    try {
      (window as any).circlechatDesktop?.setBadge?.(badge);
    } catch {
      /* not in the desktop app */
    }
  }, [badge]);

  const value = useMemo<Store>(
    () => ({
      me,
      workspace,
      version: props.version,
      agents,
      users,
      chats,
      pending,
      online,
      path,
      go,
      toast,
      fail,
      agent: (id) => agents.find((a) => a.id === id || a.handle === id),
      user: (id) => users.find((u) => u.id === id),
      chat: (id) => chats.find((c) => c.id === id),
      reloadAgents,
      reloadUsers,
      reloadChats,
      reloadPending,
      setWorkspace,
      upsertAgent: (a) => setAgents((list) => (list.some((x) => x.id === a.id) ? list.map((x) => (x.id === a.id ? a : x)) : [...list, a])),
      isAdmin: me.role === "owner" || me.role === "admin",
      hosted: !!props.hosted,
      isBuilder: me.role !== "member",
      openChatId,
    }),
    [me, workspace, props.version, props.hosted, agents, users, chats, pending, online, path, go, toast, fail, reloadAgents, reloadUsers, reloadChats, reloadPending, openChatId],
  );
  return (
    <Ctx.Provider value={value}>
      {props.children}
      {toastMsg && (
        <div className={"toast" + (toastMsg.bad ? " bad" : "")} role="status" aria-live="polite">
          {toastMsg.msg}
        </div>
      )}
    </Ctx.Provider>
  );
}

// ---------------------------------------------------------------- desktop notifications
function notify(title: string, body: string, onClick: () => void): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body, icon: "/avatars/set/classic-sky.png" });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}
