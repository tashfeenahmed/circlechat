import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as pathResolve, basename } from "node:path";
import {
  HERMES_RUNTIME,
  HERMES_IMAGE,
  CONTAINER_HERMES_HOME,
  buildHermesCommand,
  mcpScriptPathForRegistration,
} from "./hermes-runtime.js";

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
// Optional second skill: the agent-browser skill docs. Same shape as
// circlechat-skill (a directory containing DESCRIPTION.md). Lives at
// `skills/browser/agent-browser/` on the agent's home dir.
const BROWSER_SKILL_TEMPLATE_DIR =
  process.env.CC_BROWSER_SKILL_TEMPLATE ??
  pathResolve(process.cwd(), "templates/browser-skill");
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
  if (HERMES_RUNTIME === "docker") {
    // The hermes image's entrypoint has already chown'd skills/ to uid=10000.
    // Do the copy + manifest + quarantine via docker bash so we act as root
    // inside the container on the mounted volume.
    try {
      await runSkillOpsViaDocker(hermesHome);
      skillInstalled = true;
    } catch (e) {
      notes.push(`skill ops (docker) failed: ${(e as Error).message.slice(0, 200)}`);
    }
  } else {
    try {
      await fs.mkdir(skillDest, { recursive: true });
      await copyDir(SKILL_TEMPLATE_DIR, skillDest);
      skillInstalled = true;
    } catch (e) {
      notes.push(`skill copy failed: ${(e as Error).message.slice(0, 200)}`);
    }
    // Also stage the agent-browser skill. Non-fatal if it's missing so older
    // deploys without the template still work.
    try {
      const browserDest = join(skillsRoot, "browser", "agent-browser");
      await fs.mkdir(browserDest, { recursive: true });
      await copyDir(BROWSER_SKILL_TEMPLATE_DIR, browserDest);
    } catch (e) {
      notes.push(`browser skill copy failed: ${(e as Error).message.slice(0, 200)}`);
    }
    try {
      await addToManifest(skillsRoot, "circlechat");
      await addToManifest(skillsRoot, "browser");
    } catch (e) {
      notes.push(`manifest write failed: ${(e as Error).message.slice(0, 200)}`);
    }
    try {
      const quarantined = await quarantineBundledSkills(hermesHome);
      if (quarantined.length) notes.push(`quarantined ${quarantined.length} bundled skill(s)`);
    } catch (e) {
      notes.push(`quarantine failed: ${(e as Error).message.slice(0, 200)}`);
    }
  }

  // In docker mode we must stage the MCP stdio script inside HERMES_HOME so
  // that the containerised hermes process can spawn it — `/opt/cc-scripts/…`
  // from the CircleChat host isn't visible inside the container.
  let mcpScriptForRegistration = MCP_SCRIPT;
  if (HERMES_RUNTIME === "docker") {
    const stagedPath = join(hermesHome, basename(MCP_SCRIPT));
    try {
      await fs.copyFile(MCP_SCRIPT, stagedPath);
    } catch (e) {
      notes.push(`mcp script stage failed: ${(e as Error).message.slice(0, 200)}`);
    }
    mcpScriptForRegistration = mcpScriptPathForRegistration(hermesHome, MCP_SCRIPT);
  }

  let mcpRegistered = false;
  try {
    // Remove any stale registration first — `hermes mcp add` is create-only.
    const removeCmd = buildHermesCommand(hermesHome, ["mcp", "remove", "circlechat"]);
    await runSilentRaw(removeCmd.cmd, removeCmd.args, removeCmd.env);
    // Hermes's --args is a single nargs-list flag, not repeatable. Pass every
    // value in one go: `--args <script> <token> <api_base>`. The CLI also
    // prompts interactively to confirm the tool-enablement — pipe `y` to it
    // so this runs headless.
    const addCmd = buildHermesCommand(hermesHome, [
      "mcp",
      "add",
      "circlechat",
      "--command",
      "node",
      "--args",
      mcpScriptForRegistration,
      botToken,
      CC_API_BASE,
    ]);
    await runStrictRaw(addCmd.cmd, addCmd.args, addCmd.env, "y\n");
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

// Do the skill copy + manifest + quarantine inside a throw-away container so
// we act as root on the mounted volume — host-side `fs.copyFile` can't write
// into skills/ after the hermes image's entrypoint has chown'd it to uid=10000.
async function runSkillOpsViaDocker(hermesHome: string): Promise<void> {
  // Bind-mount both skill templates read-only. The `browser` dir is copied
  // only when the host actually has the template staged — during an old
  // deploy that predates browser-skill this path is silently skipped.
  const script = [
    "set -e",
    `mkdir -p "${CONTAINER_HERMES_HOME}/skills/circlechat"`,
    `rm -rf "${CONTAINER_HERMES_HOME}/skills/circlechat/"*`,
    `cp -r /cc-skill-template/. "${CONTAINER_HERMES_HOME}/skills/circlechat/"`,
    `if [ -d /cc-browser-skill-template ]; then`,
    `  mkdir -p "${CONTAINER_HERMES_HOME}/skills/browser/agent-browser"`,
    `  rm -rf "${CONTAINER_HERMES_HOME}/skills/browser/agent-browser/"*`,
    `  cp -r /cc-browser-skill-template/. "${CONTAINER_HERMES_HOME}/skills/browser/agent-browser/"`,
    `fi`,
    // Manifest lists both so future updates can find them.
    `echo '["circlechat","browser"]' > "${CONTAINER_HERMES_HOME}/skills/.circlechat-managed.json"`,
    // Quarantine everything except circlechat, browser, and dotfiles.
    `mkdir -p "${CONTAINER_HERMES_HOME}/skills-disabled"`,
    `for d in "${CONTAINER_HERMES_HOME}"/skills/*/; do`,
    `  n=$(basename "$d")`,
    `  case "$n" in circlechat|browser|.*) continue ;; esac`,
    `  mv "$d" "${CONTAINER_HERMES_HOME}/skills-disabled/$n" 2>/dev/null || true`,
    `done`,
  ].join("\n");
  await new Promise<void>((resolve, reject) => {
    const args = [
      "run",
      "--rm",
      "-v",
      `${hermesHome}:${CONTAINER_HERMES_HOME}`,
      "-v",
      `${SKILL_TEMPLATE_DIR}:/cc-skill-template:ro`,
      "-v",
      `${BROWSER_SKILL_TEMPLATE_DIR}:/cc-browser-skill-template:ro`,
      "--entrypoint",
      "bash",
      HERMES_IMAGE,
      "-c",
      script,
    ];
    const p = spawn("docker", args, { env: process.env, timeout: 60_000 });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker skill-ops exit ${code}: ${err.slice(0, 200)}`));
    });
  });
}

// Raw spawn helpers — env + args are expected to be fully built by the
// caller (usually via buildHermesCommand so the host/docker runtime switch
// is centralised).
function runStrictRaw(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stdinInput?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      env,
      // Docker pulls + image sync can easily exceed 45s the first time an
      // image runs on a host.
      timeout: 180_000,
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
function runSilentRaw(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env, timeout: 30_000 });
    p.on("error", () => resolve());
    p.on("close", () => resolve());
  });
}
