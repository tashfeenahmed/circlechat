// Deliver human-granted credentials into an agent's runtime environment.
//
// This is the missing half of the approvals flow that turned every
// credential-needing task into a dead end: an agent could ASK for a token via
// request_approval, the human could click approve — and nothing happened,
// because "approve" only ever meant "permission to act", never "here is the
// thing you asked for". Agents then looped forever re-requesting.
//
// Now the human can attach `secrets` ({ENV_NAME: value}) to an approve
// decision. The values are written straight into the agent home's `.env`
// (which the hermes runtime loads on every container spawn) and NEVER touch
// the database, the event stream, or chat — only the env-var NAMES are
// recorded on the approval row so the agent learns what it received.
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { resolveHermesHome } from "../agents/hermes-equip.js";

export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
export const MAX_SECRETS_PER_DECISION = 10;

export async function deliverAgentSecrets(
  agent: { id: string; handle: string },
  secrets: Record<string, string>,
): Promise<string[]> {
  const entries = Object.entries(secrets).filter(([k]) => SECRET_NAME_RE.test(k));
  if (!entries.length) return [];
  const home = await resolveHermesHome(agent.id, agent.handle);
  const envPath = join(home, ".env");
  let existing = "";
  try {
    existing = await fs.readFile(envPath, "utf8");
  } catch {
    /* fresh .env */
  }
  const lines = existing.length ? existing.replace(/\n+$/, "").split("\n") : [];
  for (const [k, v] of entries) {
    // .env files don't support newlines in values; strip rather than corrupt.
    const line = `${k}=${v.replace(/[\r\n]/g, "")}`;
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = line;
    else lines.push(line);
  }
  await fs.writeFile(envPath, lines.join("\n") + "\n", { mode: 0o600 });
  // The agent container runs as the home dir's owner (uid 10000 for hermes) —
  // match ownership so the runtime can read what we just wrote. chown needs
  // root; if it fails, fall back to 0644 so the file is at least readable.
  try {
    const st = await fs.stat(home);
    await fs.chown(envPath, st.uid, st.gid);
    await fs.chmod(envPath, 0o600);
  } catch {
    try {
      await fs.chmod(envPath, 0o644);
    } catch {
      /* best effort */
    }
  }
  return entries.map(([k]) => k);
}
