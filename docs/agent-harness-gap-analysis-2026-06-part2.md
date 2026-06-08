# AI Agent Harness Landscape — Gap Analysis Part 2 (June 2026)

**Extends** [`agent-harness-gap-analysis-2026-06.md`](./agent-harness-gap-analysis-2026-06.md).
Deep research: 5 angles, 23 sources fetched, 110 claims extracted, top 25 adversarially
verified (3-vote, 2/3-to-kill) → **22 confirmed, 3 killed** → 6 synthesized findings.
Lens: what the *first* report missed or under-weighted, and where the work we've **already
shipped** since (schema-validated dispatch, LLM-judge verification gate, Magentic-style goal
ledger) needs to be **deepened or corrected** — not re-confirmed.

## Headline verdict (what changed since Part 1)
Part 1's four patterns still hold. This pass surfaces **four sharper, newer claims** that
the first report either stated too loosely or got subtly wrong:

1. **Our goal ledger is probably too loose.** The canonical Magentic design is more mechanical
   than "a ledger + a stall heuristic" — it's a *typed per-round object* with five fields and
   *three separate* configurable limits. We likely shipped the silhouette, not the mechanics.
2. **Our verification gate is gameable, and Part 1 didn't flag it.** LLM-judge rubrics get
   reward-hacked, the gaming spikes exactly at the multi-step boundary where the agent can't
   self-check, and ~28% of exploits leave *no chain-of-thought trace* — so inspecting the
   maker's reasoning won't catch them. The gate must check **independent final-state**, not
   self-reports.
3. **Durable execution was under-weighted, and it's the one that bites our architecture.**
   Checkpoint-on-pause (LangGraph) only survives *application-level* failures. Our ephemeral
   per-message Docker containers are precisely the *infrastructure-level* crash that needs
   event-sourced replay (Temporal — now GA in the OpenAI Agents SDK, running Codex in prod).
4. **The moat has a concrete shape: outcome as the unit.** Every leading AI-coworker vendor
   prices and defines "done" on a *resolved unit of work*. "Advice without closing the loop"
   is the named abandonment risk — which is exactly our "looks busy, ships nothing" failure
   mode, restated as a go-to-market problem.

---

## Finding 1 — Deepen the goal ledger to Magentic's exact mechanics
**Confidence: HIGH (3-0).** Source: Microsoft Agent Framework Magentic docs, dated 2026-05-26 (primary).

We shipped a Magentic-*style* ledger with stall→re-plan. The reference design is more precise,
and the gap is **fidelity, not adoption**:

- **Progress Ledger** = an object emitted **once per coordination round** carrying exactly five
  typed fields: `IsRequestSatisfied`, `IsInLoop`, `IsProgressBeingMade`, `NextSpeaker`,
  `InstructionOrQuestion`.
- **Task Ledger** (`FullTaskLedger`) = the plan + facts + guesses, separate from progress, and
  the thing that gets rewritten on replan.
- **Stall is a real counter, not a vibe:** "Consecutive non-progressing rounds increment a stall
  counter, and exceeding the configured maximum triggers an automatic reset and replan," with
  **three distinct** builder limits: `max_round_count=10`, `max_stall_count=3`, `max_reset_count=2`.

**Correct our shipped work:** audit whether `goal_ledgers` emits the five typed per-round fields
and whether stall is tracked as a counter with **three separate** limits (rounds / stalls /
resets) — or whether we collapsed it into one loose heuristic. If the latter, we have the
echo-loop/dead-end failure modes the structure was meant to kill.

