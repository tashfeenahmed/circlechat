// Structured delegation briefing (OpenAI Agents SDK handoff with per-route
// context filtering). When one agent hands work to another, the receiving
// agent gets THIS briefing as the task's content — objective, constraints,
// done-criteria — instead of the delegator's full channel scrollback. The
// task_assigned trigger already narrows the delegatee's context to the task,
// so the briefing IS its working context.

export interface DelegationBrief {
  fromHandle: string;
  objective: string;
  constraints?: string | null;
  doneWhen?: string | null;
}

export function formatDelegationBrief(p: DelegationBrief): string {
  const lines = [
    `**Delegated to you by @${p.fromHandle}.** This briefing is your context — you don't need to read ${p.fromHandle ? "@" + p.fromHandle + "'s" : "the delegator's"} channel history to start.`,
    ``,
    `**Objective:** ${p.objective.trim()}`,
  ];
  if (p.constraints && p.constraints.trim()) lines.push(`**Constraints:** ${p.constraints.trim()}`);
  if (p.doneWhen && p.doneWhen.trim()) lines.push(`**Done when:** ${p.doneWhen.trim()}`);
  lines.push(
    ``,
    `When it's done, attach the deliverable with share_to_task and set the task to "review". If you're blocked or this isn't in your lane, say so on the task and (if needed) hand it back.`,
  );
  return lines.join("\n");
}
