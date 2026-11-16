# Changelog

All notable changes to CircleChat are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

Several of these come from ideas in [Borderux's fork](https://github.com/borderux/recursica-circlechat), which runs CircleChat with Hermes and local models every day. Thank you.

### Added

- **Agent network limits.** `CIRCLECHAT_AGENT_EGRESS=none` keeps agents to CircleChat only; `allowlist` adds the hosts in `CIRCLECHAT_AGENT_EGRESS_ALLOW`. Agents sit on a Docker network with no route out and no outside name lookups, behind a small filter container.
- **Model proxy.** Engines call their model through CircleChat with a stand-in token, so provider keys never enter a sandbox (Gemini CLI excepted).
- **Tool calls written as text** are spotted and the agent is asked once more, instead of posting the markup.
- **Live Working mark** on a task while its agent works in the task's chat.
- Dependabot with a 7-day cool-down.

### Changed

- Members only see the activity, approvals, memories and tool calls of chats they're in. Agent controls need the builder role.
- A group message that mentions only people wakes no agent.

### Fixed

- Engine config is never written through a link the agent planted in its home, which could have overwritten server files such as the vault key.
- Agent folders are private to the server's user (700, was 755).
- Agent containers left behind by a crash are removed when the server starts.

## [2.0.0] - 2026-11-16

CircleChat 2.0 is a rebuild. It has a new server, a new data model and a new web app. There is no in-place upgrade from 1.x: install 2.0 fresh and bring agents across with Import.

### Added

- **Real CLI agents.** Each agent is a long-lived engine process talked to over the Agent Client Protocol (ACP), in its own Docker sandbox. Engines: Hermes, OpenClaw, Claude Code and opencode (tested), Codex, Gemini CLI and goose (beta). Engines install from Settings, Engines.
- **Sessions that last.** One ACP session per chat, loaded again after a restart where the engine supports it. Agents warm up at boot and when a chat opens, and sleep after 15 minutes idle.
- **Group routing.** `@name` asks one agent, `@all` (or `@everyone`, `@agents`, `@here`) asks every agent in the chat, and a message with no mention goes to the agent that spoke last. A group with one agent always answers.
- **Hand-offs.** Agents hand work to each other in a visible agents chat, with a limit of 5 hops per goal.
- **Autonomy levels.** Asks first, Does it then tells me, and Fully on its own, applied to the engine's permission requests.
- **Memory, plans and tasks.** Team, chat and agent memory with forget and restore. Plans post as checklists and each step becomes a task.
- **Tool gateway.** One private MCP endpoint per agent session. Keys stay in an AES-256-GCM vault and are added per call.
- **App catalog.** GitHub plus 22 apps that connect with a token (GitLab, Vercel, Sentry, Cloudflare, Slack, Discord, Notion, Linear, Jira, Asana, Todoist, ClickUp, Airtable, HubSpot, Intercom, Zendesk, Calendly, Stripe, Shopify, Mailchimp, Resend, Twilio), with a token check on connect. Any HTTP API and any MCP server.
- **Grants and policies.** New connections are off everywhere until granted to the workspace, a chat or an agent. Every tool is Allow, Ask or Block. MCP tools stay off until reviewed, including tools a server adds later.
- **Approvals in the chat.** Approve once, Always in this chat, or Deny.
- **Personal connections** that act as you, only on your own requests.
- **Tool log** of every tool call, with who asked, as whom, who approved and the cost, in a hash chain that shows tampering.
- **Triggers.** Webhooks with GitHub-compatible HMAC signatures, filters and prompt templates. Cron schedules. Run history and replay.
- **Slack bridge** that mirrors a channel and a chat both ways over Socket Mode.
- **Model providers.** Anthropic, OpenAI, OpenRouter or any OpenAI-compatible server, including local ones. A workspace monthly limit and per-agent budgets.
- **Import** of OpenClaw workspaces and Hermes homes with their instructions, memory and skills.
- **Roles.** Owner, admin, builder and member.
- **Operations.** Seed file for first boot, `cli.ts` commands (`export`, `backup`, `state`, `set-password-hash`), full data export and workspace delete, `CIRCLECHAT_TRUST_PROXY` and `CIRCLECHAT_AGENT_LISTEN` for servers behind a TLS proxy.
- **Security.** Least-privilege containers, login limits per address and per account, secret detection in memory, redaction in the tool log.
- **Desktop app.** An Electron shell with native notifications and a Dock badge.
- **Documentation** in `docs/`.

[Unreleased]: https://github.com/tashfeenahmed/circlechat/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/tashfeenahmed/circlechat/releases/tag/v2.0.0
