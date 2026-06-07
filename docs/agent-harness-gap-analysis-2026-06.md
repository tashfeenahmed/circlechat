# AI Agent Harness Landscape — Gap Analysis vs CircleChat (June 2026)

Deep research: 5 angles, 24 sources fetched, 115 claims extracted, top 25 adversarially
verified (3-vote, 2/3-to-kill) → **25 confirmed, 0 refuted** → 8 synthesized findings.
Lens: how leading harnesses win (technical + product/market) mapped to CircleChat's gaps.

## Headline verdict
The 2025–26 landscape has converged on four load-bearing patterns. CircleChat is
**directionally right** on multi-agent orchestration (the empirically-winning topology)
but **weak or missing** on the four things that make that topology actually reliable.
The single highest-leverage gap is the one we already suspected from the live system:
**actions scraped from free-text `<actions>` JSON instead of native tool-calling.**

## The four patterns the winners share

### 1. Native/structured tool-calling (NOT text-scraped actions) — the #1 gap
Every winning harness drives actions through typed `tool_use` blocks the runtime parses,
schema-validates, permission-checks, and dispatches — structurally separate from prose.
- Claude Code: "the model emits tool_use blocks… the harness parses them, checks
  permissions, dispatches them."
- OpenAI Agents SDK: even *agent handoffs* are native tool calls (`transfer_to_refund_agent`).
- Anthropic Tool Search / Programmatic Tool Calling: built entirely on the structured
  tool-call protocol.

**Why it matters for us:** text-scraping is the *root cause* of three failure modes I
chased all day. Malformed/absent action blocks → `applied:0` no-op runs. No schema
validation → hallucinated file paths. The action syntax IS the reply text → CoT/tool-JSON
leakage into chat. Native tool-calling eliminates all three *at the protocol level*.
Today's fixes (alias normalization, share error-feedback, reply-guard teaching hints)
were patches on this fundamentally fragile path. We already have `circlechat-mcp.mjs`
written but **not wired into `default_toolsets`** — the structured path exists and is
disconnected.

### 2. Gate "done" on verifiable final-state, not self-attestation
- Anthropic: "evaluate whether it achieved the correct final state," LLM judge scoring
  0.0–1.0 + pass/fail against a rubric (accuracy, citations, completeness, source quality).
- Devin: reliability = externally-verifiable **PR-merge rate (34%→67% YoY)**, not a self-claim;
  needs human review "when outcomes aren't straightforwardly verifiable."
- Sierra: bills only on resolved outcomes against criteria agreed **upfront** (contractual
  definition-of-done).
- Decagon: critical steps (identity, refunds) run "key validation steps in code."

**For us:** our "maker can't mark own work done" gate is the right shape but currently
just a *second agent's opinion*. It needs a rubric-based LLM-judge or artifact/test check
behind it. This is exactly the "skeleton passed as done" problem.

### 3. Externalize plan + progress into explicit ledgers (not chat history)
- Magentic-One's Orchestrator keeps two structured ledgers: a **Task Ledger** (facts,
  guesses, plan) and a **Progress Ledger** (current progress, per-agent assignment), with a
  **stall counter** that triggers re-planning when the team loops.

**For us:** agents re-derive context from noisy channel history every wake — a likely driver
of echo-chamber loops, credential-begging dead-ends, and acknowledged-but-no-op runs. We
have the board + goal→task trees (good substrate) but agents should read/write an explicit
facts+plan+progress ledger instead of reconstructing from chat.

### 4. Durable, checkpointed execution + declarative resumable approvals
- LangGraph: snapshots state at every super-step keyed by `thread_id`; a crashed run resumes
  from the last checkpoint, completed nodes skipped; persists per-node writes.
- OpenAI Agents SDK: tools flagged `needsApproval:true` **pause and return a serializable
  resumable state**; `approve()/reject()` resumes the *same run* — even after async delay.
  Input guardrails reject bad requests *before* the expensive/side-effecting step runs.

**For us:** our per-message ephemeral Docker model is the opposite of durable — every run
starts fresh, making long-horizon work, crash recovery, and resumable approvals hard. Our
approvals + "one-shot replay of approved actions" is an immature version of declarative
resumable approval.

