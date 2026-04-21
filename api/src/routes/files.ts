import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, inArray, desc, isNull, sql as dsql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  conversationMembers,
  conversations,
  messages,
  members,
  users,
  agents,
} from "../db/schema.js";
import { requireAuth, requireWorkspace, loadSession } from "../auth/session.js";
import { statObject, streamObject } from "../lib/storage.js";

interface AttachmentRow {
  key: string;
  name: string;
  contentType: string;
  size: number;
  url: string;
}

// Accept either a human session cookie OR an agent bearer token.
async function requireSessionOrAgent(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const header = req.headers.authorization ?? "";
  const bearer = header.replace(/^Bearer\s+/i, "");
  if (bearer) {
    const [a] = await db.select().from(agents).where(eq(agents.botToken, bearer)).limit(1);
    if (a) return; // valid agent — allow
  }
  const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies ?? {};
  const sid = cookies["cc_session"];
  if (sid) {
    const s = await loadSession(sid);
    if (s) return;
  }
  reply.code(401).send({ error: "unauthorized" });
}

// File serving: session cookie (web UI) OR agent bearer token (agent runtime).
export async function fileServeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireSessionOrAgent);

  app.get("/files/*", async (req, reply) => {
    const key = (req.params as { "*": string })["*"];
    if (!key) return reply.code(400).send({ error: "no_key" });
    const st = await statObject(key);
    if (!st || !st.isFile()) return reply.code(404).send({ error: "not_found" });
    const ct = guessContentType(key);
    reply.header("content-type", ct);
    reply.header("content-length", String(st.size));
    reply.header("cache-control", "private, max-age=60");
    return reply.send(streamObject(key));
  });
}

// Directory listing: every attachment in conversations the caller is part of.
// Does not copy data — just reads messages.attachments_json and stats the
// underlying file on disk so deletions surface as `exists: false`.
export async function fileDirectoryRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireWorkspace);

  app.get("/files", async (req) => {
    const { memberId } = req.auth!;

    const mc = await db
      .select({ conversationId: conversationMembers.conversationId })
      .from(conversationMembers)
      .where(eq(conversationMembers.memberId, memberId));
    const convIds = mc.map((r) => r.conversationId);
    if (!convIds.length) return { files: [] };

    const rows = await db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        memberId: messages.memberId,
        ts: messages.ts,
        attachmentsJson: messages.attachmentsJson,
      })
      .from(messages)
      .where(
        and(
          inArray(messages.conversationId, convIds),
          isNull(messages.deletedAt),
          dsql`jsonb_array_length(${messages.attachmentsJson}) > 0` as never,
        ),
      )
      .orderBy(desc(messages.ts))
      .limit(500);

    if (!rows.length) return { files: [] };

    const uniqueConvIds = Array.from(new Set(rows.map((r) => r.conversationId)));
    const convRows = await db
      .select({ id: conversations.id, kind: conversations.kind, name: conversations.name })
      .from(conversations)
      .where(inArray(conversations.id, uniqueConvIds));
    const convById = new Map(convRows.map((c) => [c.id, c]));

    const dmConvIds = convRows.filter((c) => c.kind === "dm").map((c) => c.id);
    const dmOtherByConv = new Map<string, string>();
    if (dmConvIds.length) {
      const dm = await db
        .select({
          conversationId: conversationMembers.conversationId,
          memberId: conversationMembers.memberId,
        })
        .from(conversationMembers)
        .where(inArray(conversationMembers.conversationId, dmConvIds));
      for (const cid of dmConvIds) {
        const these = dm.filter((r) => r.conversationId === cid);
        dmOtherByConv.set(cid, these.find((r) => r.memberId !== memberId)?.memberId ?? memberId);
      }
    }

    const authorIds = Array.from(new Set(rows.map((r) => r.memberId)));
    const dirRows = await db
      .select({ id: members.id, kind: members.kind, refId: members.refId })
      .from(members)
      .where(inArray(members.id, authorIds));
    const userRefs = dirRows.filter((d) => d.kind === "user").map((d) => d.refId);
    const agentRefs = dirRows.filter((d) => d.kind === "agent").map((d) => d.refId);
    const userRows = userRefs.length
      ? await db
          .select({ id: users.id, name: users.name, handle: users.handle })
          .from(users)
          .where(inArray(users.id, userRefs))
      : [];
    const agentRows = agentRefs.length
      ? await db
          .select({ id: agents.id, name: agents.name, handle: agents.handle })
          .from(agents)
          .where(inArray(agents.id, agentRefs))
      : [];
    const byUserId = new Map(userRows.map((u) => [u.id, u]));
    const byAgentId = new Map(agentRows.map((a) => [a.id, a]));
    const authorByMember = new Map(
      dirRows.map((d) => {
        const ref =
          d.kind === "user" ? byUserId.get(d.refId) : byAgentId.get(d.refId);
        return [d.id, ref ? { name: ref.name, handle: ref.handle, kind: d.kind } : null];
      }),
    );

    const expanded: Array<{
      key: string;
      name: string;
      contentType: string;
      size: number;
      url: string;
      exists: boolean;
      onDiskSize: number | null;
      messageId: string;
      conversationId: string;
      conversationKind: string;
      conversationName: string | null;
      conversationOtherMemberId: string | null;
      ts: string;
      author: { name: string; handle: string; kind: string } | null;
    }> = [];

    for (const r of rows) {
      const atts = (r.attachmentsJson as AttachmentRow[]) ?? [];
      const c = convById.get(r.conversationId);
      for (const a of atts) {
        const st = await statObject(a.key);
        expanded.push({
          key: a.key,
          name: a.name,
          contentType: a.contentType,
          size: a.size,
          url: a.url,
          exists: !!st,
          onDiskSize: st?.size ?? null,
          messageId: r.id,
          conversationId: r.conversationId,
          conversationKind: c?.kind ?? "channel",
          conversationName: c?.name ?? null,
          conversationOtherMemberId:
            c?.kind === "dm" ? dmOtherByConv.get(r.conversationId) ?? memberId : null,
          ts: r.ts.toISOString(),
          author: authorByMember.get(r.memberId) ?? null,
        });
      }
    }

    return { files: expanded };
  });
}

function guessContentType(key: string): string {
  const ext = key.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    txt: "text/plain; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    json: "application/json",
    csv: "text/csv",
    mp4: "video/mp4",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    zip: "application/zip",
  };
  return map[ext] ?? "application/octet-stream";
}
