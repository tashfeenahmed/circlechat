import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  managedSkillsAfterEquip,
  manifestAndQuarantineScript,
  readManifest,
} from "../agents/hermes-equip.js";

// The docker equip used to reset the manifest to ["circlechat","browser"] and
// quarantine every other skill dir, so Re-equip disabled each skill added from
// the Skills UI. These run the real shell half against a temp agent home.
describe("docker equip skill ops", () => {
  let home: string;
  beforeEach(async () => {
    home = await fsp.mkdtemp(join(tmpdir(), "cc-equip-"));
  });
  afterEach(async () => {
    await fsp.rm(home, { recursive: true, force: true });
  });

  const mkSkill = (dir: string, body = "x") =>
    fsp.mkdir(join(home, dir), { recursive: true }).then(() =>
      fsp.writeFile(join(home, dir, "SKILL.md"), body),
    );

  async function equip() {
    const managed = await managedSkillsAfterEquip(join(home, "skills"));
    const script = ["set -e", ...manifestAndQuarantineScript(home)].join("\n");
    execFileSync("bash", ["-c", script, "skill-ops", JSON.stringify(managed, null, 2), ...managed]);
  }

  it("keeps a skill added from the Skills UI and still quarantines bundled ones", async () => {
    for (const s of ["circlechat", "browser", "test", "apple"]) await mkSkill(`skills/${s}`);
    await fsp.writeFile(
      join(home, "skills/.circlechat-managed.json"),
      JSON.stringify(["browser", "circlechat", "test"]),
    );

    await equip();

    expect(await readManifest(join(home, "skills"))).toEqual(["browser", "circlechat", "test"]);
    expect((await fsp.readdir(join(home, "skills"))).sort()).toEqual([
      ".circlechat-managed.json",
      "browser",
      "circlechat",
      "test",
    ]);
    expect(await fsp.readdir(join(home, "skills-disabled"))).toEqual(["apple"]);
  });

  it("first equip with no manifest manages only the two equip skills", async () => {
    await mkSkill("skills/circlechat");
    await mkSkill("skills/web");

    await equip();

    expect(await readManifest(join(home, "skills"))).toEqual(["browser", "circlechat"]);
    expect(await fsp.readdir(join(home, "skills-disabled"))).toEqual(["web"]);
  });

  it("replaces an older quarantined copy instead of nesting into it", async () => {
    await mkSkill("skills/circlechat");
    await mkSkill("skills/web", "new");
    await mkSkill("skills-disabled/web", "old");

    await equip();

    expect(await fsp.readdir(join(home, "skills-disabled/web"))).toEqual(["SKILL.md"]);
    expect(await fsp.readFile(join(home, "skills-disabled/web/SKILL.md"), "utf8")).toBe("new");
  });
});
