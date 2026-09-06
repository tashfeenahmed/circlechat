// An agent's `brief` is the one-line job description humans read in the member
// directory, on the org chart and on the agent's profile. It is NOT the agent's
// instructions — those live in the skill templates. Briefs that described the
// harness ("Reads the channels I belong to… on scheduled beats", "writes to
// /workspace and shares via share_to_task", "posts to #build-log") were being
// shown to visitors on the public demo as if they were job titles.

import { applyProseRewrites } from "../agents/reply-guard.js";

// Used when a caller creates an agent without supplying one.
export const DEFAULT_AGENT_BRIEF =
  "Answers questions in the channels they are in, picks up work from the board, and shares what changed.";

// Strip runtime vocabulary / container paths / dev ports out of a supplied
// brief and fall back to the default when nothing readable is left. Same
// rewrite table as agent prose, so a brief and a chat message read alike.
export function normalizeAgentBrief(brief: string | undefined | null): string {
  const raw = (brief ?? "").trim();
  if (!raw) return DEFAULT_AGENT_BRIEF;
  const cleaned = applyProseRewrites(raw).replace(/[ \t]{2,}/g, " ").trim();
  return cleaned || DEFAULT_AGENT_BRIEF;
}
