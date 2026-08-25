# CircleChat vs Buzz vs Duet

**Capability and gap analysis — 6 August 2026** · **Revised 25 August 2026**

> **Revision note (25 Aug 2026).** The original assessment was written against
> the repository as it stood on 6 August, and its CircleChat column has since
> gone stale in one direction: it records as absent a whole tier of capability
> that has shipped and is running in `main`. The connector/MCP registry, signed
> incoming webhooks, durable user-authored workflows with persisted wait/poll
> states, real model-usage accounting, and the unified "Needs you" review queue
> were all delivered in the P0/P1 platform work, and the table still showed `—`
> for several of them. Every row below was re-checked against the code before
> being changed, and each revised cell names the module that implements it so
> the next reader can verify rather than trust.
>
> **Two rows were deliberately NOT promoted to ✅ despite shipping code:**
> automatic model routing and the advisor escalation. CircleChat computes a
> routing tier and puts it in the agent's context packet as a *recommendation* —
> there is no gateway forcing the swap and no mid-turn re-route, so it is not
> parity with Duet's router. Likewise `advisor` exists only as a pricing/routing
> tier, not as an agent-callable "consult a stronger model" primitive. Both are
> `◐`. Competitor columns were not re-assessed and are unchanged.

## Executive read

These products overlap, but they are not the same product with different branding.

| Platform | Product centre of gravity | Strongest current advantage | Most important current weakness |
| --- | --- | --- | --- |
| **CircleChat** | A self-hosted operating system for governed teams of humans and autonomous agents | Structured execution: mission → goals → dependency-aware tasks → versioned deliverables → review/verification, with scopes, approvals, budgets, and recovery controls | No large first-party SaaS connector catalogue (the generic HTTP/MCP registry ships, but each provider still needs configuring), no native Git surface, no enforced model router, and no hosted-app deployment |
| **Buzz** | A signed collaboration workspace and software forge where humans, agents, workflows, and Git activity share one event log | Cryptographic identity, tamper-evident history, rich collaboration, desktop clients, YAML automation, and native Git/branch/CI workflows | General project/goal management is thin, approval execution is incomplete, and there is little public evidence of cost control, deliverable verification, or autonomous-work recovery |
| **Duet** | A managed cloud coworker for running business work across tools, persistent memory, schedules, boards, and hosted apps | 10,000+ integrations, durable multi-day relays, model routing, context-graph memory, isolated managed runtime, and instant app hosting | The full platform is not self-hostable/open-source; public materials do not show CircleChat-level goal governance, versioned task evidence, or Buzz-level signed collaboration/Git infrastructure |

The strategic conclusion is not “copy both.” CircleChat already has the hardest-to-fake governance spine. It should add **Duet-like reach and durability** and **Buzz-like developer-work context**, while keeping goals, evidence, verification, approvals, and spend control as the product’s defining layer.

## Method and confidence rules

- **CircleChat** was assessed from this repository, including schema, routes, UI, worker, tests, and operator configuration. A feature counts as present only when implementation evidence exists.
- **Buzz** was assessed from Block’s current public repository. Where its README says “being wired up,” this report does not count the feature as complete even if a vision document describes the intended end state.
- **Duet** was assessed from its current public product pages and the open-source `duet-agent` harness linked by Duet. The hosted product is not open-source, so “not found” means **not publicly evidenced**, not proof that private code does not exist.
- Marketing claims are recorded as claims, not independently benchmarked performance results.

Legend: **✅ present** · **◐ partial, limited, optional, or not fully evidenced** · **🚧 explicitly in progress/planned** · **— not found in the reviewed implementation/public materials**.

## 1. Product, delivery, and ownership

| Capability | CircleChat | Buzz | Duet | CircleChat implication |
| --- | --- | --- | --- | --- |
| Primary product shape | ✅ Team chat plus governed multi-agent work OS | ✅ Team workspace plus event relay and software forge | ✅ Managed AI coworker workspace and runtime | CircleChat’s positioning should lead with governed outcomes, not merely “Slack with agents.” |
| Open-source platform | ✅ Full platform, MIT | ✅ Full platform, Apache-2.0 | ◐ `duet-agent` is Apache-2.0; hosted Duet platform is not published as open-source | Keep full-stack openness prominent; it is a real advantage over Duet. |
| Self-hosting | ✅ Docker Compose stack | ✅ Docker/relay deployment | — Managed cloud is the public product | Preserve one-command self-hosting and add a smoother managed path. |
| Managed hosting | ◐ Managed cloud is linked, but the repository is primarily the self-hosted product | ✅ Block-hosted communities plus independent relays | ✅ Core delivery model | CircleChat needs the managed service to remove setup friction if it wants Duet’s SMB market. |
| Multi-workspace / tenant boundary | ✅ Multiple workspaces with membership and workspace-scoped data | ✅ Host-selected communities; formal multi-community isolation model | ✅ Organization-level isolated server/sandbox | CircleChat has the model, but should document and test isolation as explicitly as Buzz. |
| Client surfaces | ✅ Browser web app | ✅ Tauri desktop on macOS, Windows, and Linux; repository web surface | ✅ Browser workspace; legal terms mention an app, but public feature detail is limited | A desktop wrapper/PWA is useful; native mobile is not yet the highest-value gap. |
| Mobile client | — | 🚧 Flutter clients in active development | ◐ A mobile application is referenced in terms, but product coverage is not clear | Defer until notifications and integrations create enough mobile value. |
| Pricing model | ✅ Self-hosted software is free; bring your own model/runtime | ✅ OSS self-hosting and currently free Block-hosted communities | ✅ Usage-based, model tokens passed through at cost, unlimited seats | Managed CircleChat should make model/runtime costs visible and predictable. |
| Model-provider ownership | ✅ Bring any HTTP/WS agent runtime and its chosen model | ✅ Bring providers/agents; Buzz supplies the workspace, not the brain | ✅ Managed gateway across 900+ models plus connected subscriptions/BYO gateways in the agent harness | CircleChat needs a central optional gateway without sacrificing BYO. |

## 2. Human collaboration and workspace UX

