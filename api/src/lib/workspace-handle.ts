import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { workspaces } from "../db/schema.js";

const HANDLE_MAX = 40;

export function slugifyWorkspace(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9._-]/g, "").replace(/^[._-]+/, "").slice(0, HANDLE_MAX);
  return base || "ws";
}

export async function deriveUniqueWorkspaceHandle(name: string): Promise<string> {
  const base = slugifyWorkspace(name);
  const [taken] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.handle, base))
    .limit(1);
  if (!taken) return base;

  const trunc = base.slice(0, HANDLE_MAX - 6);
  for (let i = 0; i < 8; i++) {
    const suffix = Math.random().toString(36).slice(2, 7);
    const cand = `${trunc}-${suffix}`;
    const [t] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.handle, cand))
      .limit(1);
    if (!t) return cand;
  }
  throw new Error("could not generate unique workspace handle");
}
