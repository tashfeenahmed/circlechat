import { FastifyInstance } from "fastify";
import { eq, and, inArray, or, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { agentRuns, agents, conversationMembers } from "../db/schema.js";
import { COOKIE_NAME, loadSession } from "../auth/session.js";
import { subscribe, unsubscribeAll } from "./bus.js";
import { CONV_CHANNEL, WORKSPACE_CHANNEL, USER_CHANNEL, GLOBAL_CHANNEL, publishGlobal } from "../lib/events.js";

export default async function eventsWs(app: FastifyInstance): Promise<void> {
  app.get(
    "/events",
    { websocket: true },
    async (conn, req) => {
      const socket = conn as unknown as import("ws").WebSocket & {
        send: (data: string) => void;
        close: (code?: number) => void;
        on: (ev: string, cb: (...args: unknown[]) => void) => void;
      };
      // Auth: session cookie (parsed by @fastify/cookie earlier in the pipeline).
      const sid = (req as unknown as { cookies: Record<string, string> }).cookies?.[COOKIE_NAME];
      if (!sid) {
        socket.close(4401);
        return;
      }
      const s = await loadSession(sid);
      if (!s) {
        socket.close(4401);
        return;
      }

      const memberId = s.memberId;
      // Subscribe to per-member channel + all conversation channels.
      const myConvs = await db
        .select({ id: conversationMembers.conversationId })
        .from(conversationMembers)
        .where(eq(conversationMembers.memberId, memberId));

      await subscribe(socket, USER_CHANNEL(memberId));
      await subscribe(socket, GLOBAL_CHANNEL);
      if (s.workspaceId) await subscribe(socket, WORKSPACE_CHANNEL(s.workspaceId));
      for (const c of myConvs) await subscribe(socket, CONV_CHANNEL(c.id));

      socket.send(
        JSON.stringify({
          type: "hello",
          memberId,
          userId: s.userId,
          subscribedConversations: myConvs.map((c) => c.id),
        }),
      );

      // Survive reconnect / event loss: replay any agent runs currently in
      // flight that this user can see. The client uses it to restore
      // "thinking" pills that would otherwise be stuck or missing entirely.
      const visibleConvIds = myConvs.map((c) => c.id);
      const runningRows = visibleConvIds.length
        ? await db
            .select({
              runId: agentRuns.id,
              agentId: agentRuns.agentId,
              agentName: agents.name,
              agentHandle: agents.handle,
              trigger: agentRuns.trigger,
              conversationId: agentRuns.conversationId,
              startedAt: agentRuns.startedAt,
            })
            .from(agentRuns)
            .innerJoin(agents, eq(agents.id, agentRuns.agentId))
            .where(
              and(
                eq(agentRuns.status, "running"),
                or(
                  isNull(agentRuns.conversationId),
                  inArray(agentRuns.conversationId, visibleConvIds),
                ),
              ),
            )
            .limit(100)
        : await db
            .select({
              runId: agentRuns.id,
              agentId: agentRuns.agentId,
              agentName: agents.name,
              agentHandle: agents.handle,
              trigger: agentRuns.trigger,
              conversationId: agentRuns.conversationId,
              startedAt: agentRuns.startedAt,
            })
            .from(agentRuns)
            .innerJoin(agents, eq(agents.id, agentRuns.agentId))
            .where(and(eq(agentRuns.status, "running"), isNull(agentRuns.conversationId)))
            .limit(100);
      if (runningRows.length) {
        socket.send(
          JSON.stringify({
            type: "agent.runs.snapshot",
            runs: runningRows.map((r) => ({
              runId: r.runId,
              agentId: r.agentId,
              agentName: r.agentName,
              agentHandle: r.agentHandle,
              trigger: r.trigger,
              conversationId: r.conversationId,
              startedAt: r.startedAt.toISOString(),
            })),
          }),
        );
      }

      const ping = setInterval(() => {
        try {
          socket.send(JSON.stringify({ type: "ping" }));
        } catch {
          // ignore
        }
      }, 25_000);

      socket.on("message", async (raw) => {
        try {
          const data = JSON.parse(String(raw));
          if (data.type === "subscribe" && typeof data.conversationId === "string") {
            // Only allow subscribing to conversations the member belongs to.
            const [m] = await db
              .select()
              .from(conversationMembers)
              .where(eq(conversationMembers.memberId, memberId))
              .limit(1);
            if (m) await subscribe(socket, CONV_CHANNEL(data.conversationId));
          }
          if (data.type === "presence") {
            await publishGlobal({
              type: "presence.update",
              memberId,
              status: typeof data.status === "string" ? data.status : "online",
            });
          }
        } catch {
          // ignore malformed frames
        }
      });

      socket.on("close", async () => {
        clearInterval(ping);
        await unsubscribeAll(socket);
        await publishGlobal({ type: "presence.update", memberId, status: "offline" });
      });

      await publishGlobal({ type: "presence.update", memberId, status: "online" });
    },
  );
}
