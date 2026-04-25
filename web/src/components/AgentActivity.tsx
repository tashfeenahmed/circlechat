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

const FAILURE_LABELS: Record<string, string> = {
  heartbeat_leaked: "tried to reply with silence sentinel",
  tool_use_markup: "leaked tool-call markup",
  tool_call_json: "pasted a tool call as text",
  function_call_json: "pasted a function call as text",
  action_json_leaked: "pasted an <actions> entry as text",
  curl_transcript: "pasted a curl transcript",
  bearer_token_leak: "leaked its auth token",
  pure_json_dump: "returned a raw JSON dump",
  history_format_echo: "echoed the prompt format",
  runaway_repetition: "got stuck in a repetition loop",
  empty_body: "returned an empty reply",
  python_traceback: "crashed with a python traceback",
  gateway_error_echo: "passed through an LLM-gateway error",
  assistant_refusal: "hallucinated an assistant refusal",
  meta_narration: "narrated the action instead of doing it",
  done_requires_evidence: "tried to mark task done without evidence",
};
function humanizeError(err: string): string {
  // Errors look like "post_message rejected: reason" or "create_task: reason"
  const m = err.match(/^([a-z_]+)(?:\s*rejected)?:\s*([a-z_]+)/i);
  if (m) {
    const reason = m[2];
    return FAILURE_LABELS[reason] ?? `blocked (${reason})`;
  }
  return err.length > 80 ? err.slice(0, 77) + "…" : err;
}

export default function AgentActivity({ conversationId }: Props) {
  const runs = useBus((s) => s.agentRuns);
  const failures = useBus((s) => s.recentFailures);
  const dir = useBus((s) => s.directory);
  // Only show pills for runs that plausibly haven't finished yet. Hermes's
  // hard timeout is 180s; anything older is almost certainly a stale pill
  // from a missed `agent.run.finished` WS frame.
  const active = Object.values(runs).filter((r) => Date.now() - r.startedAt < 180_000);
  // Failures for this conversation (or global, unscoped). Global failures are
  // rare but happen for scheduled / ambient runs; show them in every open
  // channel so the user notices.
  const myFailures = failures.filter(
    (f) => f.conversationId === conversationId || f.conversationId == null,
  );
  const [, tick] = useState(0);

  useEffect(() => {
    if (active.length === 0 && myFailures.length === 0) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active.length, myFailures.length]);

  if (active.length === 0 && myFailures.length === 0) return null;
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
          <span key={`run-${idx}`} className="thinking-pill">
            <span className="pres agent working" />
            <span>
              <b className="font-medium">{name}</b> is {phase}
            </span>
            <span className="text-[var(--color-muted-2)]">· {secs}s</span>
          </span>
        );
      })}
      {myFailures.map((f) => {
        const dirMatch = Object.values(dir).find(
          (d) =>
            (d as { kind: string; id: string }).kind === "agent" &&
            (d as { id: string }).id === f.agentId,
        ) as { name?: string } | undefined;
        const name = f.agentName ?? dirMatch?.name ?? (f.agentHandle ? `@${f.agentHandle}` : "agent");
        const primary = humanizeError(f.errors[0] ?? "unknown");
        const more = f.errors.length > 1 ? ` (+${f.errors.length - 1} more)` : "";
        return (
          <span key={`fail-${f.runId}`} className="thinking-pill" style={{ color: "var(--color-warn)", borderColor: "currentColor" }}>
            <span>
              ⚠️ <b className="font-medium">{name}</b> {primary}{more}
            </span>
          </span>
        );
      })}
    </div>
  );
}
