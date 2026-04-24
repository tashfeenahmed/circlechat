import { Link, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { Hash, Plus, FolderOpen, Network, BookOpen, ShieldAlert, LayoutGrid } from "lucide-react";
import { useConversations, useMe, useMembersDirectory, useApprovals, useTasks } from "../lib/hooks";
import { api, type Conversation, type DirMember } from "../api/client";
import { useQueryClient } from "@tanstack/react-query";
import { useBus } from "../state/store";

export default function Sidebar() {
  const convs = useConversations();
  const dir = useMembersDirectory();
  const me = useMe();
  const approvalsQ = useApprovals();
  const location = useLocation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const presence = useBus((s) => s.presence);
  const pendingApprovals = approvalsQ.data?.approvals.length ?? 0;

  // Board unread: count tasks updated since the user last opened /board.
  // Stored per-workspace in localStorage so it survives refreshes but stays
  // local to this browser. New users with no stored timestamp treat "now"
  // as the baseline so they don't see a giant count on first load.
  const tasksQ = useTasks();
  const workspaceId = me.data?.workspaceId ?? null;
  const [boardLastSeen, setBoardLastSeen] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!workspaceId) return;
    const key = `cc:boardLastSeen:${workspaceId}`;
    const raw = localStorage.getItem(key);
    if (raw && Number.isFinite(Number(raw))) {
      setBoardLastSeen(Number(raw));
    } else {
      const now = Date.now();
      localStorage.setItem(key, String(now));
      setBoardLastSeen(now);
    }
  }, [workspaceId]);
  // When the user navigates to /board, mark everything as seen.
  useEffect(() => {
    if (location.pathname !== "/board" || !workspaceId) return;
    const now = Date.now();
    localStorage.setItem(`cc:boardLastSeen:${workspaceId}`, String(now));
    setBoardLastSeen(now);
  }, [location.pathname, workspaceId]);
  const boardUnread = useMemo(() => {
    if (location.pathname === "/board") return 0;
    const rows = tasksQ.data?.tasks ?? [];
    return rows.filter((t) => Date.parse(t.updatedAt) > boardLastSeen).length;
  }, [tasksQ.data, boardLastSeen, location.pathname]);

  const channels = (convs.data?.conversations ?? []).filter(
    (c) => c.kind === "channel" && !c.archived,
  );
  const existingDms = (convs.data?.conversations ?? []).filter(
    (c) => c.kind === "dm" && !c.archived,
  );

  const dmRows = useMemo(() => {
    if (!me.data) return [];
    const all: DirMember[] = [
      ...((dir.data?.humans ?? []) as DirMember[]),
      ...((dir.data?.agents ?? []) as DirMember[]),
    ];
    const dmByMember = new Map<string, Conversation>();
    for (const c of existingDms) {
      const other = c.memberIds.find((mid) => mid !== me.data!.memberId);
      if (other) dmByMember.set(other, c);
    }
    return all
      .filter((m) => m.memberId !== me.data!.memberId)
      .map((m) => {
        const c = dmByMember.get(m.memberId);
        return {
          memberId: m.memberId,
          name: m.name,
          agent: m.kind === "agent",
          lastMessageAt: c?.lastMessageAt ?? null,
        };
      })
      .sort((a, b) => {
        const ta = a.lastMessageAt ? Date.parse(a.lastMessageAt) : -1;
        const tb = b.lastMessageAt ? Date.parse(b.lastMessageAt) : -1;
        if (ta !== tb) return tb - ta;
        return a.name.localeCompare(b.name);
      });
  }, [dir.data, existingDms, me.data]);

  async function createChannel() {
    if (!newName) return;
    const handle = newName.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
    const res = await api.post<{ id: string }>("/conversations", {
      kind: "channel",
      name: handle,
    });
    await qc.invalidateQueries({ queryKey: ["conversations"] });
    setCreating(false);
    setNewName("");
    nav(`/c/${res.id}`);
  }

  return (
    <aside className="sidebar py-1">
      <div className="sb-head">
        <span>CircleChat</span>
      </div>

      <div className="sb-group">
        <Link
          to="/board"
          className={`sb-item ${location.pathname === "/board" ? "active" : ""} ${boardUnread > 0 ? "unread" : ""}`}
        >
          <span className="sb-glyph">
            <LayoutGrid size={14} strokeWidth={2} />
          </span>
          <span className="sb-name">Board</span>
          {boardUnread > 0 && <span className="sb-badge">{boardUnread}</span>}
        </Link>
        <Link
          to="/files"
          className={`sb-item ${location.pathname === "/files" ? "active" : ""}`}
        >
          <span className="sb-glyph">
            <FolderOpen size={14} strokeWidth={2} />
          </span>
          <span className="sb-name">Files</span>
        </Link>
        <Link
          to="/approvals"
          className={`sb-item ${location.pathname === "/approvals" ? "active" : ""} ${pendingApprovals > 0 ? "unread" : ""}`}
        >
          <span className="sb-glyph">
            <ShieldAlert size={14} strokeWidth={2} />
          </span>
          <span className="sb-name">Approvals</span>
          {pendingApprovals > 0 && (
            <span className="sb-badge mention">{pendingApprovals}</span>
          )}
        </Link>
        <Link
          to="/skills"
          className={`sb-item ${location.pathname.startsWith("/skills") ? "active" : ""}`}
        >
          <span className="sb-glyph">
            <BookOpen size={14} strokeWidth={2} />
          </span>
          <span className="sb-name">Skills</span>
        </Link>
        <Link
          to="/org"
          className={`sb-item ${location.pathname === "/org" ? "active" : ""}`}
        >
          <span className="sb-glyph">
            <Network size={14} strokeWidth={2} />
          </span>
          <span className="sb-name">Org chart</span>
        </Link>
      </div>

      <div className="sb-group">
        <div className="sb-group-head">
          <span>Channels</span>
          <button
            className="sbgh-add"
            title="Create channel"
            onClick={() => setCreating(true)}
          >
            <Plus size={12} strokeWidth={2.2} />
          </button>
        </div>
        {creating && (
          <div className="px-[10px] py-1">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createChannel();
                if (e.key === "Escape") setCreating(false);
              }}
              placeholder="channel-name"
              className="w-full border border-[var(--color-hair-2)] rounded px-2 py-1 text-[12px] font-mono"
            />
          </div>
        )}
        {channels.map((c) => {
          const active = location.pathname === `/c/${c.id}`;
          const unread = !active && (c.unreadCount ?? 0) > 0;
          const mentions = !active ? c.unreadMentions ?? 0 : 0;
          return (
            <Link
              key={c.id}
              to={`/c/${c.id}`}
              className={`sb-item ${active ? "active" : ""} ${unread ? "unread" : ""}`}
            >
              <span className="sb-glyph">
                <Hash size={14} strokeWidth={2} />
              </span>
              <span className="sb-name">{c.name}</span>
              {mentions > 0 ? (
                <span className="sb-badge mention">{mentions}</span>
              ) : unread ? (
                <span className="sb-badge">{c.unreadCount}</span>
              ) : null}
            </Link>
          );
        })}
      </div>

      <div className="sb-group">
        <div className="sb-group-head">
          <span>Direct messages</span>
        </div>
        {me.data && (() => {
          const selfPath = `/d/${me.data.memberId}`;
          const active = location.pathname === selfPath;
          return (
            <Link
              key={me.data.memberId}
              to={selfPath}
              className={`sb-item ${active ? "active" : ""}`}
            >
              <span className="sb-glyph">
                <span className="pres on" />
              </span>
              <span className="sb-name">{me.data.user.name}</span>
              <span className="sb-suffix">you</span>
            </Link>
          );
        })()}
        {dmRows.map((d) => {
          const active = location.pathname === `/d/${d.memberId}`;
          const status = d.agent
            ? presence[d.memberId] === "working"
              ? "working"
              : "idle"
            : presence[d.memberId] === "online"
              ? "online"
              : "offline";
          const dmConv = existingDms.find(
            (c) => c.memberIds.includes(d.memberId) && c.memberIds.includes(me.data?.memberId ?? ""),
          );
          const unread = !active && (dmConv?.unreadCount ?? 0) > 0;
          return (
            <Link
              key={d.memberId}
              to={`/d/${d.memberId}`}
              className={`sb-item ${active ? "active" : ""} ${unread ? "unread" : ""}`}
            >
              <span className="sb-glyph">
                <span
                  className={`pres ${
                    d.agent
                      ? status === "working"
                        ? "agent working"
                        : "agent"
                      : status === "online"
                        ? "on"
                        : "off"
                  }`}
                />
              </span>
              <span className="sb-name">{d.name}</span>
              {d.agent && !unread && <span className="sb-suffix">agent</span>}
              {unread && <span className="sb-badge mention">{dmConv?.unreadCount}</span>}
            </Link>
          );
        })}
        {dmRows.length === 0 && (
          <div className="px-[14px] py-2 text-[12px] text-[var(--color-muted-2)] italic">
            Invite teammates or provision an agent.
          </div>
        )}
      </div>
    </aside>
  );
}