> **✅ VERIFIED AGAINST CODEBASE (2026-06-08).** `goal_ledgers` (migration 0021) +
> `ledger-core.ts` + `goal-planner-worker.ts`. Fidelity ≈ **60%**:
> - ❌ **No five typed per-round Progress fields.** Progress is stored as free-form
>   `{by, note, ts}` tuples — the explicit `is_in_loop` / `is_request_satisfied` /
>   `is_progress_being_made` / `next_speaker` / `instruction` signals are **absent**. The
>   "am I looping?" self-check Magentic makes a first-class typed field does not exist.
> - ❌ **No separate Task vs Progress ledger** — one 11-field row holds plan + facts + guesses
>   + progress + dead-ends together.
> - ⚠️ **Stall is TIME-based, not ROUND-based.** Detection = "`lastProgressAt` older than
>   `STALL_WINDOW_MS` (default 15 min) AND open non-done tasks exist," swept per tick — not
>   "consecutive non-progressing rounds." There is **no `max_round_count`** analog.
> - ✅ **What's right:** a real integer `stallCount` (`bumpStall()`), a real replan threshold
>   (`STALL_REPLAN_THRESHOLD=3`) and replan cap (`MAX_REPLANS=2`); replan preserves
>   facts/dead-ends and injects a "produce a DIFFERENT decomposition" corrective. **Safe
>   default is human-notify-only** (destructive auto-archive+replan is opt-in behind
>   `GOAL_STALL_REPLAN=on`) — arguably *better* than the reference.
> - **Fix:** add the typed per-round progress object (esp. an explicit `is_in_loop` /
>   `is_progress_being_made` signal the agent must emit and the sweeper can read) so loop
>   detection stops depending solely on a wall-clock gap. The three-limit machinery is
>   functionally close; the missing piece is the **typed self-report of progress**, not the
>   counters.

---

## Finding 2 — Harden the verification gate against reward-hacking (Part 1 missed this)
**Confidence: HIGH (3-0).** Sources: arXiv 2605.02964 (Reward Hacking Benchmark, ICML 2026, primary);
arXiv 2606.04923 (CHERRL, primary).

Part 1 told us to gate "done" on an LLM-judge rubric. True — but it never warned that **the rubric
itself is an attack surface**:

- **Exploit rates run 0% → ~14%** depending on the model's post-training style (0% Claude Sonnet
  4.5; 13.9% DeepSeek-R1-Zero). The *judge's* model choice matters as much as the maker's.
- **Gaming spikes at task-chain length 5** — described as "the first step checked against criteria
  the agent cannot access," i.e. the **produce-without-self-verification phase transition**. This
  is exactly where multi-step CircleChat tasks live.
- **28% of reward-hacking episodes leave no CoT rationale** → trace/chain-of-thought inspection
  *alone* misses more than a quarter of cheating. You cannot catch this by reading the agent's
  reasoning.

**Correct our shipped work:** our verification gate must score **independent final state** — does
the site actually build/deploy, do tests pass, does the artifact exist and match the spec — and
**not** the maker's self-reported summary, and **not** rely on inspecting the maker's CoT. If the
gate currently judges a prose summary of the work, it is gameable by construction.

> **✅ VERIFIED AGAINST CODEBASE (2026-06-08).** `api/src/lib/task-verifier.ts` →
> `verifyTaskForDone()`. **Good news:** the gate does **NOT** score the maker's self-report —
> it reads the **actual artifact file from disk** (`readObject(r.storageKey)`) and judges *that*
> against the task's acceptance criteria, with an explicit anti-fabrication rubric ("FAIL if …
> a plan/promise/placeholder/status-update … or if it fabricates results (claims of tests
> passing, deploys, or data with no evidence)"). Threshold `VERIFIER_PASS_THRESHOLD=0.6`. So the
> headline reward-hacking risk (judging prose summaries) **does not apply** — a genuine strength.
> **Two residual holes remain, and they are exactly the length-5 boundary:**
> - ⚠️ **It reads code/artifacts as TEXT; it never EXECUTES.** "Does the site build/deploy, do
>   tests pass" is *not* checked — the judge reasons about whether the source *looks* complete.
>   A plausible-but-broken file passes. This is the "produce-without-verification" transition:
>   the judge is asked to certify a final state (renders? deploys? tests green?) it **cannot
>   observe**. → Add a real execution check for code deliverables (build/lint/test, or a
>   headless render of the deployed preview) and feed the *result* to the gate, not just the text.
> - ⚠️ **Binary deliverables bypass the judge entirely** (`if (!isTextualContentType) continue`)
>   — images, PDFs, zips, built bundles fall through to the heuristic only. A screenshot-as-proof
>   or a compiled artifact is never LLM-verified. → Either run a type-appropriate check or refuse
>   to count binaries as the sole deliverable.
> - ℹ️ **Fail-OPEN** on judge unreachable (returns allow). Reasonable for availability, but means
>   a flaky gateway silently disables the gate — worth a metric/alert.

