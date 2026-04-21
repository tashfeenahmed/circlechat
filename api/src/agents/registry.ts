// In-memory registry of active socket-mode agent connections.
// Single-process for the MVP; add Redis-backed sticky routing if you scale out.

import type { WebSocket } from "ws";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
}

const sockets = new Map<string, WebSocket>();
const pending = new Map<string, Pending>();

export function registerAgentSocket(agentId: string, ws: WebSocket): void {
  const prev = sockets.get(agentId);
  if (prev && prev !== ws) {
    try {
      prev.close();
    } catch {
      // ignore
    }
  }
  sockets.set(agentId, ws);
}

export function unregisterAgentSocket(agentId: string, ws?: WebSocket): void {
  const current = sockets.get(agentId);
  if (ws && current !== ws) return; // a newer connection already replaced this one
  sockets.delete(agentId);
}

export function hasAgentSocket(agentId: string): boolean {
  return sockets.has(agentId);
}

export function resolvePending(correlationId: string, value: unknown): void {
  const p = pending.get(correlationId);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(correlationId);
  p.resolve(value);
}

export async function sendToAgentSocket(
  agentId: string,
  correlationId: string,
  body: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<unknown> {
  const ws = sockets.get(agentId);
  if (!ws) throw new Error("agent_socket_not_connected");

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(correlationId);
      reject(new Error("agent_socket_timeout"));
    }, timeoutMs);
    pending.set(correlationId, { resolve, reject, timer });
    try {
      ws.send(JSON.stringify({ correlation_id: correlationId, ...body }));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(correlationId);
      reject(e);
    }
  });
}