| Capability | CircleChat | Buzz | Duet | CircleChat implication |
| --- | --- | --- | --- | --- |
| Humans and agents as first-class members | ✅ Same member directory, channels, DMs, tasks, org chart, and notifications | ✅ Same signed identity model and room affordances | ✅ AI participates as a named shared teammate; multiple agents can share workspace memory | Core parity and a continuing CircleChat strength. |
| Open/public and private channels | ✅ Channels can be private; membership enforced | ✅ Open and hidden invite-only channels | ✅ Channels are publicly documented; permission detail is less clear | No urgent gap. |
| Direct messages | ✅ Human/agent DMs | ✅ 1:1 and group DMs, up to nine participants | ◐ Group chats/threads are documented; DM semantics are not clear | Group DMs would close a small collaboration gap. |
| Threads | ✅ Message threads and thread-triggered agent wakes | ✅ Mandatory topic sub-replies in Stream plus Forum replies | ✅ Threads are publicly documented | Strong parity. |
| Long-form forum | — | ✅ Dedicated asynchronous Forum surface | — Not found | Useful for community products, but not a core execution priority. |
| Reactions | ✅ Emoji reactions, available to agents | ✅ Signed reactions and reaction workflow triggers | — Not found in public Duet material | CircleChat already has richer social collaboration than Duet publicly shows. |
| Mentions | ✅ Member, `@everyone`, and `@channel` mentions with agent wakes | ✅ Mentions and agent participation | ◐ Collaboration is clear, but mention behaviour is not publicly detailed | No material gap. |
| Presence and typing | ✅ Live presence and typing indicators | ✅ Presence and typing for humans and agents | — Not publicly evidenced | CircleChat is ahead of Duet on real-time team-chat fidelity. |
| In-app notifications | ✅ Notification centre for mentions, DMs, task events, approvals, and system events | ✅ Home/activity feed and in-app notifications | ◐ Agents post alerts to channels; a dedicated notification centre is not publicly detailed | Keep improving actionable notifications and escalation grouping. |
| Push notifications | — | 🚧 Planned | — Not publicly evidenced | Add after a PWA/mobile surface exists. |
| Workspace search | ✅ Permission-aware conversation search; agents have search API | ✅ One search index across conversation, workflow, approval, and Git events | ◐ Hybrid memory retrieval exists; broad end-user workspace search is not clearly documented | Expand CircleChat search beyond messages to tasks, goals, approvals, artifacts, and runs. |
| Files and media | ✅ Upload, paste/drop, previews, file browser, deletion, and type-aware viewer | ✅ Media uploads, thumbnails, and frame-specific discussion | ✅ Persistent files shared by team and agents | CircleChat is competitive; media annotation is a Buzz edge. |
| Collaborative channel document/canvas | — | ✅ One shared canvas per channel, writable by humans and agents | — Not found | A lightweight project brief/decision canvas would improve context without becoming a full docs suite. |
| Voice huddles | — | ◐ Voice relay exists; README says lifecycle work is still being wired | — Not found | Low priority unless customer demand proves synchronous voice matters. |
| Message edit and soft delete | ✅ Edit/delete with timestamps | ✅ Edit/delete; soft-deleted events remain auditable | — Public behaviour not detailed | CircleChat should retain immutable audit metadata when content is edited/deleted. |
| Guest access | — Only admin/member workspace roles | ✅ Channel-scoped guests are designed and documented | — Public role detail is limited outside Enterprise RBAC | Add scoped guests for clients, contractors, and reviewers. |
| Moderation/reporting | — No dedicated moderation queue | ✅ Private reports, owner/admin queue, enforcement, and audit | — Not found | Needed only if CircleChat expands beyond trusted teams. |
| Org chart/reporting lines | ✅ Humans and agents can have `reportsTo`; agents also have titles, briefs, and capabilities | — Teams/personas exist, but a reporting hierarchy is not a core documented model | — Not publicly evidenced | Distinctive CircleChat capability; use it in routing, permissions, and roll-ups. |

## 3. Work management and orchestration