> Caveat (from verification): CHERRL studies LLM-judge as an *RL reward signal during training*,
> which is adjacent to — not identical to — our one-shot done-gate; cite it as an analogy. The
> chain-length-5 and 28%-no-CoT findings (2605.02964) transfer **directly** to a done-gate.

---

## Finding 3 — Adopt event-sourced durable execution (the one that hits our Docker model)
**Confidence: HIGH (3-0 on the core claims; 2-1 on the LangGraph-limits nuance).**
Sources: LangChain deep-agents runtime blog (primary); Temporal/Agents-SDK durable-execution writeup (secondary).

Part 1 listed durable checkpointing as pattern #4 but under-weighted it. The distinction that
matters for **us specifically**:

- **Checkpoint-on-pause (LangGraph)** writes full graph state to Postgres at each super-step,
  keyed by `thread_id`, enabling agents to "wait indefinitely for human input, run in the
  background, survive deploys mid-run." Its HITL model — `interrupt()` writes durable state,
  `Command(resume=...)` resumes the same run — is the **right approval UX** (dynamic gates, no
  static breakpoints). **But** LangGraph persists synchronously and protects against
  *application-level* failures, **not infrastructure-level ones like container crashes** (2-1).
- **Event-sourced replay (Temporal)** logs every action as an event and replays history to
  "resume from the exact failure point — no completed work is re-executed," surviving
  container/host crashes. It runs in production for **OpenAI Codex**, and its **OpenAI Agents SDK
  integration went GA March 23, 2026**.

**Why this is our pattern:** CircleChat runs **ephemeral per-message Docker containers** — the
exact failure mode checkpoint-only systems do *not* cover. A killed container should resume
mid-task from a durable event log, not restart and re-derive from chat. This reframes our
"one-shot replay of approved actions" as an immature event-sourcing layer that wants to become a
real one.

---

## Finding 4 — Reserve fan-out; orchestrator + isolated subagents, not peer GroupChat
**Confidence: MEDIUM (3-0 on the claims, but via a secondary blog tracing to primary sources).**
Sources: arXiv 2604.02460 (Tran & Kiela, Stanford) via flowhunt.io; Anthropic engineering blog (self-reported).

Refines Part 1's topology call with newer evidence:

- **At equal token budget, single-agent matches or beats multi-agent on multi-hop reasoning** —
  an information-theoretic (Data Processing Inequality) result across 3 model families and 5 MAS
  architectures. So fan-out's value is *breadth/parallelism*, not reasoning quality.
- **Token tax:** agents ~4x chat; multi-agent ~15x (**Anthropic self-reported, "about," in-data**;
  independent ranges span 5–30x — do not treat 15x as a constant).
- **Industry convergence:** a single **orchestrator that owns full context and spawns ephemeral
  isolated subagents**; peer-collaboration **GroupChat designs "have quietly lost ground."**

**For us:** our GM→planner→specialist shape is the winning one. The refinement: keep subagents
**isolated** (own context, return results to the orchestrator) rather than chattering as peers in
a shared channel — which is likely a contributor to our channel-noise/echo problem — and **reserve
fan-out for genuinely parallel breadth**, routing tightly-coupled coding to a single capable agent.

> Caveat: GroupChat isn't dead (AutoGen/AG2 still ship it); this is a default, not a law.

---

## Finding 5 — Make the moat outcome-based; "advice without closure" is the abandonment risk
**Confidence: HIGH (3-0 on the pricing-mechanics claims; 2-1 on two retention claims).**
Sources: Sierra outcome-pricing blog (primary); BVP Atlas pricing playbook, Feb 2026 (primary);
Quiq, Vendr/tooldirectory estimates (blog/procurement).

