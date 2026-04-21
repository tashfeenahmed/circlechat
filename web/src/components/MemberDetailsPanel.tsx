import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { X, MessageSquare, ExternalLink } from "lucide-react";
import { useBus } from "../state/store";
import Avatar from "./Avatar";
import { usePaneResize } from "../lib/usePaneResize";

export default function MemberDetailsPanel() {
  const memberId = useBus((s) => s.detailsMemberId);
  const close = useBus((s) => s.closeDetails);
  const dir = useBus((s) => s.directory);
  const presence = useBus((s) => s.presence);
  const width = useBus((s) => s.detailsWidth);
  const setWidth = useBus((s) => s.setDetailsWidth);
  const startResize = usePaneResize(width, setWidth);
  const nav = useNavigate();

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
          {isAgent && <span className="tag agent mt-2">agent</span>}
          {title && <div className="mt-2 text-[13px] text-[var(--color-ink)] max-w-[280px]">{title}</div>}
        </div>

        <div className="details-actions">
          <button onClick={() => { nav(`/d/${memberId}`); close(); }} className="btn sm inline-flex items-center gap-1.5 flex-1 justify-center">
            <MessageSquare size={13} strokeWidth={2} /> Message
          </button>
          {isAgent && agentId && (
            <button onClick={() => { nav(`/agents/${agentId}`); close(); }} className="btn sm ghost inline-flex items-center gap-1.5 flex-1 justify-center">
              <ExternalLink size={13} strokeWidth={2} /> Agent page
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
        </dl>

        {brief && (
          <div className="mt-5">
            <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono mb-1">Brief</div>
            <p className="text-[13px] leading-relaxed whitespace-pre-wrap">{brief}</p>
          </div>
        )}
      </div>
    </aside>
  );
}
