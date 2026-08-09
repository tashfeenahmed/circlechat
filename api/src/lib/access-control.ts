import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { db } from "../db/index.js";
import { auditEvents, workspaceMembers, workspaceRoles } from "../db/schema.js";
import { id } from "./ids.js";
import { config } from "./config.js";

export const BUILTIN_PERMISSIONS: Record<string, string[]> = {
  admin: ["*"],
  member: ["workspace.read", "workspace.write", "runs.control", "apps.request_publish"],
  guest: ["workspace.read", "channels.write"],
};

export async function workspaceAccess(workspaceId: string, userId: string): Promise<{
  role: string;
  permissions: string[];
} | null> {
  const [membership] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  if (!membership) return null;
  const builtIn = BUILTIN_PERMISSIONS[membership.role];
  if (builtIn) return { role: membership.role, permissions: builtIn };
  const [custom] = await db
    .select({ permissions: workspaceRoles.permissionsJson })
    .from(workspaceRoles)
    .where(and(eq(workspaceRoles.workspaceId, workspaceId), eq(workspaceRoles.key, membership.role)))
    .limit(1);
  return { role: membership.role, permissions: custom?.permissions ?? [] };
}
export function permits(permissions: string[], permission: string): boolean {
  return permissions.includes("*") || permissions.includes(permission);
}

export async function requirePermission(req: FastifyRequest, permission: string): Promise<boolean> {
  const workspaceId = req.auth?.workspaceId;
  const userId = req.auth?.userId;
  if (!workspaceId || !userId) return false;
  const access = await workspaceAccess(workspaceId, userId);
  return Boolean(access && permits(access.permissions, permission));
}

export async function writeAudit(input: {
  workspaceId: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  actorType?: "user" | "agent" | "service" | "system";
  meta?: Record<string, unknown>;
  ip?: string;
}): Promise<void> {
  const ipHash = input.ip
    ? createHash("sha256").update(`${config.sessionSecret}:${input.ip}`).digest("hex")
    : null;
  await db.insert(auditEvents).values({
    id: id("audit"),
    workspaceId: input.workspaceId,
    actorType: input.actorType ?? "user",
    actorId: input.actorId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    metaJson: input.meta ?? {},
    ipHash,
  });
}
