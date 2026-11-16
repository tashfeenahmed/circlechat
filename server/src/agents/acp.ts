// SPDX-License-Identifier: AGPL-3.0-only
// Minimal Agent Client Protocol (ACP v1) client: newline-delimited JSON-RPC 2.0
// over a long-lived child process's stdio. One process, many turns.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

export const ACP_PROTOCOL_VERSION = 1;

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}
export interface PermissionRequest {
  sessionId: string;
  toolCall: { toolCallId: string; title?: string; kind?: string; status?: string; rawInput?: unknown; content?: unknown[] };
  options: PermissionOption[];
}
export type PermissionOutcome = { outcome: "cancelled" } | { outcome: "selected"; optionId: string };

export interface AcpHandlers {
  onUpdate(sessionId: string, update: any): void;
  onPermission(req: PermissionRequest): Promise<PermissionOutcome>;
  onStderr?(line: string): void;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  method: string;
  timer?: NodeJS.Timeout;
}

export class AcpError extends Error {
  code?: number;
  data?: unknown;
  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export class AcpConnection extends EventEmitter {
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private buf = "";
  private closed = false;
  agentCapabilities: any = {};
  agentInfo: any = {};

  private proc: ChildProcessWithoutNullStreams;

  private handlers: AcpHandlers;

  constructor(proc: ChildProcessWithoutNullStreams, handlers: AcpHandlers) {
    super();
    this.proc = proc;
    this.handlers = handlers;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    proc.stderr.setEncoding("utf8");
    let errBuf = "";
    proc.stderr.on("data", (c: string) => {
      errBuf += c;
      let i;
      while ((i = errBuf.indexOf("\n")) >= 0) {
        const line = errBuf.slice(0, i);
        errBuf = errBuf.slice(i + 1);
        if (line.trim()) this.handlers.onStderr?.(line);
      }
    });
    proc.on("exit", (code, signal) => this.close(new AcpError(`agent process exited (code ${code}, signal ${signal})`)));
    proc.on("error", (e) => this.close(new AcpError(`agent process error: ${e.message}`)));
    proc.stdin.on("error", () => {});
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private close(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.emit("close", err);
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        // Some CLIs print banners on stdout. Never treat them as protocol.
        this.handlers.onStderr?.(`[stdout] ${line}`);
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: any): void {
    if (msg && "id" in msg && ("result" in msg || "error" in msg) && !("method" in msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new AcpError(msg.error.message ?? "error", msg.error.code, msg.error.data));
      else p.resolve(msg.result);
      return;
    }
    if (msg && typeof msg.method === "string") {
      if ("id" in msg && msg.id !== null && msg.id !== undefined) void this.handleRequest(msg);
      else this.handleNotification(msg);
    }
  }

  private handleNotification(msg: any): void {
    if (msg.method === "session/update") {
      try {
        this.handlers.onUpdate(msg.params?.sessionId, msg.params?.update);
      } catch (e) {
        this.handlers.onStderr?.(`[circlechat] update handler failed: ${(e as Error).message}`);
      }
    }
  }

  private async handleRequest(msg: any): Promise<void> {
    try {
      let result: unknown;
      switch (msg.method) {
        case "session/request_permission":
          result = { outcome: await this.handlers.onPermission(msg.params as PermissionRequest) };
          break;
        default:
          // We advertise no fs/terminal capability: the agent works inside its own sandbox.
          return this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
      }
      this.write({ jsonrpc: "2.0", id: msg.id, result });
    } catch (e) {
      this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: (e as Error).message } });
    }
  }

  private write(obj: unknown): void {
    if (this.closed) return;
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  request<T = any>(method: string, params: unknown, timeoutMs = 0): Promise<T> {
    if (this.closed) return Promise.reject(new AcpError("connection closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { resolve, reject, method };
      if (timeoutMs > 0)
        p.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new AcpError(`${method} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      this.pending.set(id, p);
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  async initialize(): Promise<void> {
    const r = await this.request(
      "initialize",
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "circlechat", version: "2.0.0" },
      },
      120_000,
    );
    this.agentCapabilities = r?.agentCapabilities ?? {};
    this.agentInfo = r?.agentInfo ?? {};
  }

  async newSession(cwd: string, mcpServers: unknown[]): Promise<string> {
    const r = await this.request("session/new", { cwd, mcpServers }, 120_000);
    return r.sessionId;
  }

  async loadSession(sessionId: string, cwd: string, mcpServers: unknown[]): Promise<boolean> {
    if (!this.agentCapabilities?.loadSession) return false;
    try {
      await this.request("session/load", { sessionId, cwd, mcpServers }, 120_000);
      return true;
    } catch {
      return false;
    }
  }

  prompt(sessionId: string, text: string): Promise<{ stopReason: string; usage?: any }> {
    return this.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  }

  cancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
  }
}
