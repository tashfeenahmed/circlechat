# P1 platform capabilities

CircleChat’s P1 layer turns the P0 execution primitives into an operator-facing delivery and governance platform. Open **Platform** for decisions, apps, PR rooms, stages, blueprints, run control, and access; open **Needs you** for one prioritized human review queue.

## Decision and precedent memory

`POST /api/decisions/observe` writes a typed `decision`, `precedent`, `policy`, `exception`, or `steer` with alternatives and arbitrary provenance. Active records are injected into every agent context packet. Human correction uses `POST /api/decisions/:id/correct`: the prior row becomes `corrected`, the replacement points to it with `supersedes_id`, and both remain inspectable.

## Static app delivery

An app deployment snapshots one live HTML task-artifact version and its SHA-256 identity. `POST /api/apps` creates a token-isolated preview; `POST /api/apps/:id/request-publish` moves it into **Needs you**; an admin uses `POST /api/apps/:id/review` to approve or reject it. Only an approved deployment serves at `/apps/:slug`.

Both preview and published responses use a deny-by-default content security policy, no forms or network connections, no base-URL changes, `nosniff`, and no referrer. Preview URLs are unguessable and never cached. Deployment logs and `/api/apps/:id/health` expose serving and artifact health. This runtime deliberately hosts self-contained static HTML; server-side code, secrets, custom domains, and outbound browser calls are outside this safety boundary.

## Provider-backed PR rooms

PR rooms bind a GitHub pull request or GitLab merge request to a CircleChat channel. A governed HTTP connector supplies credentials and provider base URL. Sync normalizes:

- title, URL, state, head, and base;
- changed files;
- checks or pipelines;
- reviews or approvals;
- branch-protection state.

`POST /api/pr-rooms/:id/sync` can also accept a provider-shaped snapshot. That path supports deterministic fixtures, webhook-fed state, and air-gapped mirrors without weakening the connector path.

## Executable board stages

Every fixed task status can be configured through `/api/board-stages/:stage` with a display title/order, instructions, entry and exit rules, assigned agent, skill, verification policy, escalation owner, and next transition. Rules can require an assignee, labels, minimum progress, an artifact, or a passed verification.

Both drag/drop and `POST /api/tasks/:id/advance` use the same server-side gate. A failure returns every violation and can notify the escalation owner. A successful entry assigns and wakes the configured agent. The exact stage contract is snapshotted into the queue job, so a fast subsequent card movement cannot race and replace the instructions a run was meant to execute.

## Versioned team blueprints

Blueprint definitions package agents, reporting relationships, skill metadata, scopes, budgets, private team channels, and durable workflows. Exporting the workspace creates a new immutable version. Applying a version creates fresh agent identities/tokens, member rows, org links, channels, and workflow rows. Secrets and callback URLs are intentionally excluded.

## Needs you

`GET /api/needs-you` returns a permission-scoped, prioritized union of:

- pending agent approvals;
- tasks in review and failed verifications;
- stalled goals;
- workflows waiting for a human or recently failed;
- workspace and agent budget warnings/stops;
- connector health errors;
- app publish requests.

The UI provides the native decision where one exists and links directly to the source object for deeper review.

## Run control

Agent and workflow runs persist ownership, timeout, steer records, and queued follow-ups. `/api/{agent|workflow}-runs/:id/control` accepts `claim`, `release`, `steer`, `follow_up`, `extend`, and `cancel`.

Workflow workers refuse cancelled/expired state wakes. Agent workers check before remote execution and again immediately before applying returned actions. Therefore a cancellation received while a remote model is working cannot leak its eventual side effects. Follow-ups queued during a run become a new continuation turn after completion; workflow steers/follow-ups are injected into the next agent state.

## Enterprise access and audit

The enterprise surface adds:

- built-in admin/member/guest roles and versioned custom role permissions;
- guest invites limited to explicit channel IDs (guests are not auto-added to later public channels);
- OIDC authorization-code login with state, one-use state storage, PKCE S256, issuer discovery, same-origin endpoint validation, verified-email/domain policy, and role provisioning;
- one-time service-account tokens stored only as SHA-256 hashes, with expiry, revocation, last-use tracking, and enforced `workflows.read` / `workflows.run` scopes;
- append-only audit rows with hashed IPs and permission-filtered JSON/CSV export;
- retention-days and data-residency policy fields.

The data-residency value records and exposes the deployment policy; the operator must place Postgres, Redis, object storage, backups, and model/connector providers in the declared region. CircleChat does not falsely infer physical residency from a label.

## Verification

With the API and worker running against a migrated PostgreSQL/Redis environment:

```bash
cd api
npm test
npm run test:p0-e2e
npm run test:p1-e2e
```

The P1 E2E suite exercises immutable decision correction and context injection, preview/publish isolation, live provider sync, stage-rule denial and deterministic execution, blueprint instantiation, action-safe cancellation, the unified inbox, custom RBAC, guest boundaries, scoped service identities, OIDC/PKCE provisioning, audit export, and cross-workspace isolation.
