import type { ContextPacket } from "../context.js";
import { config } from "../../lib/config.js";
import type { AgentCallResponse } from "./dispatch.js";

export async function callHermesSocket(params: {
  agentId: string;
  kind: "heartbeat" | "event";
  packet: ContextPacket;
}): Promise<AgentCallResponse | "HEARTBEAT_OK"> {
  // The WS registry lives in the API process; the worker dispatches via HTTP.
  const url = `${config.apiInternalUrl.replace(/\/$/, "")}/_internal/agent-dispatch`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: params.agentId, kind: params.kind, packet: params.packet }),
  });
  if (res.status === 404) throw new Error("agent_not_connected");
  if (!res.ok) throw new Error(`dispatch_${res.status}`);
  const { reply } = (await res.json()) as {
    reply: AgentCallResponse & { status?: string } | undefined;
  };
  if (!reply) return { actions: [] };
  if (reply.status === "HEARTBEAT_OK") return "HEARTBEAT_OK";
  if (Array.isArray(reply.actions)) return { actions: reply.actions, trace: reply.trace, usage: reply.usage };
  return { actions: [] };
}
