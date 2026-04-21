import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

import authRoutes from "./routes/auth.js";
import workspaceRoutes from "./routes/workspaces.js";
import orgRoutes from "./routes/org.js";
import conversationRoutes from "./routes/conversations.js";
import messageRoutes from "./routes/messages.js";
import tasksRoutes from "./routes/tasks.js";
import uploadRoutes from "./routes/uploads.js";
import agentRoutes from "./routes/agents.js";
import approvalRoutes from "./routes/approvals.js";
import agentApiRoutes from "./routes/agent-api.js";
import agentInstallRoutes from "./routes/agent-install.js";
import agentAttachRoutes from "./routes/agent-attach.js";
import agentSkillsRoutes from "./routes/agent-skills.js";
import searchRoutes from "./routes/search.js";
import { fileServeRoutes, fileDirectoryRoutes } from "./routes/files.js";
import eventsWs from "./ws/events.js";
import agentSocketWs from "./ws/agent-socket.js";
import { config } from "./lib/config.js";
import { startAmbientChatter } from "./agents/ambient.js";

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    transport:
      config.env === "development"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
  },
  bodyLimit: 20 * 1024 * 1024,
});

await app.register(cors, {
  origin: (origin, cb) => cb(null, true),
  credentials: true,
});
await app.register(cookie, { secret: config.sessionSecret });
await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
await app.register(websocket, {
  options: { maxPayload: 1024 * 1024, clientTracking: true },
});

app.get("/health", async () => ({ ok: true, time: new Date().toISOString() }));

await app.register(authRoutes, { prefix: "/api" });
await app.register(workspaceRoutes, { prefix: "/api" });
await app.register(orgRoutes, { prefix: "/api" });
await app.register(conversationRoutes, { prefix: "/api" });
await app.register(messageRoutes, { prefix: "/api" });
await app.register(tasksRoutes, { prefix: "/api" });
await app.register(uploadRoutes, { prefix: "/api" });
await app.register(agentRoutes, { prefix: "/api" });
await app.register(agentInstallRoutes, { prefix: "/api" });
await app.register(agentAttachRoutes, { prefix: "/api" });
await app.register(agentSkillsRoutes, { prefix: "/api" });
await app.register(approvalRoutes, { prefix: "/api" });
await app.register(agentApiRoutes, { prefix: "/api" });
await app.register(searchRoutes, { prefix: "/api" });
await app.register(fileDirectoryRoutes, { prefix: "/api" });
// Auth-checked file serving — registered at root so URLs are /files/<key>
// and not /api/files/<key>. Must run before fastifyStatic so the route matches.
await app.register(fileServeRoutes);
await app.register(eventsWs);
await app.register(agentSocketWs);

// Serve the built web bundle from WEB_DIST_DIR if present — single-port deploy.
const webDist = process.env.WEB_DIST_DIR ?? pathResolve(process.cwd(), "../web/dist");
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, prefix: "/" });
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? "/";
    if (
      url.startsWith("/api") ||
      url.startsWith("/events") ||
      url.startsWith("/agent-socket") ||
      url.startsWith("/files")
    ) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    reply.sendFile("index.html");
  });
  app.log.info({ webDist }, "serving web bundle");
}

// Global error handler — surface zod issues nicely.
app.setErrorHandler((err, _req, reply) => {
  const e = err as Error & { issues?: unknown[]; statusCode?: number };
  if (e.issues) {
    reply.code(400).send({ error: "validation", issues: e.issues });
    return;
  }
  app.log.error(e);
  reply.code(e.statusCode ?? 500).send({ error: e.message ?? "server_error" });
});

try {
  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info({ port: config.port }, "circlechat api listening");
  // Ambient chatter is on by default with conservative cadence. Disable with
  // AMBIENT_CHATTER=0 (keeps the old kill-switch for debugging budget spikes).
  if (process.env.AMBIENT_CHATTER !== "0") {
    startAmbientChatter();
    app.log.info("ambient chatter loop started");
  } else {
    app.log.info("ambient chatter disabled (AMBIENT_CHATTER=0)");
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
