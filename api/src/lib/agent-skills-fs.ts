// Filesystem access to an agent's installed skills. Skills live on disk under
// `<agent home>/skills/<name>/DESCRIPTION.md` (Hermes) or
// `<HERMES_HOMES_DIR>/.openclaw-<handle>/skills/...` (OpenClaw), each carrying a
// YAML frontmatter `name` + `description`. This is the same data the Skills
// dashboard shows — and, per the Agent-Skills "progressive disclosure" model,
// the name+description is the intended capability-discovery signal. The goal
// planner reads it to route work; the skills route reads it to render the UI.
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveHermesHome } from "../agents/hermes-equip.js";

const HERMES_HOMES_DIR = process.env.HERMES_HOMES_DIR ?? homedir();

// Both runtimes keep skills under `<home>/skills/`. For Hermes the home is
// resolved from bridge-config.json; for OpenClaw we use the install convention.
export async function resolveAgentSkillsRoot(agent: {
  id: string;
  handle: string;
  kind: string;
}): Promise<string> {
  if (agent.kind === "openclaw") {
    return join(HERMES_HOMES_DIR, `.openclaw-${agent.handle}`, "skills");
  }
  const home = await resolveHermesHome(agent.id, agent.handle);
  return join(home, "skills");
}

export async function safeListDirs(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function safeReadFile(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

// Handle both layouts found in staged skills:
//   flat:   skills/<name>/DESCRIPTION.md              (e.g. circlechat)
//   nested: skills/<name>/<subdir>/DESCRIPTION.md     (e.g. browser/agent-browser)
export async function resolveDescription(root: string, name: string): Promise<string | null> {
  const flat = await safeReadFile(join(root, name, "DESCRIPTION.md"));
  if (flat !== null) return flat;
  try {
    const entries = await fs.readdir(join(root, name), { withFileTypes: true });
    const subs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    for (const sub of subs) {
      const nested = await safeReadFile(join(root, name, sub, "DESCRIPTION.md"));
      if (nested !== null) return nested;
    }
  } catch {
    /* root/name missing */
  }
  return null;
}

// Pull the one-line `description:` out of a DESCRIPTION.md frontmatter block.
export function extractSummary(md: string): string | null {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const desc = fm[1]!.match(/^description:\s*>?\s*\n?((?: {2}.*\n?)+|.*)/m);
  if (!desc) return null;
  return desc[1]!
    .split("\n")
    .map((l) => l.replace(/^\s+/, ""))
    .join(" ")
    .trim()
    .slice(0, 240);
}

export interface AgentSkill {
  name: string;
  summary: string | null;
}

// List EVERY skill the agent's runtime actually loads (not just the
// manifest-managed subset the UI shows) with its description summary — this is
// the full capability surface for routing. Returns [] when the skills root is
// unreachable (e.g. a webhook agent with no local home), so callers fall back
// to title/brief.
export async function listAgentSkills(agent: {
  id: string;
  handle: string;
  kind: string;
}): Promise<AgentSkill[]> {
  const root = await resolveAgentSkillsRoot(agent);
  const dirs = await safeListDirs(root);
  const out: AgentSkill[] = [];
  for (const name of dirs) {
    const md = await resolveDescription(root, name);
    out.push({ name, summary: md ? extractSummary(md) : null });
  }
  return out;
}
