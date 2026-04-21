import type { ContextPacket } from "../context.js";

export async function callOpenClawWebhook(params: {
  callbackUrl: string;
  botToken: string;
  kind: "heartbeat" | "event";
  packet: ContextPacket;
}): Promise<{ actions: unknown[]; trace?: string[] } | "HEARTBEAT_OK"> {
  const url = new URL(params.callbackUrl);
  url.pathname = url.pathname.replace(/\/+$/, "") + (params.kind === "heartbeat" ? "/heartbeat" : "/event");

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 60_000);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "POST",
      signal: ac.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${params.botToken}`,
        "x-cc-agent": params.packet.agent.id,
      },
      body: JSON.stringify(params.packet),
    });
  } finally {
    clearTimeout(t);
  }

  if (!res.ok) throw new Error(`webhook_status_${res.status}`);
  const text = await res.text();
  if (!text.trim()) return "HEARTBEAT_OK";
  try {
    const parsed = JSON.parse(text);
    if (parsed === "HEARTBEAT_OK" || parsed?.status === "HEARTBEAT_OK") return "HEARTBEAT_OK";
    if (Array.isArray(parsed?.actions)) return { actions: parsed.actions, trace: parsed.trace };
    return { actions: [] };
  } catch {
    if (text.trim() === "HEARTBEAT_OK") return "HEARTBEAT_OK";
    throw new Error("webhook_bad_body");
  }
}
