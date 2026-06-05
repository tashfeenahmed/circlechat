import { PreviewCard } from "@base-ui/react/preview-card";
import { useBus } from "../state/store";
import Avatar from "./Avatar";

interface Props {
  memberId: string;
  children: React.ReactNode;
  className?: string;
}

// Slack-style on-hover profile preview, on Base UI PreviewCard: hover delays,
// portal, positioning + flipping, and the smooth trigger→card hover handoff
// all come from the library. Wraps a trigger (usually avatar or name);
// clicking the trigger still opens the full details panel via whatever
// onClick the child carries.
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

  if (!member) return <span className={className ?? "inline-flex"}>{children}</span>;

  const isAgent = member.kind === "agent";
  const status = presence[memberId] ?? (isAgent ? member.status ?? "idle" : "offline");

  return (
    <PreviewCard.Root>
      <PreviewCard.Trigger
        delay={350}
        closeDelay={120}
        render={<span className={className ?? "inline-flex"} />}
      >
        {children}
      </PreviewCard.Trigger>
      <PreviewCard.Portal>
        <PreviewCard.Positioner className="cc-z-card" side="bottom" align="start" sideOffset={6} collisionPadding={8}>
          <PreviewCard.Popup className="hover-card">
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
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}
