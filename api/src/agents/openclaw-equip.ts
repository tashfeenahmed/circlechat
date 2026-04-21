import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { join, resolve as pathResolve, basename } from "node:path";
import { buildOpenClawCommand, CONTAINER_OPENCLAW_HOME } from "./openclaw-runtime.js";

const MCP_SCRIPT =
  process.env.CC_MCP_SCRIPT ??
  pathResolve(process.cwd(), "scripts/circlechat-mcp.mjs");
const CC_API_BASE = process.env.CC_API_BASE ?? "http://localhost:3300/api";

// Stage the CircleChat MCP stdio script into the agent's OPENCLAW_HOME and
// register it with `openclaw mcp set`. After this returns the agent can call
// CircleChat tools (post_message, react, search, tasks, …) via MCP.
export async function equipOpenClawAgent(params: {
  openclawHome: string;
  botToken: string;
}): Promise<{ mcpRegistered: boolean; notes: string[] }> {
  const { openclawHome, botToken } = params;
  const notes: string[] = [];

  const scriptName = basename(MCP_SCRIPT);
  const stagedPath = join(openclawHome, scriptName);
  try {
    await fs.copyFile(MCP_SCRIPT, stagedPath);
  } catch (e) {
    notes.push(`mcp script stage failed: ${(e as Error).message.slice(0, 200)}`);
  }

  // Path as visible inside the container.
  const containerScriptPath = `${CONTAINER_OPENCLAW_HOME}/${scriptName}`;
  const mcpJson = JSON.stringify({
    command: "node",
    args: [containerScriptPath, botToken, CC_API_BASE],
  });

  let mcpRegistered = false;
  try {
    const cmd = buildOpenClawCommand(openclawHome, ["mcp", "set", "circlechat", mcpJson]);
    await new Promise<void>((resolve, reject) => {
      const p = spawn(cmd.cmd, cmd.args, { env: cmd.env, timeout: 60_000 });
      let err = "";
      p.stderr.on("data", (d) => (err += d));
      p.on("error", reject);
      p.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`openclaw mcp set exit ${code}: ${err.slice(0, 200)}`));
      });
    });
    mcpRegistered = true;
  } catch (e) {
    notes.push(`mcp set failed: ${(e as Error).message.slice(0, 200)}`);
  }

  return { mcpRegistered, notes };
}