| Capability | CircleChat | Buzz | Duet | CircleChat implication |
| --- | --- | --- | --- | --- |
| General task system | ✅ Workspace task model and UI | ◐ Agent jobs/handoffs exist, but Buzz’s own current integration proposal says conversations lack a structured path into project tracking | ✅ Agent task list plus executable Boards | CircleChat has the strongest general work record today. |
| Kanban board | ✅ Backlog, in progress, blocked, review, done; drag/drop | — No general-purpose kanban found | ✅ User-defined Board columns act as executable workflow states | Add configurable columns and per-column automation to match Duet without losing governance. |
| Task metadata | ✅ Assignees, labels, due date, progress, source channel/message, comments, activity | ◐ Git/review jobs have domain metadata; no comparable general task schema found | ◐ Boards/cards are present; field depth is not publicly documented | CircleChat is ahead on structured task detail. |
| Subtasks | ✅ Parent/child task hierarchy | — Not found | — Not publicly evidenced | CircleChat edge. |
| Task links and dependencies | ✅ Relates, blocks, duplicate; unconditional and conditional branch edges | ◐ Workflow step dependencies exist, not general task dependencies | ◐ Board state transitions exist; dependency graphs are not publicly detailed | Keep dependency-aware execution central to the product story. |
| Automatic dependency release | ✅ Blocked tasks wake their assignees only when prerequisites complete | ◐ Workflows coordinate steps | ✅ Board stages/relays advance work | Strong parity; expose the dependency graph more visibly. |
| Goals and projects | ✅ Nested project/goal hierarchy with owners and completion roll-up | — No structured goal tree found | — No structured goal tree publicly evidenced | Major CircleChat differentiator. |
| Goal decomposition | ✅ LLM planner validates and materialises a dependency graph of tasks | — Not found as a platform feature | ◐ Agents can plan work, but no equivalent governed goal-to-DAG surface is public | Keep planning deterministic, inspectable, and schema-validated. |
| Capability-based routing | ✅ Planner assigns tasks using agent capabilities, titles, briefs, and org context | ◐ Personas and teams exist; agents can orchestrate other agents | ◐ Agents/skills can execute in parallel; automatic task-to-agent routing details are limited | Make routing decisions visible and editable by humans. |
| Workspace mission → new goals | ✅ Daily mission planner proposes bounded, deduplicated goals with backpressure | — Not found | ◐ Persistent coworker runs recurring business jobs, but mission-to-goal generation is not public | Unique and powerful; add human policy controls before enabling by default at scale. |
| Goal progress ledger | ✅ Plan, facts, guesses, progress notes, dead ends, typed loop/progress assessment | — Not found | ◐ Context graph preserves decisions and precedents; not a goal ledger | CircleChat’s ledger plus Duet-style decision memory would be a strong combination. |
| Review queue and SLA escalation | ✅ Review state, deliverable checks, stale-review escalation, and a unified `GET /needs-you` inbox unioning approvals, task reviews, failed verifications, stalled goals, workflow waits, budget warnings, and connector errors (`api/src/routes/needs-you.ts`) | ◐ Code review surface and merge approvals | ◐ Human approval stages/blocked Board columns | Shipped; next step is per-item SLA policy rather than a new surface. |
| Reusable agent teams | ◐ Org chart, profiles, capabilities, and team export/import; no named team template UI | ✅ Built-in/operator-defined personas and named teams | ✅ Shared skills/agents; parallel channels and agent harness subagents | Add named, reusable team blueprints on top of existing export/import. |
| Agent-authored delegation | ✅ `delegate_to` creates/assigns work with a structured brief | ✅ Agents can orchestrate other agents and create workspace resources | ✅ Relay states can invoke subagents; Boards assign AI to stages | Strong parity. |
| Human-authored workflow builder | ✅ Users author JSON state machines (`api/src/lib/workflow-definition.ts`, `routes/workflows.ts`); definition-first, not a drag-and-drop canvas | ✅ YAML-as-code workflows | ✅ No-code executable Boards plus agent-authored relays | Shipped. Remaining gap is authoring ergonomics, not capability: a visual editor over the existing definition. |
| Long-running state machine | ✅ `workflowRuns`/`workflowSteps` persist `agent`, `connector`, `wait`, `approval`, `poll`, and `terminal` states with per-attempt records (`api/src/lib/workflow-engine.ts`) | ◐ Workflow runs and schedules exist; durable agent wait semantics are not a headline capability | ✅ Relays persist `agent`, `script`, `poll`, `timer`, and `terminal` states for jobs lasting days or months | Shipped on BullMQ. Next: link workflow runs to goals and the ledger so a job's history reads as one story. |
| Trigger catalogue | ✅ Built-in mention, DM, channel, thread, task, approval, schedule, ambient, test, and continuation triggers, plus signed webhook and connector-event workflow starts (`api/src/routes/workflows.ts`) | ✅ Message, reaction, schedule, and webhook workflow triggers | ✅ Cron, webhooks, Slack/email triggers, Boards, and polls | Shipped. Next: a user-facing trigger catalogue in the UI rather than definition-only. |
| Conditional workflow logic | ✅ Conditional task edges plus per-state transition conditions in the workflow definition language (`transitionFor()`) | ✅ YAML conditions | ✅ Agent-reasoned Board transitions and relay routing | The DSL exists; the editor does not. Build the visual layer over it. |

## 4. Agent runtime, tools, models, and extensibility

| Capability | CircleChat | Buzz | Duet | CircleChat implication |
| --- | --- | --- | --- | --- |
| Agent connection modes | ✅ Long-lived WebSocket and webhook/HTTP adapters | ✅ Nostr relay, agent-first CLI, ACP harness, and MCP surface | ✅ Hosted agents, CLI/SDK, file protocol, MCP, and external agent connection | CircleChat’s HTTP/WS contract is simple; adding standards support would broaden adoption. |
| Supported agent families | ✅ Hermes, OpenClaw, and custom runtimes | ✅ Goose, Codex, Claude Code, built-in Buzz agent, and custom tools | ✅ Duet agent, Codex, Claude/OpenClaw-style agents, scripts, and external file-capable agents | Add a generic ACP adapter and document external harness recipes. |
| Agent SDK/CLI | ◐ Typed HTTP/WS contract and agent API; no polished standalone CLI/SDK | ✅ `buzz-cli`, typed SDK, ACP, MCP | ✅ Open-source CLI and SDK | Ship an official TypeScript/Python SDK and CLI. |
| Central model catalogue | — Model selection is delegated to each external runtime | ◐ Provider can be swapped; no central multi-provider catalogue is a core feature | ✅ 900+ models and multiple gateways | Add an optional gateway/catalogue, keeping BYO agents intact. |
| Automatic model routing | ◐ `chooseModelTier()` classifies by trigger/keyword/length across four priced tiers, but the choice reaches the runtime as `packet.modelRoute` — a recommendation, not an enforced swap, and never mid-turn (`api/src/lib/model-routing.ts`) | — No public automatic router | ✅ Tier-based classifier routes by task and can re-route mid-turn | High-value Duet feature to borrow. |
| Advisor/escalation model | ◐ An `advisor` routing tier exists for high-stakes work, but there is still no agent-callable primitive to consult a stronger model mid-turn (`api/src/lib/model-routing.ts`) | — Not found | ✅ `ask_advisor` escalates consequential decisions | Add an optional planner/reviewer escalation route before inventing a complex router. |
| Per-message/per-task model choice | ◐ Agent profile stores a model; runtime ultimately decides | ◐ Agent persona/provider configuration | ✅ Model/tier can be chosen per message/session | Improve human visibility and override controls. |
| Skills | ✅ Per-agent skill files, equip/quarantine/restore, UI editing, routing descriptions | ✅ Persona packs and MCP tool composition; repository carries agent skills | ✅ Shared skills library and skill allowlists | Build discovery, versioning, trust, and workspace/team assignment around the existing skills layer. |
| MCP | ✅ Workspace registry of remote MCP servers with JSON-RPC `tools/list`/`tools/call`, encrypted secrets, and per-agent grants (`api/src/lib/connector-runtime.ts`) | ✅ MCP is a first-class tool boundary | ✅ Remote MCP plus Composio integration layer | Shipped. Next: server discovery and a trust/versioning model for installed tools. |
| SaaS connectors | ◐ Connector registry with OAuth 2, encrypted credentials, health checks, and per-agent grants ships (`api/src/routes/connectors.ts`), but it is a registry for generic HTTP/MCP endpoints — there is still no first-party Gmail/GitHub/Slack/CRM catalogue | — No comparable integration catalogue; generic MCP/workflows can be wired | ✅ 10,000+ integrations via Composio plus direct/custom APIs | Primitives shipped; the gap is now catalogue breadth. Curate a handful of high-value presets rather than building every connector. |
| Web search/browser | ✅ Agent API search/browser endpoints and installable browser skill | ◐ Can be supplied through MCP/tools; no native browser feature highlighted | ✅ Full internet, web search, scraping, and Firecrawl-powered skills | CircleChat needs first-class browser observability and domain policies. |
| Code execution | ✅ Optional hardened throwaway Docker sandbox for Python/bash; agent containers also carry tools | ◐ Shell/file MCP runs at the operator’s trust level with bounded processes | ✅ Isolated workspace sandbox plus agent coding tools and guardrails | CircleChat has a strong sandbox story; expose results in the run UI. |
| Persistent workspace filesystem | ✅ Shared `/workspace`, project markdown layer, object store, and agent homes | ✅ Relay media/canvases/repos; agent working directories are operator-managed | ✅ Private persistent server/filesystem per organization | Strong parity. |
| Image/video model access | — No model-media gateway | — Not a core agent surface | ✅ Gateway includes image and video models; memory can observe images | Add only after the central gateway exists. |
| Mid-run interruption/steering | ✅ `POST /agent-runs/:id/control` and `/workflow-runs/:id/control` support `cancel`, `steer`, `follow_up`, `extend`, `claim`, and `release`, permission-gated and audited (`api/src/routes/run-controls.ts`) | ◐ Relay steering is part of remote-agent design; implementation status is unclear | ✅ Native interrupts and queued follow-ups in the open agent harness | Shipped. Next: surface steering in the run viewer, not just the API. |
| Multi-turn continuation | ✅ Optional, budget-checked, action-gated, and depth-capped continuation | ✅ Agent sessions self-summarize and continue; up to eight concurrent ACP sessions | ✅ Durable turn state, relays, compaction, and process-independent resume | CircleChat should evolve continuations into explicit durable jobs. |
| Remote agent deployment | — Operators provision runtimes themselves | 🚧 Provider-based remote deployment is specified/planned | ✅ Managed remote runtime is the product | Managed CircleChat should provision agent runtimes without taking away self-host freedom. |

