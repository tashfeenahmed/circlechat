// Behavioral eval for the shared project-memory feature (project_note action).
//
// It builds the EXACT production prompt (the bridge's buildPrompt), sends each
// scenario to the live FreeLLMAPI gateway (the model the agents actually use),
// parses the reply with the real extractActions, and grades whether the model
// emits a well-formed project_note WHEN it should, targets the right project,
// and stays quiet when it shouldn't.
//
//   CC_GW_URL=https://freellm.178-105-187-189.sslip.io/v1 \
//   CC_GW_KEY=<unified key> CC_GW_MODEL=auto \
//   node api/evals/project-note.eval.mjs
//
// Secrets come from env — never hard-code the key.
//
// READING THE RESULTS — the gateway force-routes "auto" (pinned models disabled),
// so each generator call may hit a different-quality model. With identical code,
// EMIT has been observed anywhere from ~63% (auto routed to a weak model that
// under-emits) to 100% (strong model), and FIDELITY from 0% to ~40%. Therefore:
//   • Treat the agent-behavior numbers (emit/mode/fidelity) as a NOISY RANGE, not
//     a point estimate — run ≥5 samples and only trust deltas larger than the
//     run-to-run swing. The reliable uses are (a) catching a clear regression and
//     (b) diagnosing a specific failure (e.g. it caught the self-stamp fabrication).
//   • The one STABLE signal is the JUDGE itself — validate it with
//     faithfulness-calibration.mjs (κ + unfaithful-recall), which is routing-robust.

process.env.CC_BRIDGE_IMPORT_ONLY = "1"; // import buildPrompt without opening sockets
const { buildPrompt, extractActions } = await import("../hermes-multi-bridge.mjs");
// Dimension 2 (isolated judge): faithfulness of the note the agent actually wrote.
const { gatewayChat, judgeFaithfulness, JUDGE_DEFAULTS } = await import("./faithfulness-judge.mjs");

const GW_URL = (process.env.CC_GW_URL || "").replace(/\/$/, "");
const GW_KEY = process.env.CC_GW_KEY || "";
const GW_MODEL = process.env.CC_GW_MODEL || "auto";
const CONCURRENCY = Number(process.env.CC_EVAL_CONCURRENCY || 3);
if (!GW_URL || !GW_KEY) {
  console.error("Set CC_GW_URL and CC_GW_KEY.");
  process.exit(2);
}

// ── shared fixtures: the real backfilled project context ──
const PROJECT_INDEX = `◆ freellmapi-backlinks (owner @samantha)
   • decisions.md — Campaign decisions (append-only) · upd 2026-06-19 @samantha · 356B [triggers: freellmapi, backlink, decision]
   • status.md — Campaign status — assets built, outreach + submissions in review · upd 2026-06-19 @samantha · 1K [triggers: freellmapi, backlink, outreach]
   • brief.md — Earn high-quality backlinks for freellmapi.co (no paid links) · upd 2026-06-19 @samantha · 865B [triggers: freellmapi, backlink, seo]
◆ neu-website (owner @samantha)
   • brief.md — What we're building for neu.ie + the acceptance bar · upd 2026-06-19 @samantha · 1K [triggers: neu, neu.ie, redesign, website]
   • status.md — Current focus — most build tasks done, 9 in review awaiting sign-off · upd 2026-06-19 @rachel · 1K [always]
   • decisions.md — Key design & technical decisions (append-only log) · upd 2026-06-19 @rachel · 733B [triggers: neu, design, decision]
   • changelog.md — What has shipped on neu.ie · upd 2026-06-19 @phil · 412B [triggers: neu, changelog, shipped]`;

const NEU_STATUS_FILE = {
  project: "neu-website",
  name: "status.md",
  content:
    "# neu.ie redesign — current status\nBuild essentially complete; in review/sign-off.\nLive preview: https://neu.178-105-187-189.sslip.io/  · files in /workspace/neu-site/",
};
const NEU_DECISIONS_FILE = {
  project: "neu-website",
  name: "decisions.md",
  content:
    "# neu.ie redesign — decisions\n- AI agency, not neuroscience.\n- Plain HTML/CSS/JS, no build step.\n- Dark, premium, distinctive look.",
};
const FREEAPI_DECISIONS_FILE = {
  project: "freellmapi-backlinks",
  name: "decisions.md",
  content: "# FreeLLMAPI backlink campaign — decisions\n- Earned links only — no paid links.\n- Focus on freellmapi.co.",
};

