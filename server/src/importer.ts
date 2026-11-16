// SPDX-License-Identifier: AGPL-3.0-only
// Bring an existing OpenClaw workspace or Hermes home into CircleChat:
// personality + instructions, memories, skills. Nothing is executed.
import { existsSync, readFileSync, readdirSync, statSync, cpSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";

export interface ImportResult {
  kind: "openclaw" | "hermes";
  name: string;
  instructions: string;
  memories: string[];
  skills: string[];
  skillsDir?: string;
}

const read = (p: string) => (existsSync(p) && statSync(p).isFile() ? readFileSync(p, "utf8").slice(0, 20000) : "");

export function inspectAgentFolder(dir: string): ImportResult {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error("folder not found");
  // Hermes keeps a profile under ~/.hermes (or a named profile folder)
  const hermesHome = existsSync(join(dir, ".hermes"))
    ? join(dir, ".hermes")
    : existsSync(join(dir, "config.yaml")) || existsSync(join(dir, "memories"))
      ? dir
      : "";
  if (hermesHome) {
    const soul = read(join(hermesHome, "SOUL.md"));
    const memText = read(join(hermesHome, "memories", "MEMORY.md")) || read(join(hermesHome, "MEMORY.md"));
    const user = read(join(hermesHome, "memories", "USER.md")) || read(join(hermesHome, "USER.md"));
    const skillsDir = join(hermesHome, "skills");
    return {
      kind: "hermes",
      name: nameFrom(soul) || basename(dir).replace(/^\./, ""),
      instructions: [soul, user && `About the people you work with:\n${user}`].filter(Boolean).join("\n\n").trim(),
      memories: bullets(memText),
      skills: listSkills(skillsDir),
      skillsDir: existsSync(skillsDir) ? skillsDir : undefined,
    };
  }
  // OpenClaw workspace: AGENTS.md, SOUL.md, IDENTITY.md, USER.md, MEMORY.md, memory/*.md, skills/
  const markers = ["AGENTS.md", "SOUL.md", "IDENTITY.md"];
  const ws = markers.some((m) => existsSync(join(dir, m))) ? dir : existsSync(join(dir, "workspace")) ? join(dir, "workspace") : "";
  if (!ws) throw new Error("This doesn't look like an OpenClaw workspace or a Hermes home (no SOUL.md, AGENTS.md or config.yaml found).");
  const identity = read(join(ws, "IDENTITY.md"));
  const soul = read(join(ws, "SOUL.md"));
  const agents = read(join(ws, "AGENTS.md"));
  const user = read(join(ws, "USER.md"));
  let mem = bullets(read(join(ws, "MEMORY.md")));
  const memDir = join(ws, "memory");
  if (existsSync(memDir))
    for (const f of readdirSync(memDir)
      .filter((x) => x.endsWith(".md"))
      .slice(-10))
      mem = mem.concat(bullets(read(join(memDir, f))));
  const skillsDir = join(ws, "skills");
  return {
    kind: "openclaw",
    name: nameFrom(identity) || nameFrom(soul) || basename(dir),
    instructions: [soul, agents, user && `About the people you work with:\n${user}`].filter(Boolean).join("\n\n").trim(),
    memories: [...new Set(mem)].slice(0, 200),
    skills: listSkills(skillsDir),
    skillsDir: existsSync(skillsDir) ? skillsDir : undefined,
  };
}

/** Copy skills into the agent's home, where both engines look for them. Only SKILL.md folders. */
export function copySkills(from: string, agentHome: string): number {
  let n = 0;
  for (const s of readdirSync(from)) {
    const src = join(from, s);
    if (!statSync(src).isDirectory() || !existsSync(join(src, "SKILL.md"))) continue;
    for (const dest of [join(agentHome, ".hermes", "skills", s), join(agentHome, "work", "skills", s), join(agentHome, ".agents", "skills", s)]) {
      mkdirSync(join(dest, ".."), { recursive: true });
      cpSync(src, dest, { recursive: true, dereference: false, filter: (p) => !basename(p).startsWith(".env") });
    }
    n++;
  }
  return n;
}

function listSkills(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((s) => existsSync(join(dir, s, "SKILL.md")));
}
function nameFrom(md: string): string {
  const m = md.match(/^\s*(?:-\s*)?\*{0,2}name\*{0,2}\s*[:=]\s*(.+)$/im) ?? md.match(/^#\s+(.+)$/m);
  return m ? m[1].replace(/[*_`]/g, "").trim().slice(0, 40) : "";
}
function bullets(md: string): string[] {
  return md
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
    .filter((l) => l.length > 3 && !l.startsWith("#") && l.length < 500);
}