## 5. Memory, knowledge, and context

| Capability | CircleChat | Buzz | Duet | CircleChat implication |
| --- | --- | --- | --- | --- |
| Shared team memory | ✅ Shared editable memory block injected into every agent | ◐ Shared channel history, canvas, project memory, and search | ✅ One workspace memory shared by every agent | Strong parity. |
| Per-agent memory | ✅ Private editable blocks plus scoped KV memory | ◐ Agent history/memory is community-scoped; detailed structure is not prominent | ✅ Curated and observational memory persists across sessions | CircleChat has good primitives but weaker automatic curation. |
| Conversation/task-scoped memory | ✅ KV scopes for global, conversation, and task contexts | ◐ Context is naturally room/project scoped | ◐ Channels/files scope work; lower-level memory is retrieved by relevance | CircleChat edge in explicit scope control. |
| Semantic workspace recall | ✅ Embedding-based RAG for artifacts, messages, tasks, and notes | ◐ Permission-aware Postgres full-text search; vector recall is not documented | ✅ Hybrid pgvector and keyword retrieval fused with ranking | Upgrade CircleChat retrieval quality and show citations/receipts in the UI. |
| Decision/precedent memory | ◐ Goal ledger records facts, guesses, progress, and dead ends, but not a general decision graph | — Signed history is auditable but not automatically distilled into precedent | ✅ Observer and reflector preserve inputs, alternatives, user steers, policies, precedents, and exceptions | Highest-value memory improvement: add observation/reflection on top of existing blocks and RAG. |
| Automatic memory curation | ◐ Optional memory janitor plus agent-authored block edits | — Not found as a structured automatic layer | ✅ Three-layer observer/reflector system with dedicated evals | Build a conservative, inspectable memory observer with human correction. |
| Task-thread condensation | ✅ Rolling summary of older task comments | ◐ Agent session compaction/summarization exists | ✅ Session and global reflection/compaction | Strong base. |
| Project-file context injection | ✅ Markdown project index, lexical/semantic matching, and capped prompt injection | ✅ Repos, canvases, and unified project search | ✅ Files, skills, apps, and context loaded from the persistent server | Strong parity. |
| Memory inspection/editing | ✅ Agent detail UI and API allow humans/agents to inspect/edit memory | ◐ Search and relay history are visible; structured memory controls are unclear | ✅ CLI commands inspect/search memory; product memory is workspace-local | Make provenance and “why this was recalled” visible. |
| Multimodal memory | — Text-centric memory/RAG | — Not found | ✅ Screenshots and UI captures are observed into recallable text | Later enhancement after image-capable model support. |

## 6. Automation and external reach

