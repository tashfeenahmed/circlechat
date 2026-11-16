// SPDX-License-Identifier: AGPL-3.0-only
// Server-side commands for operators and hosting scripts. Writes to stdout.
//   node server/src/cli.ts export   full data export (tar.gz, see hosting.ts)
//   node server/src/cli.ts backup   database snapshot + agent folders (tar.gz), no vault key
//   node server/src/cli.ts state    {"users":n,"agents":n,"workspace":"..."} as JSON
//   node server/src/cli.ts set-password-hash <email>   new scrypt hash on stdin; signs that person out everywhere
// Uses CIRCLECHAT_DATA like the server. Safe to run while the server is up (SQLite WAL).
import { existsSync, readFileSync, mkdtempSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { App } from "./app.ts";
import { REPO_ROOT } from "./agents/engines.ts";
import { exportWorkspace } from "./hosting.ts";
import { getSetting } from "./db.ts";

const dataDir = resolve(process.env.CIRCLECHAT_DATA ?? join(REPO_ROOT, "data"));
const keyFile = join(dataDir, "master.key");
const masterKey = process.env.CIRCLECHAT_MASTER_KEY ?? (existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : "");
if (!masterKey) {
  console.error(`no vault key at ${keyFile}`);
  process.exit(2);
}
const app = new App({ dataDir, masterKey });
const cmd = process.argv[2];

const pipeTo = (stream: NodeJS.ReadableStream) =>
  new Promise<void>((ok, fail) => {
    stream.on("error", fail);
    stream.on("end", ok);
    stream.pipe(process.stdout);
  });

if (cmd === "export") {
  const out = await exportWorkspace(app);
  await pipeTo(Readable.fromWeb(out.stream as any));
} else if (cmd === "backup") {
  const dir = mkdtempSync(join(tmpdir(), "cc-backup-"));
  try {
    const root = join(dir, "backup");
    mkdirSync(root);
    app.db.exec(`VACUUM INTO '${join(root, "circlechat.db").replace(/'/g, "''")}'`);
    const agents = join(dataDir, "agents");
    if (existsSync(agents)) cpSync(agents, join(root, "agents"), { recursive: true });
    const tar = spawn("tar", ["-czf", "-", "-C", root, "."], { stdio: ["ignore", "pipe", "inherit"] });
    await pipeTo(tar.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else if (cmd === "state") {
  const n = (t: string) => (app.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n;
  process.stdout.write(JSON.stringify({ users: n("users"), agents: n("agents"), workspace: getSetting(app.db, "workspace_name") ?? "" }) + "\n");
} else if (cmd === "set-password-hash") {
  const email = String(process.argv[3] ?? "").toLowerCase();
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const hash = Buffer.concat(chunks).toString("utf8").trim();
  if (!/^scrypt\$[A-Za-z0-9_-]{16,}\$[A-Za-z0-9_-]{32,}$/.test(hash)) {
    console.error("stdin must be an scrypt hash");
    process.exit(2);
  }
  const u = app.db.prepare("SELECT id FROM users WHERE email = ?").get(email) as any;
  if (!u) {
    console.error(`no user ${email}`);
    process.exit(3);
  }
  app.db.prepare("UPDATE users SET pass_hash = ? WHERE id = ?").run(hash, u.id);
  app.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id);
  process.stdout.write("ok\n");
} else {
  console.error("usage: cli.ts export | backup | state | set-password-hash <email>");
  process.exit(2);
}
app.db.close();
