import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as pathResolve } from "node:path";

const HERMES_HOMES_DIR = process.env.HERMES_HOMES_DIR ?? homedir();
const BRIDGE_CONFIG_PATH =
  process.env.CC_BRIDGE_CONFIG_PATH ?? pathResolve(process.cwd(), "bridge-config.json");

// Returns the actual HERMES_HOME for an agent. Prefers the path recorded in
// bridge-config.json (authoritative: it's what the running multi-bridge spawns
// against); falls back to the <homes>/.hermes-<handle> convention.
export async function resolveHermesHome(
  agentId: string,
  handle: string,
): Promise<string> {
  try {
    const raw = await fs.readFile(BRIDGE_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Array<{ agentId?: string; hermesHome?: string }>;
    if (Array.isArray(parsed)) {
      const entry = parsed.find(
        (e) => e.agentId === agentId && typeof e.hermesHome === "string",
      );
      if (entry?.hermesHome) return entry.hermesHome;
    }
  } catch { /* fall through */ }
  return join(HERMES_HOMES_DIR, `.hermes-${handle}`);
}

// Paths (overridable via env for alternate deployments).
const SKILL_TEMPLATE_DIR =
  process.env.CC_SKILL_TEMPLATE ??
  pathResolve(process.cwd(), "templates/circlechat-skill");
const MCP_SCRIPT =
  process.env.CC_MCP_SCRIPT ??
  pathResolve(process.cwd(), "scripts/circlechat-mcp.mjs");

// What CircleChat's MCP server knows the API base as. Hermes only passes argv
// strings, not env, to stdio servers — so we bake this in.
const CC_API_BASE = process.env.CC_API_BASE ?? "http://localhost:3300/api";

// Copy the baked `circlechat` skill into HERMES_HOME/skills/circlechat/ and
// register the circlechat MCP server in that home's config.
//
// Idempotent: running twice just overwrites. Non-fatal if hermes CLI isn't on
// PATH (logs warning and returns false so the caller can surface it).
export async function installCircleChatTooling(params: {
  hermesHome: string;
  botToken: string;
}): Promise<{ skillInstalled: boolean; mcpRegistered: boolean; notes: string[] }> {
  const { hermesHome, botToken } = params;
  const notes: string[] = [];

  const skillsRoot = join(hermesHome, "skills");
  const skillDest = join(skillsRoot, "circlechat");
  let skillInstalled = false;
  try {
    await fs.mkdir(skillDest, { recursive: true });
    await copyDir(SKILL_TEMPLATE_DIR, skillDest);
    skillInstalled = true;
  } catch (e) {
    notes.push(`skill copy failed: ${(e as Error).message.slice(0, 200)}`);
  }

  // Manifest of CircleChat-managed skills. The Skills UI uses this to filter
  // out the bundled Hermes skill pack (apple/creative/devops/…) and show only
  // what we installed + what the user added through the UI.
  try {
    await addToManifest(skillsRoot, "circlechat");
  } catch (e) {
    notes.push(`manifest write failed: ${(e as Error).message.slice(0, 200)}`);
  }

  // Quarantine the bundled skill pack (apple/devops/songwriting/…) — the
  // CC-equipped agent shouldn't reach for them. Only runs against a
  // CC-provisioned HERMES_HOME (matching `.hermes-<handle>`) so we don't
  // touch the operator's personal ~/.hermes install.
  try {
    const quarantined = await quarantineBundledSkills(hermesHome);
    if (quarantined.length) notes.push(`quarantined ${quarantined.length} bundled skill(s)`);
  } catch (e) {
    notes.push(`quarantine failed: ${(e as Error).message.slice(0, 200)}`);
  }

  let mcpRegistered = false;
  try {
    // Remove any stale registration first — `hermes mcp add` is create-only.
    await runSilent("hermes", ["mcp", "remove", "circlechat"], hermesHome);
    // Hermes's --args is a single nargs-list flag, not repeatable. Pass every
    // value in one go: `--args <script> <token> <api_base>`. The CLI also
    // prompts interactively to confirm the tool-enablement — pipe `y` to it
    // so this runs headless.
    await runStrict(
      "hermes",
      [
        "mcp",
        "add",
        "circlechat",
        "--command",
        "node",
        "--args",
        MCP_SCRIPT,
        botToken,
        CC_API_BASE,
      ],
      hermesHome,
      "y\n",
    );
    mcpRegistered = true;
  } catch (e) {
    notes.push(`mcp add failed: ${(e as Error).message.slice(0, 200)}`);
  }

  return { skillInstalled, mcpRegistered, notes };
}

const MANIFEST_NAME = ".circlechat-managed.json";

export async function readManifest(skillsRoot: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(join(skillsRoot, MANIFEST_NAME), "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) return parsed;
  } catch { /* missing / malformed — return empty */ }
  return [];
}

export async function addToManifest(skillsRoot: string, name: string): Promise<void> {
  await fs.mkdir(skillsRoot, { recursive: true });
  const current = await readManifest(skillsRoot);
  if (current.includes(name)) return;
  const next = [...current, name].sort();
  await fs.writeFile(join(skillsRoot, MANIFEST_NAME), JSON.stringify(next, null, 2));
}

export async function removeFromManifest(skillsRoot: string, name: string): Promise<void> {
  const current = await readManifest(skillsRoot);
  if (!current.includes(name)) return;
  const next = current.filter((n) => n !== name);
  await fs.writeFile(join(skillsRoot, MANIFEST_NAME), JSON.stringify(next, null, 2));
}

// Move every non-manifest skill dir inside hermesHome/skills into
// hermesHome/skills-disabled/. Safety: only runs when hermesHome looks like
// a CC-provisioned path (.hermes-<handle>) OR the env force flag is set.
// Returns the names of skills that were moved.
export async function quarantineBundledSkills(hermesHome: string): Promise<string[]> {
  const force = process.env.CC_FORCE_QUARANTINE_BUNDLED_SKILLS === "1";
  const base = hermesHome.split(/[\\/]/).pop() ?? "";
  const looksCcManaged = /^\.hermes-[a-z0-9][a-z0-9._-]*$/i.test(base);
  if (!force && !looksCcManaged) return [];

  const skillsRoot = join(hermesHome, "skills");
  const disabledRoot = join(hermesHome, "skills-disabled");
  let entries: { name: string; isDir: boolean }[];
  try {
    const raw = await fs.readdir(skillsRoot, { withFileTypes: true });
    entries = raw.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return [];
  }
  const managed = new Set(await readManifest(skillsRoot));
  // The skill we just copied in is always "circlechat" — keep it even if the
  // manifest write raced.
  managed.add("circlechat");

  await fs.mkdir(disabledRoot, { recursive: true });
  const moved: string[] = [];
  for (const e of entries) {
    if (!e.isDir) continue;
    if (e.name.startsWith(".")) continue;
    if (managed.has(e.name)) continue;
    const from = join(skillsRoot, e.name);
    const to = join(disabledRoot, e.name);
    try {
      await fs.rm(to, { recursive: true, force: true });
      await fs.rename(from, to);
      moved.push(e.name);
    } catch {
      // Best-effort; next boot of the bridge won't re-spawn this skill anyway
      // since Hermes only loads what's inside skills/.
    }
  }
  return moved;
}

// Restore every quarantined skill back into skills/. Used by the admin
// endpoint to undo a quarantine if the agent is missing a capability.
export async function restoreQuarantinedSkills(hermesHome: string): Promise<string[]> {
  const skillsRoot = join(hermesHome, "skills");
  const disabledRoot = join(hermesHome, "skills-disabled");
  let entries: { name: string; isDir: boolean }[];
  try {
    const raw = await fs.readdir(disabledRoot, { withFileTypes: true });
    entries = raw.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return [];
  }
  await fs.mkdir(skillsRoot, { recursive: true });
  const restored: string[] = [];
  for (const e of entries) {
    if (!e.isDir) continue;
    const from = join(disabledRoot, e.name);
    const to = join(skillsRoot, e.name);
    try {
      await fs.rm(to, { recursive: true, force: true });
      await fs.rename(from, to);
      restored.push(e.name);
    } catch {
      // skip
    }
  }
  return restored;
}

async function copyDir(src: string, dest: string): Promise<void> {
  const entries = await fs.readdir(src, { withFileTypes: true });
  await fs.mkdir(dest, { recursive: true });
  for (const e of entries) {
    const s = join(src, e.name);
    const d = join(dest, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else if (e.isFile()) await fs.copyFile(s, d);
  }
}

function runStrict(
  cmd: string,
  args: string[],
  hermesHome: string,
  stdinInput?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      env: { ...process.env, HERMES_HOME: hermesHome },
      timeout: 45_000,
    });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.slice(0, 3).join(" ")} exit ${code}: ${err.slice(0, 200)}`));
    });
    if (stdinInput) {
      p.stdin.write(stdinInput);
      p.stdin.end();
    } else {
      p.stdin.end();
    }
  });
}
function runSilent(cmd: string, args: string[], hermesHome: string): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, {
      env: { ...process.env, HERMES_HOME: hermesHome },
      timeout: 10_000,
    });
    p.on("error", () => resolve());
    p.on("close", () => resolve());
  });
}
