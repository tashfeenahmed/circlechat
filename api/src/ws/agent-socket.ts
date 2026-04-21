import { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { agents } from "../db/schema.js";
import {
  registerAgentSocket,
  unregisterAgentSocket,
  resolvePending,
  sendToAgentSocket,
  hasAgentSocket,
} from "../agents/registry.js";
import { scheduleAgentHeartbeat } from "../agents/scheduler.js";
import { id as makeId } from "../lib/ids.js";

export default async function agentSocketWs(app: FastifyInstance): Promise<void> {
  app.get("/agent-socket", { websocket: true }, async (conn, req) => {
    const socket = conn as unknown as import("ws").WebSocket & {
      send: (data: string) => void;
      close: (code?: number) => void;
      on: (ev: string, cb: (...args: unknown[]) => void) => void;
    };
    const authHeader =
      (req.headers["authorization"] as string | undefined) ??
      (req.headers["x-cc-token"] as string | undefined);
    let token = "";
    if (authHeader) token = authHeader.replace(/^Bearer\s+/i, "");
    // Also accept ?token= fallback for socket-mode CLIs.
    const q = req.query as { token?: string };
    if (!token && q?.token) token = q.token;

    if (!token) {
      socket.close(4401);
      return;
    }

    const [agent] = await db.select().from(agents).where(eq(agents.botToken, token)).limit(1);
    if (!agent) {
      socket.close(4401);
      return;
    }

    registerAgentSocket(agent.id, socket);
    await db
      .update(agents)
      .set({ status: "idle" })
      .where(eq(agents.id, agent.id));
    await scheduleAgentHeartbeat(agent.id, agent.heartbeatIntervalSec);

    socket.send(JSON.stringify({ type: "hello", agentId: agent.id, handle: agent.handle }));

    socket.on("message", async (raw) => {
      try {
        const data = JSON.parse(String(raw));
        if (data.type === "reply" && data.correlation_id) {
          resolvePending(data.correlation_id, data);
        } else if (data.type === "pong") {
          // keep-alive
        }
      } catch {
        // ignore
      }
    });

    socket.on("close", () => {
      unregisterAgentSocket(agent.id, socket);
    });
  });

  // Internal dispatch endpoint so the worker process (which doesn't own the WS map)
  // can forward heartbeat/event packets to the right connected agent.
  app.post("/_internal/agent-dispatch", async (req, reply) => {
    const body = req.body as {
      agentId: string;
      kind: "heartbeat" | "event";
      packet: Record<string, unknown>;
      timeoutMs?: number;
    };
    if (!body?.agentId) return reply.code(400).send({ error: "agentId_required" });
    if (!hasAgentSocket(body.agentId)) return reply.code(404).send({ error: "agent_not_connected" });
    try {
      const resp = await sendToAgentSocket(
        body.agentId,
        makeId("c").slice(2, 20),
        { type: body.kind, packet: body.packet },
        body.timeoutMs ?? 120_000,
      );
      return reply.send({ reply: resp });
    } catch (e) {
      return reply.code(504).send({ error: (e as Error).message });
    }
  });
}