const MEMBERS = {
  m_rachel: { memberId: "m_rachel", handle: "rachel", name: "Rachel", kind: "agent", isMe: false },
  m_phil: { memberId: "m_phil", handle: "phil", name: "Phil", kind: "agent", isMe: false },
  m_samantha: { memberId: "m_samantha", handle: "samantha", name: "Samantha", kind: "agent", isMe: false },
  m_tash: { memberId: "m_tash", handle: "tash", name: "Tash", kind: "user", isMe: false },
};

function me(memberId) {
  const m = { ...MEMBERS };
  m[memberId] = { ...m[memberId], isMe: true };
  return m;
}

function pkt(o) {
  const agentMemberId = o.agentMemberId;
  const agent = MEMBERS[agentMemberId];
  return {
    agent: { id: "a_x", memberId: agentMemberId, handle: agent.handle, name: agent.name, model: "auto", scopes: ["channels.read", "channels.reply", "tasks.write"], brief: o.brief || "" },
    workspace: {
      id: "w_x", name: "Neu Software LLC", handle: "neu", mission: "Build great AI products for clients.",
      brief: "", files: [], knowledge: [],
      projectIndex: PROJECT_INDEX,
      projectFiles: o.projectFiles ?? [NEU_STATUS_FILE],
    },
    trigger: o.trigger,
    triggerConversationId: o.conv ? o.conv.conversationId : null,
    members: me(agentMemberId),
    thread: null,
    inbox: o.conv ? [o.conv] : [],
    openApprovals: [],
    memory: { global: {}, byConversation: {}, byTask: {} },
    memoryBlocks: [
      { label: "team", description: "Shared team whiteboard.", value: o.team || "", charLimit: 3000, shared: true },
      { label: "notes", description: "Your private notes.", value: "", charLimit: 2000, shared: false },
    ],
    reporting: { manager: null, directReports: [], peers: [] },
    goals: o.goals || [],
    myTasks: o.myTasks || [],
    task: o.task || undefined,
  };
}

function conv(messages, opts = {}) {
  return {
    conversationId: "c_general",
    conversationKind: opts.kind || "channel",
    conversationName: opts.name || "general",
    conversationTopic: opts.topic || "Team coordination",
    conversationMembers: opts.members || ["m_rachel", "m_phil", "m_samantha", "m_tash"],
    messages,
  };
}
let _mid = 0;
const msg = (memberId, bodyMd) => ({ id: `msg_${++_mid}`, memberId, memberHandle: MEMBERS[memberId].handle, memberName: MEMBERS[memberId].name, bodyMd, parentId: null, ts: new Date().toISOString(), mentions: [], reactions: [], attachments: [] });

