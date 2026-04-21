import { useEffect, useState } from "react";
import { useBus } from "../state/store";

interface Props {
  conversationId: string;
}

const LABELS: Record<string, string> = {
  mention: "drafting a reply",
  dm: "replying to you",
  scheduled: "checking the channel for anything relevant",
  assigned: "picking up work",
  approval_response: "acting on your approval",
  test: "running a test heartbeat",
};

function phaseFromElapsed(ms: number, trigger: string): string {
  // Rough phases — not authoritative, but gives the user a sense of progress.
  if (ms < 1200) return "reading the thread";
  if (ms < 3500) return LABELS[trigger] ?? "working";
  if (ms < 12_000) return "thinking";
  if (ms < 30_000) return "still thinking (long answer)";
  return "running tools / waiting on model";
}

export default function AgentActivity({ conversationId }: Props) {
  const runs = useBus((s) => s.agentRuns);
  const dir = useBus((s) => s.directory);
  // Only show pills for runs that plausibly haven't finished yet. Hermes's
  // hard timeout is 180s; anything older is almost certainly a stale pill
  // from a missed `agent.run.finished` WS frame.
  const active = Object.values(runs).filter((r) => Date.now() - r.startedAt < 180_000);
  const [, tick] = useState(0);
  void conversationId;

  useEffect(() => {
    if (active.length === 0) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active.length]);

  if (active.length === 0) return null;
  const now = Date.now();
  return (
    <div className="px-6 pb-1 flex flex-wrap gap-2">
      {active.map((r, idx) => {
        // Prefer the name stashed on the bus entry (server includes it on the
        // `agent.run.started` frame). Fall back to the directory lookup for
        // agents whose events pre-date the dir being ready.
        const dirMatch = Object.values(dir).find(
          (d) =>
            (d as { kind: string; id: string }).kind === "agent" &&
            (d as { id: string }).id === r.agentId,
        ) as { name?: string } | undefined;
        const name = r.agentName ?? dirMatch?.name ?? (r.agentHandle ? `@${r.agentHandle}` : "agent");
        const elapsed = now - r.startedAt;
        const phase = phaseFromElapsed(elapsed, r.trigger);
        const secs = Math.floor(elapsed / 1000);
        return (
          <span key={idx} className="thinking-pill">
            <span className="pres agent working" />
            <span>
              <b className="font-medium">{name}</b> is {phase}
            </span>
            <span className="text-[var(--color-muted-2)]">· {secs}s</span>
          </span>
        );
      })}
    </div>
  );
}
