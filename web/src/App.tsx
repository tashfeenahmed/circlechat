// SPDX-License-Identifier: AGPL-3.0-only
// Sign-in gate, app shell (icon rail) and routes.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type User } from "./api.ts";
import { StoreProvider, useStore, usePath } from "./store.tsx";
import { Icon, UserAv } from "./ui/ui.tsx";
import { Sprite } from "./ui/Sprite.tsx";
import { AuthScreen } from "./screens/Auth.tsx";
import { ChatsScreen } from "./screens/Chats.tsx";
import { NeedsScreen } from "./screens/Needs.tsx";
import { TasksScreen } from "./screens/Tasks.tsx";
import { MemoryScreen } from "./screens/Memory.tsx";
import { PeopleScreen } from "./screens/People.tsx";
import { ProfileScreen, WatchScreen, AddAgentScreen } from "./screens/Agent.tsx";
import { SettingsScreen } from "./screens/Settings.tsx";
import { SearchScreen } from "./screens/Search.tsx";

interface Boot {
  setupNeeded: boolean;
  workspace: string;
  user: User | null;
  version: string;
  hosted?: { signInUrl: string } | null;
}

export function App() {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [err, setErr] = useState("");
  const [path, go] = usePath();
  const load = useCallback(() => {
    api
      .get<Boot>("/api/state")
      .then(setBoot)
      .catch((e) => setErr(e.message));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    const out = () => setBoot((b) => (b ? { ...b, user: null } : b));
    window.addEventListener("cc:signedout", out);
    return () => window.removeEventListener("cc:signedout", out);
  }, []);

  if (err)
    return (
      <div className="empty" style={{ height: "100vh", justifyContent: "center" }}>
        <Icon n="alert" />
        Can't reach the server: {err}
        <button className="btn" onClick={() => location.reload()}>
          Try again
        </button>
      </div>
    );
  if (!boot) return <Sprite />;
  if (!boot.user)
    return (
      <>
        <Sprite />
        <AuthScreen setup={boot.setupNeeded} workspace={boot.workspace} hosted={boot.hosted ?? null} onDone={load} />
      </>
    );
  return (
    <StoreProvider me={boot.user} workspace={boot.workspace} version={boot.version} hosted={!!boot.hosted} path={path} go={go}>
      <Sprite />
      <Routes />
    </StoreProvider>
  );
}

function Routes() {
  const { path, go } = useStore();
  const [p, q] = path.split("?");
  const parts = p.split("/").filter(Boolean);
  const params = new URLSearchParams(q ?? "");
  useEffect(() => {
    if (parts.length === 0) go("/chats", true);
  }, [parts.length, go]);

  const [a, b, c] = parts;
  let rail = "chats";
  let body: ReactNode = null;
  switch (a) {
    case "chats":
      body = <ChatsScreen chatId={b} info={params.get("info") === "1"} />;
      break;
    case "needs":
      rail = "needs";
      body = <NeedsScreen id={b} />;
      break;
    case "tasks":
      rail = "tasks";
      body = <TasksScreen chatId={b} />;
      break;
    case "memory":
      rail = "memory";
      body = <MemoryScreen filter={params.get("f") ?? "team"} scopeId={params.get("id") ?? ""} />;
      break;
    case "integrations": // old links: integrations now live in Settings
      rail = "settings";
      body = <SettingsScreen section={b ?? "apps"} id={c} />;
      break;
    case "people":
      rail = "people";
      body = <PeopleScreen />;
      break;
    case "agents":
      rail = "people";
      if (b === "new") body = <AddAgentScreen />;
      else if (c === "watch") body = <WatchScreen id={b} />;
      else body = <ProfileScreen id={b} />;
      break;
    case "settings":
      rail = "settings";
      body = <SettingsScreen section={b ?? "server"} id={c} />;
      break;
    case "search":
      body = <SearchScreen q={params.get("q") ?? ""} />;
      break;
    default:
      body = <ChatsScreen />;
  }
  return <Shell rail={rail}>{body}</Shell>;
}

function Shell({ rail, children }: { rail: string; children: ReactNode }) {
  const { go, pending, chats, me } = useStore();
  const lowCredits = useLowCredits();
  const [noteHidden, setNoteHidden] = useState(false);
  const unread = chats.filter((c) => c.unread && c.members.some((m) => m.type === "user" && m.id === me.id)).length;
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        go("/search");
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [go]);
  const item = (k: string, icon: string, label: string, to: string, badge = 0) => (
    <a
      className={rail === k ? "on" : ""}
      aria-label={label}
      title={label}
      href={to}
      onClick={(e) => {
        e.preventDefault();
        go(to);
      }}
    >
      <Icon n={icon} size="lg" />
      {badge > 0 && <span className="badge">{badge > 99 ? "99+" : badge}</span>}
    </a>
  );
  return (
    <div className="app-root">
      <RailFrame>
        <span className="logo-mark" style={{ cursor: "pointer" }} onClick={() => go("/chats")} />
        {item("chats", "chat", "Chats", "/chats", unread)}
        {item("needs", "inbox", "Needs you", "/needs", pending.length)}
        {item("tasks", "board", "Tasks", "/tasks")}
        {item("memory", "memory", "Memory", "/memory")}
        {item("people", "users", "People and agents", "/people")}
        <div className="bottom">
          {item("settings", "gear", "Settings", lowCredits ? "/settings/credits" : "/settings/server", lowCredits ? 1 : 0)}
          <span className="me" title={`${me.name} (you)`} onClick={() => go("/settings/server")}>
            <UserAv u={me} size={40} dot />
          </span>
        </div>
      </RailFrame>
      {children}
      {lowCredits && !noteHidden && (
        <div className="credit-note" role="status">
          <span>{lowCredits.empty ? "AI credits are used up." : `AI credits are running low: ${Math.round(lowCredits.usedPct)}% used.`}</span>
          <a href="/settings/credits" onClick={(e) => { e.preventDefault(); go("/settings/credits"); }}>Top up</a>
          <button aria-label="Hide" onClick={() => setNoteHidden(true)}><Icon n="x" size="sm" /></button>
        </div>
      )}
    </div>
  );
}

/** Owners of a hosted workspace: the credits summary when it's low or empty, else null. */
function useLowCredits(): { usedPct: number; empty: boolean } | null {
  const { hosted, me } = useStore();
  const [low, setLow] = useState<{ usedPct: number; empty: boolean } | null>(null);
  useEffect(() => {
    if (!hosted || me.role !== "owner") return;
    const check = () =>
      api
        .get<{ usedPct?: number; low: boolean; empty: boolean }>("/api/hosting/credits")
        .then((c) => setLow(c.low || c.empty ? { usedPct: c.usedPct ?? 80, empty: c.empty } : null))
        .catch(() => {});
    check();
    const t = setInterval(check, 5 * 60_000);
    return () => clearInterval(t);
  }, [hosted, me.role]);
  return low;
}

/** The rail is a fixed 72px column; screens render the rest of the grid. */
function RailFrame({ children }: { children: ReactNode }) {
  return <aside className="rail rail-fixed">{children}</aside>;
}