## Orchestration topology: we're on the right track
The orchestrator-worker (lead-plans-delegates-to-specialists) pattern is empirically
validated — Anthropic's Opus-lead + Sonnet-subagents beat single-agent Opus **+90.2%** on
research evals. This supports our GM + planner + specialist design. **Two critical caveats:**
- Multi-agent costs **~15× more tokens** and is **poor for tightly-coupled work like coding**
  (Cognition's "Don't Build Multi-Agents" agrees). → Route coding/tightly-coupled tasks to a
  *single capable agent*; reserve fan-out for research/breadth.
- The win only materializes *with* the structured tool-calling, ledgers, and verification
  gates above. Fan-out without them multiplies the failure modes.

## Reliable autonomy = reactive loop + disciplined context management
Claude Code's core is "a simple while-loop that calls the model, runs tools, and repeats"
(reactive, not one big upfront plan) plus a **graduated multi-stage compaction pipeline run
before every model call** (budget reduction → snip → microcompact → context collapse →
auto-compact). Oversized tool output is persisted to disk with a 2KB preview, not dropped.
Tool Search defers tool-def loading (`defer_loading:true`, ~85% fewer tool tokens, accuracy
79.5%→88.1%); Programmatic Tool Calling keeps intermediate results out of context (−37% tokens).
**For us:** offload large artifacts to `/workspace` files with previews instead of dumping
into the reply; load skills/tools on demand. Cuts the context bloat that drives hallucinated
paths and the token cost of ephemeral runs.

## Product/market: trust is the moat
AI-employee products win adoption via (a) forced upfront scope/definition-of-done, (b)
verifiable outcomes, (c) code-enforced guardrails on sensitive actions (creds/deploys/spend),
and candidly bounding autonomy to scoped, verifiable tasks (Devin: "senior at planning,
junior at execution"; "performs worse when you keep telling it more after it starts").
Sierra's outcome-based pricing is itself a trust mechanism. → Our credential dead-ends and
quality misses are *trust* failures; the technical verification gate is also the GTM story.

## Prioritized recommendations (impact × effort)

| # | Change | Impact | Effort | Why |
|---|--------|--------|--------|-----|
| 1 | **Wire MCP/native tool-calling into agent toolsets**; make `<actions>` the fallback, not the only path | 🔴 Highest | Med–High | Kills no-op runs, hallucinated paths, CoT/JSON leakage at the protocol level. `circlechat-mcp.mjs` already exists, just unwired. Verify gateway/FreeLLMAPI preserves `tool_use` schemas end-to-end (a `supports_tools` route gate already exists). |
| 2 | **Verification gate before `done`**: LLM-judge rubric for open-ended deliverables, artifact/test check for code; per-task-type | 🔴 High | Med | Fixes "skeleton passed as done." Upgrades the existing maker/reviewer gate from opinion to rubric. |
| 3 | **Externalize plan+progress ledger** per goal/agent + stall counter → re-plan | 🟠 High | Med | Stops re-deriving from chat; attacks echo loops, dead-ends, no-op runs. Board is a good substrate. |
| 4 | **Durable checkpointed task/agent state** (resume-from-last-step; keep containers stateless) | 🟠 Med–High | High | Long-horizon reliability, crash recovery, resumable approvals. Reconcile with ephemeral Docker by externalizing all state to a checkpoint store. |
| 5 | **Declarative resumable approvals + pre-flight guardrails** (reject before container spins up) | 🟠 Med | Med | Matures approvals; cheap guardrails save tokens. Pairs with #1. |
| 6 | **Context discipline**: artifact-to-file-with-preview, on-demand skill/tool loading, reactive loop w/ compaction | 🟡 Med | Med | Cuts hallucinated paths + ephemeral-run token cost. |
| 7 | **Routing policy**: single capable agent for coding/tightly-coupled; fan-out only for breadth/research | 🟡 Med | Low–Med | Avoids the 15× tax + multi-agent's coding weakness. |

## Honest caveats
- All 25 verified claims describe what the *leaders* do; none measure CircleChat. The
  mapping to our failure modes is reasoned inference from the architecture description —
  validate against the actual codebase before committing effort.
- Several headline numbers are **vendor self-reports**, not independent benchmarks:
  Anthropic's +90.2% (internal eval, ~15× tokens, breadth-only), Devin's 34%→67% (Cognition
  defines "merged"), Anthropic's tool-token/accuracy figures (own MCP evals). Cite as vendor claims.
- Claude Code internals come from arxiv 2604.14228v1 ("Dive into Claude Code"), a well-
  corroborated *third-party* analysis — stage names/version numbers are point-in-time.
- A contrarian source (Diagrid) argues checkpoint-level durability is weaker than true
  durable execution (mid-node granularity, exactly-once) for production.

## Open questions to resolve before building
1. Migration cost from `<actions>`-scraping to native/MCP given the custom gateway —
   do all routed models reliably support `tool_use`, and does the gateway preserve schemas?
2. Verification gate: LLM-judge rubric vs test/artifact gating — likely **per-task-type**
   (code→tests, research→rubric).
3. Reconcile durable checkpointing with ephemeral Docker — externalize all state, or move to
   longer-lived sessions?
4. Routing policy for decompose-vs-single-agent, and how it interacts with the existing planner.

### Sources (primary-weighted)
Anthropic: multi-agent-research-system, advanced-tool-use, effective-harnesses-for-long-running-agents ·
OpenAI: Agents SDK handoffs, guardrails-approvals, SWE-bench Verified · LangGraph durable-execution ·
Microsoft Magentic-One · Cognition: Devin 2025 review, Don't Build Multi-Agents · Sierra outcome-pricing ·
Decagon AOP · MCP spec 2025-06-18 · arxiv 2604.14228v1 (Dive into Claude Code), arxiv 2507.21017 · Berkeley RDI benchmarks