| Capability | CircleChat | Buzz | Duet | CircleChat implication |
| --- | --- | --- | --- | --- |
| Scheduled work | ✅ Per-agent heartbeats plus daily mission and periodic goal/review sweeps | ✅ Scheduled YAML workflows | ✅ Cron jobs and durable timers | Expose schedules as user-owned objects, not only agent configuration. |
| Event-triggered work | ✅ Rich built-in product events | ✅ Message/reaction/webhook events | ✅ Webhooks and connected-app triggers | Turn the existing event bus into a safe workflow trigger API. |
| Incoming webhooks | ✅ `POST /api/hooks/:endpointId` with HMAC-SHA256 over `timestamp.rawBody`, 5-minute replay window, delivery-id dedupe, and secret rotation (`api/src/lib/signed-webhook.ts`) | ✅ Workflow webhook triggers | ✅ Relays/apps can receive webhooks | Shipped. Next: per-endpoint rate limits and payload schemas. |
| Outgoing API actions | ✅ `invokeConnector()` calls registered HTTP/MCP endpoints under per-agent grants, with path-escape blocking, a 1 MB response cap, and timeout clamps (`api/src/lib/connector-runtime.ts`) | ◐ Workflows/agents can call tools through MCP/CLI | ✅ Broad connector and arbitrary API reach | Shipped with grants; next is folding connector calls into the risk/approval gate. |
| No-code workflow authoring | — Not present | — YAML is code/config | ✅ Executable Boards described in plain English | Add stage rules to the existing board before building a separate canvas. |
| Workflow-as-code | ✅ Workflows are a compact JSON definition (start state + up to 100 typed states) validated on write (`parseWorkflowDefinition()`) | ✅ YAML workflows in project/workspace | ◐ Relays are defined through SDK/agent logic; skills are files | Shipped as JSON. Next: export/import and version history for operators. |
| Workflow traces | ✅ Agent run traces plus a first-class `workflowRuns`/`workflowSteps` object linking every step's input, output, attempt, error, and originating agent run | ✅ Every workflow step is traced in the shared event log | ✅ Relay states and current state are observable | Shipped. Next: a single timeline view joining run, approvals, tasks, and artifacts. |
| Durable wait/poll | ✅ `wait`/`poll` states persist `waitKind`/`waitKey`/`waitUntil` in Postgres and wake via delayed BullMQ jobs, so a run survives a restart (`api/src/lib/workflow-engine.ts`); waits span 1s–30 days | ◐ Scheduled workflows; no comparable long-wait agent primitive documented | ✅ Poll and timer states survive without a live process | Shipped. Next: connector presets that exercise it for email and CRM follow-up. |
| Human checkpoint | ✅ Functional approval cards and review state | 🚧 Approval infrastructure exists; executor persistence/resume is incomplete | ✅ External actions require explicit approval; Boards can surface human stages | CircleChat currently has the most complete documented in-platform approval replay. |
| App-generated triggers | — No hosted app runtime | ◐ Webhooks can trigger workflows | ✅ Hosted apps/services and webhook endpoints share workspace context | App hosting can become a safe extension surface for CircleChat workflows. |

## 7. Governance, safety, cost, and observability

| Capability | CircleChat | Buzz | Duet | CircleChat implication |
| --- | --- | --- | --- | --- |
| Typed action allowlist | ✅ Server applies only known action shapes | — Agents receive platform tools; no equivalent output action allowlist is documented | ◐ Tool layer plus guardrails and approvals; exact hosted-platform allowlist is not public | Keep this as a core safety guarantee. |
| Per-agent action scopes | ✅ Safe default scopes; wildcard requires explicit opt-in | ◐ Cryptographic identity and channel membership scope access, but not fine-grained action types | ◐ Enterprise RBAC and integration permissions; agent action granularity is not public | Surface scopes as understandable permission bundles. |
| Risk-based action gating | ✅ Configurable low/medium/high action gate | — Not found; workflow approvals are partial | ✅ External actions require approval; semantic guardrails can warn/block tools | CircleChat has a strong foundation. |
| Approval decision and resume | ✅ Approve/deny, notes, agent wake, and auto-replay of eligible stored actions | 🚧 Schema/API/MCP/UI exist, but executor does not yet suspend and resume | ✅ External actions pause for explicit approval | CircleChat edge over Buzz; add expiry, delegation, and policy templates. |
| Secret handling | ✅ Approval-delivered values go directly to agent environment and are not stored in chat/DB; persisted output is redacted | ◐ Private keys and platform auth are well-defined; general action-secret delivery is not | ✅ Stored secrets become placeholders; real values are injected at the network layer to approved destinations | Duet’s network-layer secret broker is the stronger long-term model. |
| Reply/output guard | ✅ Rejects tracebacks, refusals, tool JSON leaks, repetition, secret leaks, and meta-narration | — No comparable content guard documented | ◐ Pattern and semantic guardrails protect commands/file writes; response filtering is not the focus | Preserve and expand with policy-specific output validation. |
| Sandboxed code | ✅ Networkless, read-only, non-root, capability-dropped, CPU/memory/PID/time limited container | ◐ Bounded shell process, but explicitly runs at operator trust | ✅ Firecracker-backed isolated sandbox plus language/runtime tools | Strong CircleChat security advantage over Buzz’s shell posture. |
| Cost metering | ✅ Per-event token/cost rows from runtime-reported usage, idempotent per run and priced from the workspace route table; estimates survive only as a visibly-labelled fallback (`api/src/lib/model-usage-store.ts`) | — Not found | ✅ Per-message token cost, per-agent tracking, usage reports, pass-through billing | Shipped exactly that. Next: make routing tiers budget-aware during planning. |
| Agent/workspace budget stops | ✅ Per-agent and workspace monthly caps, 80% warning, and hard stop | — Not found | ◐ Usage controls and auto-pause patterns are described; exact general product controls are not fully documented | CircleChat edge; make budget policy visible during planning. |
| Run history | ✅ Queued/running/ok/failed records with trigger, context, result, trace, cost, errors | ✅ Signed event history and workflow traces | ✅ Observable agent/relay progress and usage | Improve CircleChat’s run viewer to show every tool/action/approval/artifact link. |
| External observability | ✅ Optional Langfuse trace export plus Pino logs | ✅ Prometheus/configured service telemetry plus audit log | ◐ Usage reports and managed monitoring; export surface is not public | Add OpenTelemetry and admin export. |
| Tamper-evident audit | — Ordinary database audit rows | ✅ Hash-chain audit log plus signed Nostr events | — Enterprise audit logs are listed, but not cryptographically tamper-evident | Borrow signed/hash-chained audit only if regulated buyers need it; do not rewrite the platform around Nostr by default. |
| Deliverable existence gate | ✅ “Done” requires substantive task evidence for agent-completed work | — Not found | ◐ Board exit criteria/self-verification are described, but an enforced artifact gate is not public | CircleChat differentiator. |
| LLM deliverable verification | ✅ Optional rubric judge checks relevance/fabrication; rationale is stored | — Not found | ◐ Duet has memory evals and agent self-verification, not a documented per-task done gate | CircleChat differentiator; add eval sets and multiple verifier types. |
| Deterministic web render check | ✅ Optional headless Chromium observation before a web deliverable can pass | — Not found | ◐ Apps are hosted and run, but a review gate against acceptance criteria is not public | Extend to tests, PDFs, spreadsheets, links, and API health checks. |
| Run loop detection | ✅ Detects repeated and alternating action signatures, suppresses continuation, injects a break directive | — Not found | ◐ Relays have terminal states/guardrails; explicit behavioural loop detection is not public | CircleChat edge. |
| Goal stall recovery | ✅ Typed progress assessment, human escalation, optional capped re-plan preserving facts/dead ends | — Not found | ◐ Durable jobs persist, but stalled-goal re-plan semantics are not public | CircleChat edge. |
| Productivity anomaly alert | ✅ Flags agents that run repeatedly with zero applied actions and estimates wasted spend | — Not found | ◐ Managed monitoring is claimed; this exact behavioural alert is not public | Productize it in Analytics and recommendations. |
| Run reaper | ✅ Stuck running rows are closed/recovered | — Not found | ✅ Serverless/resumable turn state reduces sticky-process failure | Keep reliability controls visible to operators. |
| RBAC and SSO | ◐ Admin/member roles; no SSO or fine-grained human roles | ✅ Owner/admin/member/guest plus channel membership; enterprise SSO not prominent | ✅ Enterprise SSO and RBAC | P1 for larger organizations. |
| Encryption and credential isolation | ◐ TLS via Caddy; storage encryption is operator/infrastructure responsibility | ◐ TLS and storage-layer at-rest encryption; DMs are not E2EE | ✅ TLS, AES-256 at rest, isolated microVM, secret proxy | Document a hardened deployment profile and encryption responsibilities. |
| Formal isolation/security model | ◐ Workspace guards and tests, but no formal model | ✅ Host-derived boundary with TLA+/Tamarin claims in project docs | ◐ Single-tenant compute and provider compliance attestations | Add adversarial tenant-isolation tests before enterprise claims. |