// ── scenarios ──
const SCENARIOS = [
  {
    id: "POS neu palette decision (channel)",
    expect: { projectNote: true, project: "neu" },
    entry: { handle: "rachel", title: "Designer" },
    packet: pkt({
      agentMemberId: "m_rachel", trigger: "channel_post",
      projectFiles: [NEU_STATUS_FILE, NEU_DECISIONS_FILE],
      conv: conv([msg("m_tash", "Decision for neu.ie: we're locking the dark indigo (#1a1a2e) palette as the final color scheme — no more variations. Make it canonical.")]),
    }),
  },
  {
    id: "POS freeapi earned-links policy (mention)",
    expect: { projectNote: true, project: "freellmapi" },
    entry: { handle: "samantha", title: "CEO" },
    packet: pkt({
      agentMemberId: "m_samantha", trigger: "mention",
      projectFiles: [FREEAPI_DECISIONS_FILE, NEU_STATUS_FILE],
      conv: conv([msg("m_tash", "@samantha policy for the freellmapi backlink campaign: we ONLY pursue earned links — no paid placements, ever. Bake that in so nobody forgets.")]),
    }),
  },
  {
    id: "POS neu launch date fact (dm)",
    expect: { projectNote: true, project: "neu" },
    entry: { handle: "samantha", title: "CEO" },
    packet: pkt({
      agentMemberId: "m_samantha", trigger: "dm",
      projectFiles: [NEU_STATUS_FILE, NEU_DECISIONS_FILE],
      conv: conv([msg("m_tash", "Heads up — the neu.ie launch is locked for July 15. Plan the remaining review work around that date.")], { kind: "dm", name: null, members: ["m_samantha", "m_tash"] }),
    }),
  },
  {
    // Precision check: a single task already parked in "review" on a continuation
    // is NOT a project-level event. The correct move is HEARTBEAT_OK (maker can't
    // review own work; no busywork) and crucially NO spurious project_note.
    id: "NEG task already in review (continuation) — no spurious note",
    expect: { projectNote: false },
    entry: { handle: "rachel", title: "Designer" },
    packet: pkt({
      agentMemberId: "m_rachel", trigger: "continuation",
      projectFiles: [NEU_STATUS_FILE],
      myTasks: [{ id: "task_hp", title: "Complete AI Solution Configurator widget", status: "review", progress: 100, dueAt: null, conversationId: null, conversationName: null, labels: [], commentCount: 1, latestComment: null }],
      task: { id: "task_hp", title: "Complete AI Solution Configurator widget", bodyMd: "Build the interactive configurator.", status: "review", progress: 100, dueAt: null, labels: [], assignees: ["m_rachel"], assigneeHandles: ["rachel"], parentId: null, createdBy: "m_samantha", subtasks: [], recentComments: [], goalAncestry: [], latestVerdict: null },
    }),
  },
  {
    id: "NEG per-task progress (task-only)",
    expect: { projectNote: false, prefer: ["share_to_task", "task_comment", "update_task"] },
    entry: { handle: "phil", title: "Engineer" },
    packet: pkt({
      agentMemberId: "m_phil", trigger: "scheduled",
      projectFiles: [NEU_STATUS_FILE],
      myTasks: [{ id: "task_pages", title: "Build Core Pages Structure", status: "in_progress", progress: 40, dueAt: null, conversationId: null, conversationName: null, labels: [], commentCount: 0, latestComment: null }],
    }),
  },
  {
    id: "NEG social thanks (agent mention)",
    expect: { projectNote: false, prefer: ["react", "heartbeat"] },
    entry: { handle: "rachel", title: "Designer" },
    packet: pkt({
      agentMemberId: "m_rachel", trigger: "mention",
      conv: conv([msg("m_phil", "@rachel the hero animation looks fantastic, great work! 🎉")]),
    }),
  },
  {
    id: "NEG logistics question (channel)",
    expect: { projectNote: false, prefer: ["post_message_or_reply", "heartbeat"] },
    entry: { handle: "phil", title: "Engineer" },
    packet: pkt({
      agentMemberId: "m_phil", trigger: "channel_post",
      conv: conv([msg("m_tash", "what time are we doing the standup tomorrow?")]),
    }),
  },
  {
    id: "NEG quiet ambient (no durable info)",
    expect: { projectNote: false, prefer: ["heartbeat", "post_message_or_reply"] },
    entry: { handle: "phil", title: "Engineer" },
    packet: pkt({
      agentMemberId: "m_phil", trigger: "ambient",
      conv: conv([msg("m_rachel", "coffee's fresh in the kitchen ☕")]),
    }),
  },
  {
    id: "TARGET right project (freeapi fact while neu always-injected)",
    expect: { projectNote: true, project: "freellmapi" },
    entry: { handle: "samantha", title: "CEO" },
    packet: pkt({
      agentMemberId: "m_samantha", trigger: "channel_post",
      projectFiles: [FREEAPI_DECISIONS_FILE, NEU_STATUS_FILE],
      conv: conv([msg("m_tash", "Update for the freellmapi backlink work: we just got accepted into the Futurepedia AI directory — that's our first confirmed earned link. Record it.")]),
    }),
  },
  {
    id: "POS new durable team fact (channel)",
    expect: { projectNote: true, project: "neu" },
    entry: { handle: "phil", title: "Engineer" },
    packet: pkt({
      agentMemberId: "m_phil", trigger: "channel_post",
      projectFiles: [NEU_STATUS_FILE, NEU_DECISIONS_FILE],
      conv: conv([msg("m_tash", "Important for neu.ie: the contact form must POST to https://api.neu.ie/lead — wire every page's CTA to that endpoint. Don't lose this.")]),
    }),
  },
  {
    // A new decision must be APPENDED to the log, not replace (which would clobber
    // the existing decisions). mode unset counts as append.
    id: "MODE append a new decision (don't clobber the log)",
    expect: { projectNote: true, project: "neu", mode: "append" },
    entry: { handle: "rachel", title: "Designer" },
    packet: pkt({
      agentMemberId: "m_rachel", trigger: "channel_post",
      projectFiles: [NEU_DECISIONS_FILE, NEU_STATUS_FILE],
      conv: conv([msg("m_tash", "New decision for neu.ie: we're standardizing on the Inter typeface across the whole site. Add it to the record.")]),
    }),
  },
  {
    // An explicit "the file is stale, replace it with this clean snapshot" on a
    // file the agent owns is the compaction case → mode:"replace".
    id: "MODE replace to compact a stale owned file",
    expect: { projectNote: true, project: "neu", mode: "replace" },
    entry: { handle: "samantha", title: "CEO" },
    packet: pkt({
      agentMemberId: "m_samantha", trigger: "dm",
      projectFiles: [NEU_STATUS_FILE],
      conv: conv([msg("m_tash", "The neu.ie status.md is stale and cluttered. Replace it with a clean current snapshot: build is complete, all review tasks are signed off, and the site is live at the preview URL.")], { kind: "dm", name: null, members: ["m_samantha", "m_tash"] }),
    }),
  },
];

