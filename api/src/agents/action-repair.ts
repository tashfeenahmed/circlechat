import type { AgentAction } from "./executor.js";

// Pre-dispatch auto-repair (Claude Code PreToolUse "updatedInput" verb). The
// executor already DENIES malformed actions with a teaching error
// (validateActionShape); this is the third verb — REWRITE — applied first, so
// an UNAMBIGUOUS mistake becomes a silent fix instead of a wasted turn. Only
// fires on things that can't be a real value:
//   • placeholder ids the model copied from the prompt template ("task_…",
//     "<id>", "conversation_id") → the obvious referent (the agent's sole open
//     task; the conversation that triggered the run);
//   • file paths that aren't absolute → prefixed with /workspace/.
// Every repair is recorded so it shows in the run trace (never silent-silent).
// Anything ambiguous is left alone for validateActionShape to reject normally.

export interface RepairCtx {
  // The agent's single open assigned task, if it has exactly one — the only
  // case where a bogus task_id has an unambiguous fix.
  soleOpenTaskId: string | null;
  // The conversation that woke this run, for a placeholder conversation_id.
  triggerConversationId: string | null;
}

// A token is a placeholder when it can't be a real id: real ids look like
// "task_a1b2c3…" (prefix + 20+ alphanumerics) and never contain <, >, …, "...",
// a trailing underscore, or spell out the field name.
export function isPlaceholderId(s: unknown): boolean {
  if (typeof s !== "string") return true;
  const t = s.trim();
  if (!t) return true;
  if (/[<>…]/.test(t) || t.includes("...")) return true;
  if (/_$/.test(t)) return true;
  if (/^(?:task|conversation|conv|channel|goal|member|user|msg|approval)(?:_id)?$/i.test(t)) return true;
  if (/^(?:task|c|m|w|u|goal|ap|msg)_(?:id|xxx+|n|\d{1,3})$/i.test(t)) return true;
  return false;
}

function normalizePath(p: string): string | null {
  const t = p.trim();
  if (!t || t.startsWith("/")) return null; // empty or already absolute → no change
  return `/workspace/${t.replace(/^\.\//, "")}`;
}

export function repairAction(
  action: AgentAction,
  ctx: RepairCtx,
): { action: AgentAction; repairs: string[] } {
  const repairs: string[] = [];
  const rec = { ...(action as Record<string, unknown>) } as Record<string, unknown>;

  if (typeof rec.task_id === "string" && isPlaceholderId(rec.task_id) && ctx.soleOpenTaskId) {
    repairs.push(`task_id "${rec.task_id}"→${ctx.soleOpenTaskId} (placeholder → your only open task)`);
    rec.task_id = ctx.soleOpenTaskId;
  }

  if (
    typeof rec.conversation_id === "string" &&
    isPlaceholderId(rec.conversation_id) &&
    ctx.triggerConversationId
  ) {
    repairs.push(
      `conversation_id "${rec.conversation_id}"→${ctx.triggerConversationId} (placeholder → this conversation)`,
    );
    rec.conversation_id = ctx.triggerConversationId;
  }

  if ((rec.type === "share_files" || rec.type === "share_to_task") && Array.isArray(rec.files)) {
    rec.files = (rec.files as Array<Record<string, unknown>>).map((f) => {
      if (f && typeof f.path === "string") {
        const fixed = normalizePath(f.path);
        if (fixed) {
          repairs.push(`path "${f.path}"→${fixed}`);
          return { ...f, path: fixed };
        }
      }
      return f;
    });
  }

  return { action: rec as unknown as AgentAction, repairs };
}
