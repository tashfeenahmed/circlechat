import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync, readFileSync } from "node:fs";
import { resolve as pathResolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import authRoutes from "./routes/auth.js";
import workspaceRoutes from "./routes/workspaces.js";
import orgRoutes from "./routes/org.js";
import conversationRoutes from "./routes/conversations.js";
import messageRoutes from "./routes/messages.js";
import tasksRoutes from "./routes/tasks.js";
import goalsRoutes from "./routes/goals.js";
import taskArtifactRoutes from "./routes/task-artifacts.js";
import uploadRoutes from "./routes/uploads.js";
import agentRoutes from "./routes/agents.js";
import approvalRoutes from "./routes/approvals.js";
import analyticsRoutes from "./routes/analytics.js";
import agentApiRoutes from "./routes/agent-api.js";
import agentInstallRoutes from "./routes/agent-install.js";
import agentAttachRoutes from "./routes/agent-attach.js";
import agentSkillsRoutes from "./routes/agent-skills.js";
import searchRoutes from "./routes/search.js";
import notificationRoutes from "./routes/notifications.js";
import connectorRoutes from "./routes/connectors.js";
import workflowRoutes from "./routes/workflows.js";
import modelRoutingRoutes from "./routes/model-routing.js";
import platformRoutes, { appServeRoutes } from "./routes/platform.js";
import runControlRoutes from "./routes/run-controls.js";
import needsYouRoutes from "./routes/needs-you.js";
import enterpriseRoutes, { enterprisePublicRoutes, serviceApiRoutes } from "./routes/enterprise.js";
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
  // Production traffic arrives through exactly one Caddy hop. Trusting only
  // that hop lets the rate limiter use the real client IP without accepting a
  // spoofed X-Forwarded-For chain.
  trustProxy: 1,
});

