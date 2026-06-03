import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { X, Pencil } from "lucide-react";
import { useBus } from "../state/store";
import { api } from "../api/client";
import Avatar from "./Avatar";
import { usePaneResize } from "../lib/usePaneResize";
import { AssignDialog, type OrgNode } from "../pages/Org";

export default function MemberDetailsPanel() {
  const memberId = useBus((s) => s.detailsMemberId);
  const close = useBus((s) => s.closeDetails);
  const dir = useBus((s) => s.directory);
  const presence = useBus((s) => s.presence);
  const width = useBus((s) => s.detailsWidth);
  const setWidth = useBus((s) => s.setDetailsWidth);
  const startResize = usePaneResize(width, setWidth);
  const nav = useNavigate();
  const [assigning, setAssigning] = useState(false);

  // Org tree — used to show & edit who this member reports to.
  const org = useQuery({
    queryKey: ["org"],
    queryFn: () => api.get<{ nodes: OrgNode[] }>("/org"),
    enabled: !!memberId,
  });
  const orgNodes = org.data?.nodes ?? [];
  const orgNode = useMemo(
    () => orgNodes.find((n) => n.memberId === memberId) ?? null,
    [orgNodes, memberId],
  );
  const manager = useMemo(
    () => (orgNode?.reportsTo ? orgNodes.find((n) => n.memberId === orgNode.reportsTo) ?? null : null),
    [orgNodes, orgNode],
  );

  const member = useMemo(() => (memberId ? dir[memberId] : null), [memberId, dir]);
  if (!memberId || !member) return null;
  const isAgent = (member as { kind: string }).kind === "agent";
  const title = (member as { title?: string }).title ?? "";
  const brief = (member as { brief?: string }).brief ?? "";
  const agentKind = (member as { agentKind?: string }).agentKind;
  const status = presence[memberId] ?? (isAgent ? (member as { status?: string }).status ?? "idle" : "offline");
  const email = (member as { email?: string }).email;
  const agentId = (member as { id?: string }).id;
  const handle = (member as { handle: string }).handle;

  return (
    <aside
      className="details-panel"
      style={{ width }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="pane-resize"
        onMouseDown={startResize}
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize"
      />
      <header className="details-head">
        <div className="details-head-title">Profile</div>
        <button onClick={close} className="tb-btn" title="Close"><X size={14} strokeWidth={2} /></button>
      </header>

      <div className="details-body">
        <div className="flex flex-col items-center text-center pt-4 pb-5">
          <Avatar
            name={member.name}
            color={(member as { avatarColor: string }).avatarColor}
            agent={isAgent}
            size="xl"
            status={
              isAgent
                ? status === "working"
                  ? "working"
                  : status === "paused" || status === "error"
                    ? "offline"
                    : "idle"
                : status
            }
          />
          <div className="mt-3 text-[18px] font-semibold">{member.name}</div>
          <div className="text-[12px] font-mono text-[var(--color-muted)] mt-0.5">@{handle}</div>
          {title && <div className="mt-2 text-[13px] text-[var(--color-ink)] max-w-[280px]">{title}</div>}
        </div>

        <div className="details-actions">
          <button onClick={() => { nav(`/d/${memberId}`); close(); }} className="btn sm flex-1 justify-center">
            Message
          </button>
          {isAgent && agentId && (
            <button onClick={() => { nav(`/agents/${agentId}`); close(); }} className="btn sm ghost flex-1 justify-center">
              Agent page
            </button>
          )}
        </div>

        <dl className="details-kv">
          {email && (
            <>
              <dt>Email</dt>
              <dd className="truncate">{email}</dd>
            </>
          )}
          {isAgent && (
            <>
              <dt>Kind</dt>
              <dd className="font-mono text-[12px]">{agentKind ?? "-"}</dd>
              <dt>Status</dt>
              <dd className="font-mono text-[12px]">{status}</dd>
            </>
          )}
          {!isAgent && (
            <>
              <dt>Status</dt>
              <dd className="font-mono text-[12px]">{status}</dd>
            </>
          )}
          <dt>Reports to</dt>
          <dd className="inline-flex items-center gap-1.5 min-w-0">
            <span className="truncate">{manager ? manager.name : "Top of tree"}</span>
            {orgNode && (
              <button
                type="button"
                onClick={() => setAssigning(true)}
                className="tb-btn shrink-0"
                title="Change manager"
              >
                <Pencil size={11} strokeWidth={2} />
              </button>
            )}
          </dd>
        </dl>

        {brief && (
          <div className="mt-5">
            <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono mb-1">Brief</div>
            <p className="text-[13px] leading-relaxed whitespace-pre-wrap">{brief}</p>
          </div>
        )}
      </div>

      {assigning && orgNode && (
        <AssignDialog
          target={orgNode}
          all={orgNodes}
          onClose={() => setAssigning(false)}
        />
      )}
    </aside>
  );
}
