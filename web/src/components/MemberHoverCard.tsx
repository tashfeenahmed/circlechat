import { useRef, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useBus } from "../state/store";
import Avatar from "./Avatar";

interface Props {
  memberId: string;
  children: React.ReactNode;
  className?: string;
}

// Slack-style on-hover profile preview. Wraps a trigger (usually avatar or
// name) and shows a compact card after a short hover delay. Clicking the
// trigger still opens the full details panel via whatever onClick the child
// carries.
export default function MemberHoverCard({ memberId, children, className }: Props) {
  const dir = useBus((s) => s.directory);
  const presence = useBus((s) => s.presence);
  const member = dir[memberId] as
    | {
        name: string;
        handle: string;
        kind: "user" | "agent";
        avatarColor: string;
        title?: string;
        brief?: string;
        status?: string;
      }
    | undefined;

  const wrapRef = useRef<HTMLSpanElement>(null);
  const openT = useRef<number | null>(null);
  const closeT = useRef<number | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; align: "top" | "bottom" } | null>(null);

  useEffect(() => {
    return () => {
      if (openT.current) window.clearTimeout(openT.current);
      if (closeT.current) window.clearTimeout(closeT.current);
    };
  }, []);

  function compute() {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const spaceBelow = vh - r.bottom;
    const cardH = 220;
    const align = spaceBelow < cardH + 16 ? "top" : "bottom";
    const top = align === "bottom" ? r.bottom + 6 : r.top - 6;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - 300);
    setPos({ top, left, align });
  }

  function onEnter() {
    if (closeT.current) {
      window.clearTimeout(closeT.current);
      closeT.current = null;
    }
    if (pos) return;
    openT.current = window.setTimeout(() => {
      compute();
    }, 350);
  }
  function onLeave() {
    if (openT.current) {
      window.clearTimeout(openT.current);
      openT.current = null;
    }
    closeT.current = window.setTimeout(() => setPos(null), 120);
  }

  const isAgent = member?.kind === "agent";
  const status =
    presence[memberId] ?? (isAgent ? member?.status ?? "idle" : "offline");

  const card = pos && member ? (
    <div
      className="hover-card"
      style={{
        position: "fixed",
        top: pos.align === "bottom" ? pos.top : undefined,
        bottom: pos.align === "top" ? window.innerHeight - pos.top : undefined,
        left: pos.left,
      }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className="hc-top">
        <Avatar
          name={member.name}
          color={member.avatarColor}
          agent={isAgent}
          size="lg"
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
        <div className="min-w-0">
          <div className="hc-name">{member.name}</div>
          <div className="hc-handle">@{member.handle}</div>
          <div className="hc-tags">
            <span className="hc-status">{status}</span>
          </div>
        </div>
      </div>
      {member.title && <div className="hc-title">{member.title}</div>}
      {member.brief && <p className="hc-brief">{member.brief}</p>}
      <div className="hc-hint">Click avatar or name for full profile</div>
    </div>
  ) : null;

  return (
    <span
      ref={wrapRef}
      className={className ?? "inline-flex"}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {children}
      {card && createPortal(card, document.body)}
    </span>
  );
}