## 8. Artifacts, apps, Git, and shipping work

| Capability | CircleChat | Buzz | Duet | CircleChat implication |
| --- | --- | --- | --- | --- |
| Task deliverable namespace | ✅ Task artifacts are named, versioned, attributed, content-hashed, and soft-deletable | — No task-artifact namespace found | ◐ Persistent files/apps exist; per-task version/hash semantics are not public | Major CircleChat edge. |
| Rich file viewer | ✅ PDF, Markdown, HTML sandbox, text/code, image, video, and audio | ✅ Media/repo/canvas views and annotations | ✅ Files and generated artifacts are inspectable; format list is not public | Strong parity. |
| Build web apps | ◐ Agents can write artifacts/code, but CircleChat does not turn them into managed applications | ◐ Agents can edit repos and canvases, not a general app-builder/host | ✅ Core product feature | A safe preview/publish path is a high-value Duet feature to borrow. |
| App hosting | — No application runtime | — No general user-app runtime | ✅ Apps deploy to shareable HTTPS URLs | P0/P1 depending on target segment. |
| Custom domains | — | — | ✅ One custom domain per app, automatic TLS, unlimited apps | Add after basic preview hosting works. |
| Native Git hosting | — Shared workspace files only | ✅ Smart HTTP Git backend | — Agents can work with repos, but Duet is not a native forge | Integrate GitHub/GitLab first; do not build a forge unless sovereignty demands it. |
| Branch as collaboration room | — | ✅ Branch channel carries patches, CI, review, approval, merge, and archives afterward | — Not found | A linked provider-backed “PR room” would capture most of the value at far lower cost. |
| Signed pushes/branch protection | — | ✅ Nostr-signed pushes and branch protections/approval events | — Not native | Integrate provider protections; native signed Git is a niche later bet. |
| Inline code review and CI events | — Not a native surface | ✅ Git events, patches, review, and CI in the channel/event log | ◐ Coding agents can run tools, but no native cross-repo review surface is public | Add GitHub/GitLab PR summaries, checks, diffs, and approvals into task/channel context. |
| Hosted webhook/service endpoint | — | ✅ Workflow webhook trigger, not arbitrary hosted app service | ✅ Agent-built app/service can expose a webhook | Useful extension point once app hosting exists. |
| Delivery QA | ✅ Evidence, verifier, render observation, and stored rationale before done | ◐ CI/maintainer approvals for code, no general artifact rubric | ◐ Agent/Board self-checking, no public universal deliverable gate | This is CircleChat’s best horizontal differentiator; expand rather than dilute it. |

## 9. CircleChat’s missing features, prioritized

### P0 — required to compete for real business workflows

| Missing capability | Competitor proof | Recommended CircleChat build | Why now |
| --- | --- | --- | --- |
| Integration/MCP catalogue with OAuth and scoped credentials | Duet advertises 10,000+ integrations; Buzz and Duet use MCP as a standard boundary | Add workspace connector registry, OAuth/secret broker, tool discovery, per-agent grants, approval policy, health status, and audit records | Without external actions, CircleChat governs work that cannot reach the systems where business work lives. |
| Durable user-authored workflows | Buzz has YAML automation; Duet has Boards and relays | Create first-class Workflow and WorkflowRun objects with trigger, state, transition, timer, poll, agent step, human step, terminal outcome, retry, and evidence links | This converts fixed internal automation into a platform. |
| Incoming webhooks and integration events | Buzz and Duet both accept webhook-driven work | Expose signed webhook endpoints with dedupe keys, rate limits, schemas, replay protection, and mapping to workflow starts | Necessary for CRM, inbox, CI, forms, and monitoring use cases. |
| Real model usage and routing | Duet tracks actual usage and routes across models | Let runtimes report usage; add an optional OpenAI-compatible gateway, price table, routing tiers, human override, and advisor route | Makes existing budgets accurate and improves quality/cost automatically. |
| Durable waits and resumable jobs | Duet relays persist timer/poll states for days or months | Persist job state separately from chat; resume on timer, webhook, approval, or poll result; link every turn to one job | Required for email follow-up, support, sales, procurement, and long-running research. |

### P1 — closes the most visible product gaps

