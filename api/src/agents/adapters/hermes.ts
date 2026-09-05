import http from "node:http";
import https from "node:https";
import type { ContextPacket } from "../context.js";
import { config, dispatchTimeoutMs } from "../../lib/config.js";
import type { AgentCallResponse } from "./dispatch.js";

// Plain http(s).request instead of fetch: Node's fetch (undici) enforces a
// 300 s headers timeout that cannot be raised without a custom dispatcher, and
// a long tool-using Hermes run legitimately holds this request for longer.
function postJson(url: string, body: unknown, timeoutMs: number): Promise<{ status: number; text: string }> {
  const u = new URL(url);
  const mod = u.protocol === "https:" ? https : http;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = mod.request(
      u,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          "x-internal-token": config.sessionSecret,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("dispatch_client_timeout")));
    req.on("error", reject);
    req.end(payload);
  });
}

export async function callHermesSocket(params: {
  agentId: string;
  kind: "heartbeat" | "event";
  packet: ContextPacket;
}): Promise<AgentCallResponse | "HEARTBEAT_OK"> {
  // The WS registry lives in the API process; the worker dispatches via HTTP.
  const url = `${config.apiInternalUrl.replace(/\/$/, "")}/_internal/agent-dispatch`;
  const timeoutMs = dispatchTimeoutMs();
  // The api waits `timeoutMs` for the bridge; give the socket a little longer so
  // the api's own 504 (with its reason) wins over a bare client-side abort.
  const res = await postJson(url, { agentId: params.agentId, kind: params.kind, packet: params.packet, timeoutMs }, timeoutMs + 15_000);
  if (res.status === 404) throw new Error("agent_not_connected");
  if (res.status < 200 || res.status >= 300) throw new Error(`dispatch_${res.status}`);
  const { reply } = JSON.parse(res.text) as {
    reply: AgentCallResponse & { status?: string } | undefined;
  };
  if (!reply) return { actions: [] };
  const error = typeof reply.error === "string" && reply.error ? reply.error.slice(0, 200) : undefined;
  // A bridge that skipped because the runtime produced nothing may say so via
  // `error` (e.g. {status:"HEARTBEAT_OK", error:"empty_reply"}); surface it
  // rather than folding it into a healthy idle beat.
  if (reply.status === "HEARTBEAT_OK") return error ? { actions: [], error } : "HEARTBEAT_OK";
  if (Array.isArray(reply.actions)) {
    return { actions: reply.actions, trace: reply.trace, usage: reply.usage, ...(error ? { error } : {}) };
  }
  return error ? { actions: [], error } : { actions: [] };
}
