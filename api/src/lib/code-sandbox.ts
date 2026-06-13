import { spawn } from "node:child_process";

// Sandboxed code execution (CodeAct / OpenHands action-execution server, in the
// safe-by-construction form for this box). Agent code must run NOWHERE near the
// worker (which holds the DB and secrets), so each run is a fresh, hardened,
// throwaway Docker container: no network, read-only rootfs with a small tmpfs
// scratch, non-root, all caps dropped, no-new-privileges, memory/CPU/pid caps,
// and a hard wall-clock timeout (SIGKILL). The code is piped on stdin so
// nothing is mounted. OPT-IN (CC_RUN_CODE=on) and OFF by default — enabling it
// is a deliberate, security-reviewed step.
//
// The api/worker container already has docker.sock (it spawns the hermes agent
// containers), so this reuses that capability — it does not widen the trust
// surface beyond what's already granted.

export type CodeLanguage = "python" | "bash";

export interface CodeResult {
  ok: boolean; // exit 0 and not timed out
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string; // infra error (image missing, docker unavailable)
}

const MAX_OUTPUT = 8000;

export function runCodeEnabled(): boolean {
  return process.env.CC_RUN_CODE === "on";
}
function sandboxImage(): string {
  return process.env.CC_RUNCODE_IMAGE || "python:3.12-slim";
}
function timeoutMs(): number {
  const n = Number(process.env.CC_RUNCODE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 15_000;
}
function memLimit(): string {
  return process.env.CC_RUNCODE_MEM || "256m";
}

// The interpreter argv for a language, reading the program from stdin. null for
// an unsupported language. Pure.
export function interpreterFor(language: string): string[] | null {
  if (language === "python" || language === "py") return ["python3", "-"];
  if (language === "bash" || language === "sh") return ["sh", "-s"];
  return null;
}

// The hardened `docker run` argv (everything before the code, which is piped on
// stdin). Pure + exported so the security posture is unit-tested.
export function buildSandboxArgs(image: string, interpreter: string[], mem: string): string[] {
  return [
    "run",
    "--rm",
    "-i", // keep stdin open so we can pipe the program in
    "--network",
    "none", // no network egress
    "--memory",
    mem,
    "--memory-swap",
    mem, // no swap beyond the memory cap
    "--cpus",
    "1",
    "--pids-limit",
    "128",
    "--read-only", // immutable rootfs
    "--tmpfs",
    "/tmp:size=64m",
    "-w",
    "/tmp",
    "-u",
    "65534:65534", // nobody:nogroup
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-e",
    "HOME=/tmp",
    "-e",
    "PYTHONDONTWRITEBYTECODE=1",
    image,
    ...interpreter,
  ];
}

export function truncateOutput(s: string, max: number = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…(truncated, ${s.length - max} more chars)`;
}

// Run code in the sandbox container. Never throws — infra failures come back as
// { ok:false, error }.
export async function runCodeSandboxed(language: CodeLanguage, code: string): Promise<CodeResult> {
  const interpreter = interpreterFor(language);
  if (!interpreter) {
    return { ok: false, exitCode: null, stdout: "", stderr: "", timedOut: false, error: `unsupported language: ${language}` };
  }
  const args = buildSandboxArgs(sandboxImage(), interpreter, memLimit());
  const ms = timeoutMs();

  return new Promise<CodeResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawn("docker", args, { env: process.env });
    } catch (e) {
      resolve({ ok: false, exitCode: null, stdout: "", stderr: "", timedOut: false, error: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, ms);
    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_OUTPUT * 2) stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_OUTPUT * 2) stderr += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: null, stdout, stderr, timedOut, error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: !timedOut && code === 0,
        exitCode: code,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
        timedOut,
      });
    });
    // Pipe the program in on stdin, then close it.
    try {
      child.stdin.end(code);
    } catch {
      /* child may have already exited */
    }
  });
}

// Render a result into the compact form fed back to the agent next turn.
export function formatCodeResult(language: string, r: CodeResult): string {
  if (r.error) return `run_code (${language}) could not run: ${r.error}`;
  const head = r.timedOut
    ? `run_code (${language}) TIMED OUT`
    : `run_code (${language}) exit=${r.exitCode}`;
  const parts = [head];
  if (r.stdout.trim()) parts.push(`stdout:\n${r.stdout.trim()}`);
  if (r.stderr.trim()) parts.push(`stderr:\n${r.stderr.trim()}`);
  if (!r.stdout.trim() && !r.stderr.trim()) parts.push("(no output)");
  return parts.join("\n");
}
