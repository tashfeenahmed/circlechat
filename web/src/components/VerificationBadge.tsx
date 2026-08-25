import { ShieldCheck, ShieldAlert } from "lucide-react";
import type { TaskVerification } from "../api/client";

// The verification gate's verdict, rendered wherever a task is shown.
//
// Until now the judge wrote its verdict to `task_verifications` and only the
// reviewer AGENT ever read it — a human looking at the board could not tell a
// task that passed the gate from one that was never judged. This is the one
// place that decides how a verdict looks, so the card and the detail rail can
// never drift apart.
//
// Renders NOTHING when there is no verdict. The gate is opt-in (VERIFY_GATE)
// and fails open, so "no verdict" is the normal case on most deployments and
// must not read as a warning.
interface Props {
  verification: TaskVerification | null | undefined;
  size?: "card" | "rail";
}

export default function VerificationBadge({ verification, size = "card" }: Props) {
  if (!verification) return null;
  const passed = verification.verdict === "pass";
  // Score is null for non-rubric methods (the deterministic render gate), so
  // the label degrades to a bare "Verified" rather than "Verified · null".
  const score = verification.score == null ? null : verification.score.toFixed(2);
  const label = passed ? (score ? `Verified · ${score}` : "Verified") : "Verification failed";
  // The rationale is the judge's reason. On the card it's the only way to see
  // it (hover); the rail prints it below.
  const title = verification.rationale
    ? `${label} — ${verification.rationale}`
    : passed
      ? "Passed the verification gate"
      : "Blocked by the verification gate";
  const Icon = passed ? ShieldCheck : ShieldAlert;
  return (
    <span className={`vfy vfy-${size} ${passed ? "pass" : "fail"}`} title={title}>
      <Icon size={size === "rail" ? 12 : 10} strokeWidth={2.2} />
      {label}
    </span>
  );
}