| Missing capability | Competitor proof | Recommended CircleChat build | Why |
| --- | --- | --- | --- |
| Decision/precedent memory | Duet’s context graph preserves alternatives, steers, policies, and exceptions | Add an inspectable observer/reflector that writes typed decision memories with provenance and human correction | Existing RAG retrieves facts; this helps agents learn why decisions were made. |
| App preview and hosting | Duet builds and hosts apps with HTTPS/custom domains | Turn a task’s web artifacts into an isolated preview, then an approval-gated published app with logs and health checks | Makes CircleChat visibly deliver outcomes, not only files. |
| Provider-backed Git/PR rooms | Buzz’s branch-as-channel unifies conversation, patches, CI, and merge | Integrate GitHub/GitLab repositories, PRs, diffs, checks, reviews, and branch protection into channels/tasks | Captures Buzz’s developer value without building a Git server. |
| Executable board stages | Duet assigns an AI and instructions to each Board column | Make columns configurable and attach entry/exit rules, agent/skill, verification, escalation, and next transition | Fits CircleChat’s current board and verifier naturally. |
| Reusable team blueprints | Buzz has named persona teams; Duet shares skills/agents | Package agents, org relationships, skills, scopes, budgets, channels, and workflows as versioned templates | Existing team export/import is close; productize it. |
| Unified review inbox | All three products surface approvals/reviews in different ways | Merge task review, approvals, failed verification, stalled jobs, budget warnings, and connector errors into “Needs you” | Reduces the human supervisor’s coordination cost. |
| Cancellable/steerable runs | Duet supports native interrupts and follow-ups | Add cancel, steer, queued follow-up, timeout extension, and ownership controls to active runs | Essential once jobs last longer and perform external actions. |
| Enterprise access controls | Buzz has guest/channel boundaries; Duet lists SSO/RBAC | Add guests, custom roles, SSO/OIDC, service accounts, audit export, retention, and data residency controls | Needed for larger teams and client workspaces. |

Implementation status (2026-08-06): all eight P1 rows above are implemented end to end. The operator UI is under **Platform** and **Needs you**; schema/API/worker contracts are documented in [`p1-platform.md`](p1-platform.md), and `npm run test:p1-e2e` covers the release paths and isolation boundaries.

### P2 — valuable after the execution platform is complete

| Missing capability | Competitor proof | Recommendation |
| --- | --- | --- |
| Cross-object search | Buzz searches chat, workflow, approval, and Git in one index | Index tasks, goals, approvals, artifacts, runs, files, and connector objects with permission filters. |
| Channel canvas / decision brief | Buzz has agent-writable canvases | Add a lightweight durable channel/project brief, not a full document editor. |
| Desktop/PWA and push | Buzz ships desktop and is building mobile | Start with installable PWA, background notifications, deep links, and offline read cache. |
| Multimodal model/memory support | Duet gateway and memory support image/video work | Add after model gateway, then ingest visual observations with provenance. |
| Tamper-evident audit | Buzz hash-chains audit and signs events | Offer signed audit exports or chained records for regulated deployments without requiring Nostr everywhere. |
| Voice huddles and media annotation | Buzz has voice/media collaboration | Defer unless a target customer segment needs it. |

## 10. What Buzz and Duet are missing relative to CircleChat

### Buzz gaps

| CircleChat advantage | Buzz status | Why it matters |
| --- | --- | --- |
| Nested projects/goals with auto-decomposition and roll-up | No equivalent structured goal tree found | Buzz can coordinate conversation and code, but CircleChat can explain why each task exists and how it advances an objective. |
| General kanban/tasks with subtasks, dependencies, labels, due dates, progress, and comments | General project tracking is not a complete public surface; a current Buzz proposal explicitly identifies the missing path | CircleChat can operate non-code work and mixed teams without outsourcing the system of record. |
| Versioned, attributed, hashed task artifacts | Not found | Provides a durable evidence contract between agents and reviewers. |
| Enforced deliverable existence and LLM/render verification | Not found | “Done” means inspected evidence, not a message or optimistic status change. |
| Functional approval replay/resume | Buzz documents the executor gap | CircleChat’s approval is already part of execution, not only UI/schema. |
| Per-agent/workspace budgets and hard stops | Not found | Prevents autonomous cost runaway. |
| Reply guard, secret redaction, sandboxed code, and safe action scopes | Buzz has strong identity/channel security, but its shell runs at operator trust and equivalent output/action controls are not documented | CircleChat constrains model failure at several boundaries. |
| Loop detection, stall assessment, capped re-plan, run reaper, productivity alerts | Not found | CircleChat detects “alive but useless” agents, not only crashed infrastructure. |
| Org chart and capability-based task routing | Personas/teams exist, but structured reporting/routing is not the public centre | CircleChat can model accountability and delegation explicitly. |

### Duet gaps

| CircleChat advantage | Duet status | Why it matters |
| --- | --- | --- |
| Fully self-hostable/open-source collaboration platform | Only the agent harness is open-source; hosted product is managed | CircleChat operators can inspect, change, and own the entire control/data plane. |
| Structured project/goal hierarchy and planner-created dependency DAG | Not publicly evidenced | CircleChat gives autonomous work an inspectable plan and traceability to mission. |
| Rich general task record and versioned task deliverables | Boards/files exist; equivalent task/artifact semantics are not public | CircleChat makes review and responsibility more explicit. |
| Enforced per-task verifier with stored rationale and deterministic render observation | Duet discusses self-verification and memory evals, not an equivalent universal done gate | CircleChat can prove why work was accepted. |
| Server-side typed action contract and safe-default scopes | Duet has tools, approvals, guardrails, and Enterprise RBAC; equivalent hosted action typing is not public | CircleChat provides a narrow, auditable capability boundary independent of model behaviour. |
| Agent/workspace budget hard stops in the product schema | Duet has excellent real usage reporting; exact general hard-cap controls are less publicly specified | CircleChat has a clear governance primitive, though its current cost is estimated. |
| Real-time team-chat depth | Public Duet pages focus on channels/threads, not reactions, presence, typing, DMs, notifications, editing, or moderation | CircleChat is a more complete day-to-day team room. |
| Org reporting lines, capabilities, and ownership roll-up | Not publicly evidenced | CircleChat can express team structure, not only shared access. |
| Open database/audit schema and inspectable control plane | Hosted platform internals are private | Self-hosters can audit and extend CircleChat without vendor dependency. |

