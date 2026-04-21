// Centralised "how to invoke hermes" — either the host binary (legacy) or a
// Docker container pulled from Docker Hub. Both paths must accept the same
// per-agent HERMES_HOME and produce identical on-disk layout.

export type HermesRuntime = "host" | "docker";

export const HERMES_RUNTIME: HermesRuntime =
  (process.env.CC_HERMES_RUNTIME as HermesRuntime) === "host" ? "host" : "docker";

export const HERMES_IMAGE = process.env.CC_HERMES_IMAGE ?? "nousresearch/hermes-agent:latest";

// Path to HERMES_HOME as seen INSIDE the container. The container's
// entrypoint (nousresearch/hermes-agent) defaults to /opt/data and bootstraps
// config files there. We bind-mount the host's per-agent home to this path.
export const CONTAINER_HERMES_HOME = "/opt/data";

export interface HermesCommand {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

// Build the command line for `hermes <subcommand...>` against a specific
// per-agent HERMES_HOME. In docker mode, optional `extraMounts` are appended
// to the `docker run -v …` list — used for exposing the MCP stdio script
// into the container's filesystem when it lives outside HERMES_HOME.
export function buildHermesCommand(
  hermesHome: string,
  subArgs: string[],
  extraMounts: Array<{ host: string; container: string; readOnly?: boolean }> = [],
): HermesCommand {
  if (HERMES_RUNTIME === "host") {
    return {
      cmd: "hermes",
      args: subArgs,
      env: { ...process.env, HERMES_HOME: hermesHome },
    };
  }
  const mounts: string[] = ["-v", `${hermesHome}:${CONTAINER_HERMES_HOME}`];
  for (const m of extraMounts) {
    mounts.push("-v", `${m.host}:${m.container}${m.readOnly ? ":ro" : ""}`);
  }
  return {
    cmd: "docker",
    args: [
      "run",
      "--rm",
      // `-i` forwards stdin so interactive prompts (e.g. `hermes mcp add`
      // asking "enable tool? y/N") can be answered from the caller.
      "-i",
      "--network=host",
      ...mounts,
      HERMES_IMAGE,
      ...subArgs,
    ],
    env: process.env,
  };
}

// What path should be passed to `hermes mcp add --args …` so the stdio server
// is reachable by the running agent? Under docker, the MCP script lives at
// <hermesHome>/circlechat-mcp.mjs on the host, which maps to /opt/data/…
// inside the container. Under host, absolute host path works directly.
export function mcpScriptPathForRegistration(hermesHome: string, hostScriptPath: string): string {
  if (HERMES_RUNTIME === "host") return hostScriptPath;
  // Caller is responsible for placing the script at <hermesHome>/<basename>.
  const basename = hostScriptPath.split(/[\\/]/).pop() ?? "circlechat-mcp.mjs";
  return `${CONTAINER_HERMES_HOME}/${basename}`;
}