// Generator call — routed through the shared, rate-limited gateway client so
// generator + judge calls share one limiter and never trip the gateway's 120/min.
async function callGateway(prompt) {
  return gatewayChat({
    url: GW_URL, key: GW_KEY, model: GW_MODEL, temperature: 0.2, maxTokens: 1400,
    messages: [
      { role: "system", content: "You are an autonomous CircleChat agent's runtime. The user message is your full turn context and instructions — follow them exactly, including the <actions> output contract. Reply as the agent." },
      { role: "user", content: prompt },
    ],
  });
}

// Ground truth a recorded note must be faithful to: EVERYTHING the agent was
// given that could legitimately ground a fact — the human message that woke it,
// the task body, AND the existing project files it had in context (a
// replace/compaction faithfully carries forward facts already on file, e.g. the
// preview URL). Scoping the source to only the message wrongly flags that as
// "invented" — the false-positive the research warns about.
function deriveSource(scn) {
  const parts = [];
  const c = scn.packet.inbox?.[0];
  if (c?.messages?.length) {
    const humans = c.messages.filter((m) => MEMBERS[m.memberId]?.kind === "user");
    const m = (humans.length ? humans : c.messages).slice(-1)[0];
    if (m?.bodyMd) parts.push(`[message]\n${m.bodyMd}`);
  }
  if (scn.packet.task) parts.push(`[task]\n${scn.packet.task.title}. ${scn.packet.task.bodyMd || ""}`.trim());
  for (const f of scn.packet.workspace?.projectFiles || []) parts.push(`[existing ${f.project}/${f.name}]\n${f.content}`);
  return parts.join("\n\n");
}

function grade(scn, replyText) {
  const { actions } = extractActions(replyText || "");
  const types = actions.map((a) => a.type);
  const pn = actions.find((a) => a.type === "project_note");
  const isHeartbeat = /^\s*HEARTBEAT_OK\s*$/i.test((replyText || "").trim()) || (!actions.length && !replyText.trim());
  const reasons = [];
  let pass = true;

  if (Array.isArray(scn.expect.notSilent)) {
    const acted = types.some((t) => scn.expect.notSilent.includes(t));
    if (!acted) { pass = false; reasons.push(`expected one of [${scn.expect.notSilent.join(",")}], got ${isHeartbeat ? "HEARTBEAT_OK" : `[${types.join(",") || "no-actions"}]`}`); }
    return { pass, types, pn: pn ? { project: pn.project, file: pn.file, mode: pn.mode || "append", note: pn.note } : null, isHeartbeat, reasons };
  }

  if (scn.expect.projectNote === true) {
    if (!pn) { pass = false; reasons.push("expected project_note, none emitted"); }
    else if (scn.expect.project && !(String(pn.project || "").toLowerCase().includes(scn.expect.project))) {
      pass = false; reasons.push(`project_note targeted "${pn.project}", expected ~"${scn.expect.project}"`);
    }
    if (pn && !(pn.note && String(pn.note).trim())) { pass = false; reasons.push("project_note has empty note"); }
    // Append-vs-replace correctness: append (or unset) is the safe default and
    // must NOT clobber; replace is for compacting a stale file you own.
    if (pn && scn.expect.mode) {
      const m = pn.mode || "append";
      if (m !== scn.expect.mode) { pass = false; reasons.push(`mode "${m}", expected "${scn.expect.mode}"`); }
    }
  } else if (scn.expect.projectNote === false) {
    if (pn) { pass = false; reasons.push(`unexpected project_note (project="${pn.project}")`); }
  }
  return { pass, types, pn: pn ? { project: pn.project, file: pn.file, mode: pn.mode || "append", note: pn.note } : null, isHeartbeat, reasons };
}

async function runPool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

