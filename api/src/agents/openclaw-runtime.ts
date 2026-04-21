// Centralised "how to invoke openclaw" for the circlechat install/bridge paths.
// Mirrors hermes-runtime.ts but for the alpine/openclaw image. Only docker
// runtime is supported — the host-installed openclaw CLI is not a deployment
// target for circlechat.

export const OPENCLAW_IMAGE =
  process.env.CC_OPENCLAW_IMAGE ?? "alpine/openclaw:latest";

// Mount point for the per-agent state dir inside the container. alpine/openclaw
// resolves all state under ~/.openclaw for the `node` user; running as root
// (0:0) we mount /root/.openclaw so `openclaw` finds its config there.
export const CONTAINER_OPENCLAW_HOME = "/root/.openclaw";

export interface OpenClawCommand {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

// Build the argv for a single openclaw subcommand against a per-agent host
// state dir. The entrypoint is overridden to `openclaw` directly so we can
// invoke subcommands like `onboard`, `mcp set`, `agent --local`.
//
// `--user 0:0` is required because the image's default USER is `node` (uid
// 1000), which can't create /root/... state.
export function buildOpenClawCommand(
  openclawHome: string,
  subArgs: string[],
): OpenClawCommand {
  return {
    cmd: "docker",
    args: [
      "run",
      "--rm",
      "-i",
      "--user",
      "0:0",
      "--network=host",
      "-v",
      `${openclawHome}:${CONTAINER_OPENCLAW_HOME}`,
      "--entrypoint",
      "openclaw",
      OPENCLAW_IMAGE,
      ...subArgs,
    ],
    env: process.env,
  };
}
