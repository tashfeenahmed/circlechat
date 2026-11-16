// SPDX-License-Identifier: AGPL-3.0-only
// In-process event bus. The websocket layer forwards these to browsers.
import { EventEmitter } from "node:events";

export type BusEvent =
  | { type: "message"; chatId: string; message: unknown }
  | { type: "message_updated"; chatId: string; message: unknown }
  | { type: "agent_status"; agentId: string; status: AgentStatus }
  | { type: "agent_activity"; agentId: string; chatId: string; entry: ActivityEntry; append?: boolean }
  | { type: "typing"; chatId: string; agentId: string; on: boolean }
  | { type: "approval"; approval: unknown }
  | { type: "task"; chatId: string; task: unknown }
  | { type: "memory"; memory: unknown }
  | { type: "chat"; chat: unknown }
  | { type: "delivery"; delivery: unknown };

export type AgentState = "stopped" | "starting" | "idle" | "working" | "waiting_approval" | "crashed" | "sleeping" | "budget";
export interface AgentStatus {
  state: AgentState;
  detail: string;
  since: number;
  heartbeat: number;
  chatId?: string;
}

/** One normalised step from any engine (ACP session/update, gateway tool call, lifecycle). */
export interface ActivityEntry {
  ts: number;
  kind: "message" | "thought" | "tool" | "plan" | "usage" | "lifecycle" | "error" | "stderr" | "prompt";
  text: string;
  status?: string;
  toolCallId?: string;
  toolKind?: string;
}

export class Bus extends EventEmitter {
  emitEvent(e: BusEvent): void {
    this.emit("event", e);
  }
  onEvent(fn: (e: BusEvent) => void): () => void {
    this.on("event", fn);
    return () => this.off("event", fn);
  }
}