const SAMPLES = Number(process.env.CC_EVAL_SAMPLES || 1);
const JUDGE_FIDELITY = process.env.CC_EVAL_NO_JUDGE !== "1";
console.log(`Eval: project_note behavior · gen=${GW_MODEL} · judge=${JUDGE_DEFAULTS.model}(${JUDGE_DEFAULTS.polls}p) · ${SCENARIOS.length} scenarios × ${SAMPLES} sample(s)\n`);

// Flatten scenario × sample so all calls parallelize under the pool, then
// aggregate per scenario — multi-sampling averages out gateway nondeterminism.
const jobs = SCENARIOS.flatMap((scn) => Array.from({ length: SAMPLES }, () => scn));
const raw = await runPool(jobs, CONCURRENCY, async (scn) => {
  const r = await callGateway(buildPrompt(scn.entry, scn.packet));
  if (r.error) return { scn, error: r.error };
  const g = grade(scn, r.text);
  // Dimension 2: if the agent recorded a note where one was expected, judge
  // whether that note is faithful to what was actually said (isolated judge).
  let fidelity = null;
  if (JUDGE_FIDELITY && g.pn?.note && scn.expect.projectNote === true) {
    const source = deriveSource(scn);
    if (source) fidelity = await judgeFaithfulness({ source, note: g.pn.note, url: GW_URL, key: GW_KEY });
  }
  return { scn, g, fidelity, reply: r.text };
});

const agg = new Map(SCENARIOS.map((s) => [s.id, { scn: s, passes: 0, n: 0, err: 0, last: null, fidJudged: 0, fidFaithful: 0, fabs: [] }]));
for (const res of raw) {
  const a = agg.get(res.scn.id);
  if (res.error) { a.err++; a.lastErr = res.error; continue; }
  a.n++; if (res.g.pass) a.passes++; a.last = res;
  if (res.fidelity && res.fidelity.verdict !== "error") {
    a.fidJudged++;
    if (res.fidelity.verdict === "faithful") a.fidFaithful++;
    else a.fabs.push(...(res.fidelity.fabrications || []));
  }
}

// ── Dimension 1: did the agent emit project_note correctly? ──
console.log("DIMENSION 1 — emit behavior (does the agent record when it should, stay quiet when not):");
let passFrac = 0, scoredScn = 0;
for (const a of agg.values()) {
  if (a.n === 0) { console.log(`⚠ ERR  ${a.scn.id} — ${a.lastErr}`); continue; }
  scoredScn++;
  const frac = a.passes / a.n;
  passFrac += frac;
  const ok = frac >= 0.5;
  const g = a.last?.g;
  const pnStr = g?.pn ? `project_note→${g.pn.project}/${g.pn.file || "log.md"}(${g.pn.mode})` : g?.isHeartbeat ? "HEARTBEAT_OK" : `[${g?.types.join(",") || "no-actions"}]`;
  console.log(`${ok ? "✓" : "✗"} ${a.passes}/${a.n}  ${a.scn.id}`);
  console.log(`        last emitted: ${pnStr}${g?.reasons?.length ? `  ·  ${g.reasons.join("; ")}` : ""}`);
}
console.log(`EMIT SCORE: ${passFrac.toFixed(1)}/${scoredScn} (sample-weighted)  ·  ${scoredScn ? Math.round((100 * passFrac) / scoredScn) : 0}%`);

// ── Dimension 2: are the notes the agent recorded faithful (no fabrication)? ──
if (JUDGE_FIDELITY) {
  let judged = 0, faithful = 0;
  console.log("\nDIMENSION 2 — content fidelity of recorded notes (LLM-judge; lower fabrication = better):");
  for (const a of agg.values()) {
    if (!a.fidJudged) continue;
    judged += a.fidJudged; faithful += a.fidFaithful;
    const ok = a.fidFaithful === a.fidJudged;
    console.log(`${ok ? "✓" : "✗"} ${a.fidFaithful}/${a.fidJudged} faithful  ${a.scn.id}`);
    if (a.fabs.length) console.log(`        fabrications: ${Array.from(new Set(a.fabs)).slice(0, 3).join("; ")}`);
    if (a.last?.g?.pn?.note) console.log(`        last note: "${String(a.last.g.pn.note).replace(/\s+/g, " ").slice(0, 140)}"`);
  }
  const fabRate = judged ? (judged - faithful) / judged : 0;
  console.log(`FIDELITY: ${faithful}/${judged} notes faithful  ·  fabrication rate ${Math.round(fabRate * 100)}%  ${fabRate === 0 ? "✓ (target 0%)" : "⚠ (target 0% for a durable-fact store)"}`);
}