## 11. Recommended build sequence

The fastest route is to extend CircleChat’s existing primitives rather than add disconnected feature islands.

1. **Connector foundation:** external MCP registry, OAuth/secret broker, per-agent grants, connector health, and signed incoming webhooks.
2. **Durable job model:** Workflow + WorkflowRun + persisted states (`agent`, `tool`, `human`, `timer`, `poll`, `terminal`) linked to current agent runs.
3. **Executable board:** configurable stages, stage instructions/skills, entry/exit criteria, verifier, approval, escalation, and transition rules.
4. **Accurate model control:** optional gateway, actual token/cost ingestion, routing tiers, fallback, advisor, and budget-aware planning.
5. **Context graph:** provenance-backed observations, decisions, alternatives, user steers, policies, exceptions, reflection, and memory evals.
6. **App preview/publish:** isolated artifact preview, logs, health check, approval gate, stable URL, then custom domains.
7. **Git provider rooms:** repository linking, PR/diff/check events, code review, and merge approval; build native Git hosting only if customers demand sovereignty beyond provider integration.
8. **Supervisor experience:** one “Needs you” inbox and a job timeline joining task, agent runs, tool calls, approvals, artifacts, verification, and spend.

## 12. What not to copy yet

| Competitor feature | Recommendation | Reason |
| --- | --- | --- |
| Buzz’s Nostr protocol as the base of every object | **Do not re-platform now.** Borrow portable identities or chained audit records selectively. | Rewriting CircleChat’s data model would delay higher-value integrations and durable workflows; customers need the outcome more than the protocol. |
| Buzz’s native Git hosting | **Integrate first.** | GitHub/GitLab integration captures most value with far less security and operational surface. |
| Buzz voice, forums, and culture features | **Defer.** | They improve community depth but do not unblock agents doing useful governed work. |
| Duet’s enormous model catalogue on day one | **Start curated.** | A small tested routing set is easier to price, evaluate, and support than 900 indistinguishable choices. |
| Duet-style unrestricted app hosting | **Ship behind task evidence and approval.** | CircleChat can differentiate by treating a deployment as a governed deliverable with provenance, checks, and rollback. |
| A general drag-and-drop automation canvas | **Build executable columns and a compact workflow schema first.** | CircleChat already has tasks, dependencies, queues, triggers, and approvals; use them before introducing another abstraction. |

## Sources

### CircleChat implementation evidence

- [`README.md`](../README.md) — product scope and honest integration limits.
- [`api/src/db/schema.ts`](../api/src/db/schema.ts) — workspaces, identities, conversations, runs, approvals, memory, knowledge, notifications, goals, tasks, artifacts, verification, and ledgers.
- [`api/src/agents/executor.ts`](../api/src/agents/executor.ts) — typed actions, scopes, risks, approvals, delegation, memory, code, goals, tasks, and files.
- [`api/src/agents/context.ts`](../api/src/agents/context.ts) — per-trigger context assembly.
- [`api/src/worker.ts`](../api/src/worker.ts) — run lifecycle, budgets, idle gate, continuations, stuck detection, redaction, and traces.
- [`api/src/lib/planner.ts`](../api/src/lib/planner.ts), [`mission-planner.ts`](../api/src/lib/mission-planner.ts), and [`ledger-core.ts`](../api/src/lib/ledger-core.ts) — planning and progress model.
- [`api/src/lib/task-verifier.ts`](../api/src/lib/task-verifier.ts) and [`task-artifacts.ts`](../api/src/lib/task-artifacts.ts) — evidence and verification.
- [`api/src/lib/code-sandbox.ts`](../api/src/lib/code-sandbox.ts), [`budgets.ts`](../api/src/lib/budgets.ts), and [`redaction.ts`](../api/src/lib/redaction.ts) — governance boundaries.
- [`web/src/App.tsx`](../web/src/App.tsx) and page/component files — shipped UI surfaces.
- [`docs/CONFIG.md`](CONFIG.md) — operator-visible feature flags and defaults.

### Buzz primary sources

- [Buzz README — current works-today / being-wired status](https://github.com/block/buzz/blob/main/README.md)
- [Buzz platform vision and current status](https://github.com/block/buzz/blob/main/VISION.md)
- [Buzz architecture](https://github.com/block/buzz/blob/main/ARCHITECTURE.md)
- [Buzz agent and MCP architecture](https://github.com/block/buzz/blob/main/VISION_AGENT.md)
- [Buzz project/Git/branch-room design](https://github.com/block/buzz/blob/main/VISION_PROJECTS.md)
- [Buzz support: relays, invitations, agent privacy, and lack of E2EE](https://block.github.io/buzz/support.html)
- [Current Buzz proposal describing the missing structured conversation-to-project path](https://github.com/block/buzz/issues/2647)

### Duet primary sources

- [Duet product overview](https://duet.so/)
- [Duet small-business use cases and operating model](https://duet.so/use-cases)
- [Duet command-centre guide: channels, models, integrations, automations, and apps](https://duet.so/guides/how-to-build-your-ai-command-center)
- [Duet Boards / no-code agent workflows](https://duet.so/blog/loops-vs-duet-boards)
- [Duet pricing, model catalogue, usage, and Enterprise controls](https://duet.so/pricing)
- [Duet data protection and secret-isolation model](https://duet.so/data-protection)
- [Duet context-graph memory architecture and evals](https://duet.so/blog/how-duet-builds-and-evals-context-graphs)
- [Duet app custom domains and managed TLS](https://duet.so/blog/custom-domain-names-in-duet)
- [`duet-agent`: open-source memory, routing, relays, MCP, guardrails, and runtime](https://github.com/dzhng/duet-agent)
- [Duet managed agent hosting and durable wait/approval model](https://duet.so/blog/where-to-host-ai-agents)

## Bottom line

CircleChat does not need to become Buzz plus Duet. It needs to become the place where:

1. Duet-like agents can reach every business tool and stay on a job for weeks;
2. Buzz-like developer events can enter the same shared room; and
3. CircleChat’s existing governance decides what the team is trying to achieve, who owns each step, what evidence counts, what requires approval, when work is stuck, and what may be spent.

That third layer is the part neither competitor currently matches end to end.
