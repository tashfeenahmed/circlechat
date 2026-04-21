import type { ContextPacket } from "../context.js";
import type { agents } from "../../db/schema.js";
import { callOpenClawWebhook } from "./openclaw.js";
import { callHermesSocket } from "./hermes.js";

type Agent = typeof agents.$inferSelect;

export async function callAgent(
  agent: Agent,
  kind: "heartbeat" | "event",
  packet: ContextPacket,
): Promise<{ actions: unknown[]; trace?: string[] } | "HEARTBEAT_OK"> {
  if (agent.adapter === "webhook") {
    if (!agent.callbackUrl) throw new Error("no_callback_url");
    return callOpenClawWebhook({
      callbackUrl: agent.callbackUrl,
      botToken: agent.botToken,
      kind,
      packet,
    });
  }
  if (agent.adapter === "socket") {
    return callHermesSocket({ agentId: agent.id, kind, packet });
  }
  throw new Error(`unknown_adapter_${agent.adapter}`);
}