await app.register(helmet, {
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      connectSrc: ["'self'", "wss:"],
      mediaSrc: ["'self'", "blob:", "https:"],
      frameSrc: ["'self'", "blob:", "data:"],
      workerSrc: ["'self'", "blob:"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
});
await app.register(rateLimit, {
  global: true,
  max: 300,
  timeWindow: "1 minute",
});
await app.register(cors, {
  origin: config.publicOrigin,
  credentials: true,
});
await app.register(cookie, { secret: config.sessionSecret });
await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
await app.register(websocket, {
  options: { maxPayload: 1024 * 1024, clientTracking: true },
});

// Version stamp for /health — read once from package.json (works from both
// src/ under tsx and dist/ after build; both sit one level below api/).
const API_VERSION: string = (() => {
  try {
    const pkgPath = pathResolve(dirname(fileURLToPath(import.meta.url)), "../package.json");
    return String((JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version ?? "unknown");
  } catch {
    return "unknown";
  }
})();

// Unauthenticated liveness probe. Registered at both the bare path (older
// compose healthchecks) and under /api (the only prefix Caddy proxies to the
// API, so external monitors can reach it). Rate-limit exempt so a probe every
// few seconds from several monitors can't eat the client's budget.
const healthHandler = async () => ({ ok: true, version: API_VERSION, time: new Date().toISOString() });
app.get("/health", { config: { rateLimit: false } }, healthHandler);
app.get("/api/health", { config: { rateLimit: false } }, healthHandler);

// Global error handler — surface zod issues as 400s. MUST be registered before
// the route plugins below: in Fastify each encapsulated plugin context captures
// the error handler that exists when it is registered, so setting this after the
// routes would leave them on the default handler (zod errors would 500, not 400).
//
// Client errors (4xx — bad content-type, oversized body, rate limit, malformed
// JSON) are expected traffic, not incidents: log them once at warn WITHOUT a
// stack trace. Only 5xx get the full error-level dump. Before this, every
// scanner POSTing form-encoded bodies produced an error-level "Unsupported
// Media Type" stack trace per hit on the public instance.
app.setErrorHandler((err, req, reply) => {
  const e = err as Error & { issues?: unknown[]; statusCode?: number; code?: string };
  if (e.issues) {
    reply.code(400).send({ error: "validation", issues: e.issues });
    return;
  }
  const status = typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode <= 599 ? e.statusCode : 500;
  if (status < 500) {
    req.log.warn(
      { code: e.code, statusCode: status, method: req.method, url: req.url, contentType: req.headers["content-type"] },
      e.message,
    );
    if (e.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      reply.code(415).send({ error: "unsupported_media_type", accepted: ["application/json", "multipart/form-data"] });
      return;
    }
    if (e.code === "FST_ERR_CTP_EMPTY_JSON_BODY" || e.code === "FST_ERR_CTP_INVALID_JSON_BODY" || e.code === "FST_ERR_CTP_INVALID_CONTENT_LENGTH") {
      reply.code(400).send({ error: "invalid_body" });
      return;
    }
    if (e.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      reply.code(413).send({ error: "body_too_large" });
      return;
    }
    reply.code(status).send({ error: e.message ?? "request_error" });
    return;
  }
  req.log.error(e);
  // Only forward machine-readable codes (snake_case tokens) thrown on purpose;
  // raw driver/library messages stay in the log.
  const code = typeof e.message === "string" && /^[a-z][a-z0-9_]{0,79}(:[^\s]{0,200})?$/.test(e.message) ? e.message : "server_error";
  reply.code(status).send({ error: code });
});

await app.register(authRoutes, { prefix: "/api" });
await app.register(workspaceRoutes, { prefix: "/api" });
await app.register(orgRoutes, { prefix: "/api" });
await app.register(conversationRoutes, { prefix: "/api" });
await app.register(messageRoutes, { prefix: "/api" });
await app.register(tasksRoutes, { prefix: "/api" });
await app.register(goalsRoutes, { prefix: "/api" });
await app.register(taskArtifactRoutes, { prefix: "/api" });
await app.register(uploadRoutes, { prefix: "/api" });
await app.register(agentRoutes, { prefix: "/api" });
await app.register(agentInstallRoutes, { prefix: "/api" });
await app.register(agentAttachRoutes, { prefix: "/api" });
await app.register(agentSkillsRoutes, { prefix: "/api" });
await app.register(approvalRoutes, { prefix: "/api" });
await app.register(analyticsRoutes, { prefix: "/api" });
await app.register(agentApiRoutes, { prefix: "/api" });
await app.register(searchRoutes, { prefix: "/api" });
await app.register(notificationRoutes, { prefix: "/api" });
await app.register(connectorRoutes, { prefix: "/api" });
await app.register(workflowRoutes, { prefix: "/api" });
await app.register(modelRoutingRoutes, { prefix: "/api" });
await app.register(platformRoutes, { prefix: "/api" });
await app.register(runControlRoutes, { prefix: "/api" });
await app.register(needsYouRoutes, { prefix: "/api" });
await app.register(enterpriseRoutes, { prefix: "/api" });
await app.register(enterprisePublicRoutes, { prefix: "/api" });
await app.register(serviceApiRoutes, { prefix: "/api" });
await app.register(fileDirectoryRoutes, { prefix: "/api" });
// Auth-checked file serving — registered at root so URLs are /files/<key>
// and not /api/files/<key>. Must run before fastifyStatic so the route matches.
await app.register(fileServeRoutes);
await app.register(appServeRoutes);
await app.register(eventsWs);
await app.register(agentSocketWs);

// Serve the built web bundle from WEB_DIST_DIR if present — single-port deploy.
const webDist = process.env.WEB_DIST_DIR ?? pathResolve(process.cwd(), "../web/dist");
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, prefix: "/" });
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? "/";
    // Real API / socket / file-serve paths must 404 as JSON. Everything else
    // falls through to the SPA so client-side routes (/files, /board,
    // /agents/:id, /c/:id, etc.) survive a hard refresh.
    //
    // Note: /files/u/<key> is the real file-serve route (handled in files.ts)
    // and returns its own 404 from that handler — it never reaches here. The
    // SPA also has a /files page, which DOES reach here and should render.
    if (
      url.startsWith("/api") ||
      url.startsWith("/events") ||
      url.startsWith("/agent-socket") ||
      url.startsWith("/files/u/") ||
      url.startsWith("/files/t/") ||
      url.startsWith("/_internal/")
    ) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    reply.sendFile("index.html");
  });
  app.log.info({ webDist }, "serving web bundle");
}

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