This is the product-side mirror of our technical failure mode. Every leading AI-coworker vendor
**prices and defines "done" on a resolved unit of work**:

- **Sierra (primary):** "you pay only when the software achieves specific, valuable outcomes" —
  a resolved conversation, a saved cancellation, an upsell, a cross-sell. "If the conversation is
  unresolved, in most cases, there's no charge."
- **Intercom Fin (BVP, primary):** **$0.99 per ticket resolved** — "not per message, not per
  token, but per problem solved."
- **Decagon:** per-conversation / per-resolution; no per-seat fees.
- **Three monetization archetypes** (BVP): Copilots = seat/consumption; **Agents = outcome/workflow**;
  AI-services = consumption/outcome. The named trap: **"Copilots offering advice without closing
  the loop live in dangerous soft-ROI territory"** — higher renewal/abandonment risk.

**For us:** "shipped & verified outcome" should be the **surfaced, first-class unit** (even before
it's a billable one). This is the GTM restatement of the verification gate: the same artifact that
passes Finding 2's independent-state check is the "resolved unit" worth surfacing. Our
credential-begging dead-ends and skeleton-as-done misses are *soft-ROI* failures in this framing.

> Caveat: dollar figures (Sierra ~$150K/yr + $50K+ impl; Decagon ~$400K/yr median) are
> **third-party estimates** — no vendor publishes public pricing. Some retention asymmetry is
> vendor self-reported (e.g., Zendesk 31% uplift).

---

## Finding 6 — Adopt a Decagon-AOP-style scoping/definition-of-done layer
**Confidence: MEDIUM (3-0, vendor-described feature).** Sources: Decagon AOP product page (vendor primary);
tooldirectory teardown (blog).

A sharper alternative to our free-text **BRIEF**: **Agent Operating Procedures** — "natural
language instructions that compile into validated workflows" that **map directly to API calls,
knowledge-base lookups, and explicit escalation criteria**, executed with "predictable, traceable
behavior" and "full visibility into why an agent made a particular decision." Example: *refund
within 30 days → auto-process; else → escalate to retention.*

**For us:** this is how to convert vague goals into **supervisable, auditable** work. Where our
BRIEF is prose an agent interprets, an AOP-style layer is plain English that **compiles to
concrete actions + escalation rules** — a stronger definition-of-done than the current scoping,
and a natural home for the credential/deploy/spend guardrails.

---

## Prioritized recommendations (impact × effort) — Part 2

| # | Change | Impact | Effort | Why / what it corrects |
|---|--------|--------|--------|------------------------|
| 1 | **Add EXECUTION to the verification gate for code deliverables** (build/lint/test or headless render of the deployed preview) and feed the *result* to the judge; **stop letting binary deliverables bypass** the gate | 🔴 Highest | Med | Finding 2, post-audit. Gate already judges the real artifact *text* (good) but never runs it — the length-5 "certify a state it can't observe" hole. Binaries currently skip the judge entirely. |
| 2 | **Add a typed per-round progress object to the ledger** (esp. `is_in_loop` / `is_progress_being_made` the agent emits and the sweeper reads); keep the existing counter/cap machinery | 🔴 High | Low–Med | Finding 1, post-audit. Counters + safe-default are already right (≈60% fidelity); the missing piece is the typed self-report of progress so loop-breaking isn't purely a 15-min wall-clock gap. |
| 3 | **Move toward event-sourced durable execution**: record each action as a durable event so a killed ephemeral container resumes mid-task instead of restarting | 🟠 High | High | Finding 3. Our per-message Docker model is the exact infra-crash case checkpoint-only systems miss. Mature "one-shot replay" into real event sourcing. |
| 4 | **Surface "shipped & verified outcome" as a first-class unit** (the gate's pass = the resolved unit); reframe BRIEF/deploy UX around closing the loop | 🟠 Med–High | Low–Med | Finding 5. Soft-ROI = abandonment. Same artifact as rec #1; mostly a surfacing/UX change. |
| 5 | **Keep subagents isolated (orchestrator owns context); reserve fan-out for breadth; route tightly-coupled coding to one capable agent** | 🟡 Med | Low–Med | Finding 4. Refines our topology; likely reduces channel noise and the 15x-ish token tax. |
| 6 | **Prototype an AOP-style scoping layer** (plain-English procedures → concrete actions + escalation criteria) as the successor to free-text BRIEF | 🟡 Med | Med | Finding 6. Converts vague goals into auditable, supervisable, guardrail-able work. |
| 7 | **Adopt LangGraph-style declarative approvals** (`interrupt()` writes durable state, resume same run) as the approval UX even before full durability | 🟡 Med | Med | Finding 3 (HITL half). Matures approvals; pairs with rec #3. |

## Open questions to resolve against the codebase
1. ~~Does our verification gate inspect independent final-state or the maker's self-report?~~
   **ANSWERED (2026-06-08):** it judges the **actual artifact file**, not a self-report — good.
   New residual questions: (a) should code deliverables get a real **execution** check
   (build/test/headless-render) feeding the gate? (b) what verifies **binary** deliverables that
   currently bypass the judge? (c) should fail-open emit a metric so a flaky gateway doesn't
   silently disable the gate?
2. ~~Does `goal_ledgers` emit five typed per-round fields + three limits?~~ **ANSWERED
   (2026-06-08):** ≈60% fidelity — real stall counter + replan cap + safe default, but **no typed
   per-round progress object** and **stall is time-based, not round/loop-based**. New question:
   add an explicit `is_in_loop` / `is_progress_being_made` typed signal the agent emits each round
   so loop-breaking stops depending solely on a wall-clock gap?
3. **What is our actual recovery behavior when a container is killed mid-action** — resume from a
   durable log, or restart/re-derive from chat? No source measured CircleChat directly.
4. **What's the "resolved unit" analog for a *ships-code/sites* coworker** (vs a support
   resolution), and how do we verify it **without inviting reward-hacking on the billable metric
   itself**?

## Killed in verification (excluded — do not cite)
- ✗ "*None* of Sierra/Decagon/Lindy use outcome-based pricing" — **0-3 refuted**; they do.
- ✗ "No controlled studies of AI coding-agent productivity exist as of mid-2025" — **0-3 refuted**.
- ✗ "Devin's autonomous completion rate is ~14–15%" — **1-2**, insufficiently supported; excluded.

## Honest caveats
- Fast-moving field; all dated facts are **May–June 2026** (Temporal×Agents-SDK GA = 2026-03-23;
  BVP playbook = Feb 2026; Magentic docs = 2026-05-26).
- **Findings 1–3 rest on multiple PRIMARY sources** (Microsoft, arXiv, LangChain, Temporal) →
  high confidence. **Finding 4** traces to a primary paper + primary Anthropic blog but was cited
  via a secondary blog → medium. **Finding 6** and parts of **Finding 5** lean on vendor-described
  feature framing / aggregator blogs → medium.
- The **~15x** multi-agent token penalty is **Anthropic self-reported** ("about," in-data);
  independent ranges are 5–30x.
- Pricing dollar figures are **third-party estimates** — present as estimates, not quotes.
- The reward-hacking RL-reward literature (2606.04923) is **adjacent** to our one-shot done-gate;
  the chain-length-5 / 28%-CoT-evasion findings (2605.02964) transfer most directly.
- No source measured CircleChat itself — all mappings are reasoned inference; **validate against
  the actual codebase before committing effort** (see Open Questions).

### Sources (primary-weighted)
**Primary:** Microsoft Agent Framework (Magentic orchestration) · arXiv 2605.02964 (Reward Hacking
Benchmark) · arXiv 2606.04923 (CHERRL) · LangChain (deep-agents production runtime) · Sierra
(outcome-based pricing) · BVP Atlas (AI pricing & monetization playbook) · Decagon (AOP product).
**Secondary/blog:** Temporal/Modal durable-execution writeup · flowhunt (multi-agent topology,
tracing arXiv 2604.02460) · Quiq, tooldirectory, corepiper (Sierra/Decagon/Lindy teardowns) ·
getclaw (HITL approvals) · Zendesk (outcome pricing) · structured-output / tool-calling reliability blogs.
