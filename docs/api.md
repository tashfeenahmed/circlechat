# HTTP API

The web and desktop apps use a JSON API served by the CircleChat server. This page lists every route. The source is `server/src/api.ts` and `server/src/server.ts`.

The API has no version prefix. It changes with the server, so check the [changelog](../CHANGELOG.md) when you upgrade.

## Conventions

| Topic | Rule |
|---|---|
| Base URL | The server address, for example `https://chat.example.com`. |
| Format | JSON request and response bodies. Send `content-type: application/json`. |
| Auth | The `cc_session` cookie set by `/api/setup`, `/api/login` or `/sso`. The same token is also accepted as `Authorization: Bearer <token>`. |
| Errors | `{ "error": "message" }` with status 400 (bad input), 401 (not signed in or wrong password), 403 (role too low), 404, 409 (conflict), 429 (too many wrong passwords) or 502 (hosting control plane). |
| Roles | `owner` > `admin` > `builder` > `member`. "Any" below means any signed-in person. A higher role can do everything a lower one can. |
| Secrets | Responses never include secret values, only flags such as `hasKey` and `hasSecret`. |

## Public routes

These need no session.

| Method | Path | Body or query | Notes |
|---|---|---|---|
| GET | `/api/state` | | `{ setupNeeded, workspace, user, version, hosted }`. `user` is set when signed in. |
| POST | `/api/setup` | `{ workspace, name, email, password }` | Creates the owner. Only while there are no users, else 409. Password at least 8 characters. Signs in. |
| POST | `/api/login` | `{ email, password }` | Signs in. 401 on a wrong password, 429 when the limit is reached. |
| POST | `/api/logout` | | Ends the session. |
| GET | `/sso?token=...` | | Hosted installs: one-time sign-in from the control plane. Redirects to `/`. |
| GET | `/healthz` | | `200 ok`. |
| POST | `/hooks/:triggerId` | any body | Webhook triggers. See [Integrations](integrations.md#webhooks). Not under `/api`. |
| POST | `/mcp/:token` | MCP (streamable HTTP) | The agents' tool endpoint. The token is issued per agent session. |

## You and people

| Method | Path | Role | Body or query | Notes |
|---|---|---|---|---|
| GET | `/api/me` | Any | | The signed-in person. |
| PATCH | `/api/me` | Any | `{ name?, password?, currentPassword? }` | A new password needs the current one and signs out other sessions. |
| GET | `/api/users` | Any | | Everyone in the workspace, with email and role. |
| POST | `/api/users` | Admin | `{ email, name, role?, password? }` | `role` is `admin`, `builder` or `member` (default). Without a password, returns a `tempPassword`. |
| PATCH | `/api/users/:id` | Admin | `{ role }` | The owner's role can't be changed. |

## Agents

| Method | Path | Role | Body or query | Notes |
|---|---|---|---|---|
| GET | `/api/agents` | Any | | All agents with live `status` and `monthCostMicros`. |
| GET | `/api/agents/:id` | Any | | `{ agent, chats, memories }`. `:id` can be the id or the handle. |
| POST | `/api/agents` | Builder | `{ name, handle?, roleTitle?, style?, colour?, engine?, model?, instructions?, autonomy?, sandbox?, budgetCents?, chats? }` | `engine` defaults to `hermes`, `autonomy` to `act`, `sandbox` to `docker`. `chats` is a list of chat ids to join. |
| PATCH | `/api/agents/:id` | Builder | same fields | Changing `engine`, `model` or `sandbox` stops the process; it starts again on the next message. |
| DELETE | `/api/agents/:id` | Admin | | Stops and archives the agent. Its handle is freed. |
| POST | `/api/agents/:id/pause` | Builder | | Stops the process. |
| POST | `/api/agents/:id/wake` | Builder | | Starts the process. |
| POST | `/api/agents/:id/restart` | Builder | | Stops and starts the process. |
| POST | `/api/agents/:id/cancel` | Builder, or a member of the chat it is working in | | Cancels the current turn. |
| POST | `/api/agents/:id/new-session` | Builder | `{ chatId? }` | Forgets the session for one chat, or all chats. Memory is kept. |
| GET | `/api/agents/:id/activity` | Any | `?limit=300` | `{ status, activity, queued }`: the activity log and waiting deliveries, limited to chats you can see. Engine output with no chat is for builders. |
| POST | `/api/agents/import/inspect` | Builder | `{ path }` | What an import of that server folder would bring. |
| POST | `/api/agents/import` | Builder | `{ path, handle?, name?, roleTitle?, engine?, model?, sandbox? }` | Creates the agent. Returns `imported: { memories, skills }`. |

Agent fields:

| Field | Values |
|---|---|
| `handle` | 2 to 30 characters, starts with a letter, `a-z 0-9 _ -`. Not `all`, `everyone`, `agents` or `here`. |
| `autonomy` | `ask`, `act`, `auto` |
| `sandbox` | `docker`, `local` |
| `engine` | `hermes`, `openclaw`, `claude`, `opencode`, `codex`, `gemini`, `goose` (and `mock` for tests) |
| `model` | Free text, up to 120 characters. `<provider id>:<model>` pins a provider. |
| `budgetCents` | Monthly budget in cents. `0` means none. |
| `style` | `classic`, `twin`, `curly`, `spring`, `heart`, `leafy`, `bulb`, `trio`, `stubby`, `halo`, `nightlight`, `huggy`, `feelers` |
| `colour` | `coral`, `peach`, `butter`, `mint`, `green`, `sky`, `lilac`, `pink`, `cloud`, `midnight` |

## Chats and messages

| Method | Path | Role | Body or query | Notes |
|---|---|---|---|---|
| GET | `/api/chats` | Any | | Chats you are in, plus all agents chats, newest first, with the last message and unread count. |
| POST | `/api/chats` | Any | `{ dmAgent }` or `{ name, users?, agents? }` | `dmAgent` finds or creates your DM with that agent. Otherwise creates a group with you in it. |
| GET | `/api/chats/:id` | Member | | `{ chat, agents }`. Agents chats are readable by anyone. |
| PATCH | `/api/chats/:id` | Member | `{ name }` | Renames the chat. |
| POST | `/api/chats/:id/members` | Member | `{ type: "user" \| "agent", id, remove? }` | Adds or removes a member. |
| GET | `/api/chats/:id/messages` | Member | `?before=<ts>&limit=100` | Up to 200 messages before a timestamp, oldest first. |
| POST | `/api/chats/:id/messages` | Member | `{ body }` | Posts and routes a message (up to 20000 characters). Posting in an agents chat adds you to it. |
| POST | `/api/chats/:id/warm` | Member | | Starts the chat's agents in the background. |
| POST | `/api/chats/:id/read` | Member | | Marks the chat as read. |

## Approvals

| Method | Path | Role | Body or query | Notes |
|---|---|---|---|---|
| GET | `/api/approvals` | Any | `?state=pending` | Approvals in chats you can see and ones you asked for (admins: all), or those in one state (`pending`, `approved`, `denied`, `expired`, `cancelled`). Without a state, the latest 200. |
| POST | `/api/approvals/:id/decide` | See notes | `{ decision, reason? }` | `decision` is `allow_once`, `allow_always` or `deny`. Admins, the person who made the request, or members of the chat. 409 if already decided. |

## Memory and tasks

| Method | Path | Role | Body or query | Notes |
|---|---|---|---|---|
| GET | `/api/memories` | Any | `?scope=team\|chat\|agent&scopeId=` | Up to 300 notes, newest first, and whether memory is paused. Chat memory only for chats you can see (admins: all). |
| POST | `/api/memories` | Any | `{ text, scope?, scopeId? }` | `scope` defaults to `team`. Chat memory needs you to see that chat; agent notes need a builder. Refused when paused or when the text looks like a secret. |
| PATCH | `/api/memories/:id` | Any | `{ forget?, restore?, text? }` | Forget, restore or edit a note. Chat memory needs you to see that chat; agent notes need a builder. |
| PUT | `/api/memories/paused` | Admin | `{ paused }` | Pauses or resumes memory. |
| GET | `/api/tasks` | Any | `?chat=<id>` | Tasks in chats you can see. |
| POST | `/api/tasks` | Member of the chat | `{ chatId, title, assigneeType?, assigneeId? }` | |
| PATCH | `/api/tasks/:id` | Any | `{ status?, title?, assigneeType?, assigneeId? }` | `status`: `todo`, `working`, `needs_you`, `checking`, `done`. 404 unless you can see the task's chat. |

## Integrations

| Method | Path | Role | Body or query | Notes |
|---|---|---|---|---|
| GET | `/api/apps/catalog` | Any | | The app catalog: ids, names, categories, fields and token help. |
| GET | `/api/connections` | Any | | All connections with grants and policies. |
| POST | `/api/connections` | Any for `identity: "user"`, Builder for `"agent"` | see below | Creates a connection. A personal connection is granted everywhere at once and still only works on its owner's requests. |
| PATCH | `/api/connections/:id` | Builder, or the owner of a personal connection | `{ name?, repos?, baseUrl?, secret?, enabled? }` | `enabled: false` turns it off. |
| PUT | `/api/connections/:id/grants` | Builder | `{ grants: [{ type: "workspace" \| "chat" \| "agent", id? }] }` | Replaces all grants. `[]` is off everywhere. |
| PUT | `/api/connections/:id/policies` | Builder | `{ policies: { "<tool>": "allow" \| "ask" \| "block" } }` | A key `"<tool>@chat:<chat id>"` sets the rule for one chat. |
| POST | `/api/connections/:id/test` | Builder, or the owner of a personal connection | | `{ ok, detail }`. Runs the app's token check. |
| DELETE | `/api/connections/:id` | Builder | | Also deletes its key, grants and policies. |
| GET | `/api/mcp` | Any | | MCP servers with tools, grants and policies. |
| POST | `/api/mcp` | Builder | `{ name, transport: "http" \| "stdio", url?, command?, args?, secrets? }` | Connects and lists tools, all off. Returns `{ server, refresh }`. |
| POST | `/api/mcp/:id/refresh` | Builder | | Lists tools again. New tools arrive off. Returns `{ tools, added, server }`. |
| PUT | `/api/mcp/:id/grants` | Builder | as for connections | |
| PUT | `/api/mcp/:id/policies` | Builder | `{ policies: { "<server>__<tool>": "allow" \| "ask" \| "block" \| "off" } }` | |
| DELETE | `/api/mcp/:id` | Builder | | Also deletes its secrets, grants and policies. |

Bodies for `POST /api/connections`:

| Kind | Body |
|---|---|
| Catalog app | `{ preset: "linear", secret, fields?: { ... }, name?, identity? }` |
| GitHub | `{ app: "github", name, secret, repos?: ["owner/name"], apiBase?, identity? }` |
| Any HTTP API | `{ app: "http", name, baseUrl, secret?, authHeader?, authScheme?, identity? }` |

## Triggers

| Method | Path | Role | Body or query | Notes |
|---|---|---|---|---|
| GET | `/api/triggers` | Any | | Triggers with their `/hooks/` path, `hasSecret` and the last 5 runs. |
| POST | `/api/triggers` | Builder | `{ kind: "webhook" \| "schedule", name, chatId, agentId, prompt, secret?, schedule?, filter?, enabled? }` | The agent must be in the chat. `schedule` is a 5-field cron. |
| PATCH | `/api/triggers/:id` | Builder | any of the fields | |
| DELETE | `/api/triggers/:id` | Builder | | |
| GET | `/api/triggers/:id/runs` | Builder | | The last 50 runs. |
| POST | `/api/trigger-runs/:id/replay` | Builder | | Fires the trigger again with that run's body. |

## Tool log

| Method | Path | Role | Body or query | Notes |
|---|---|---|---|---|
| GET | `/api/toollog` | Any | `?agent=<id>&only=approval\|failed` | The latest 300 calls in chats you can see (admins: all). |
| GET | `/api/toollog/verify` | Any | | `{ ok, count, brokenAt? }` |

## Engines, models and settings

| Method | Path | Role | Body or query | Notes |
|---|---|---|---|---|
| GET | `/api/engines` | Any | | Each engine, whether its image is installed, its version, its agents and any install job. |
| POST | `/api/engines/:id/install` | Admin | | Starts `docker build` for the engine image. Poll `/api/engines` for the job log. |
| GET | `/api/providers` | Any | | Model providers, with `hasKey` instead of the key. |
| PUT | `/api/providers/:id` | Admin | `{ kind, baseUrl?, apiKey?, models?, label? }` | Creates or updates. `kind`: `openai-compatible`, `anthropic`, `openai`. Leaving out `apiKey` keeps the stored key. |
| DELETE | `/api/providers/:id` | Admin | | Also deletes its key. |
| POST | `/api/providers/:id/test` | Admin | | Lists the provider's models. `{ ok, detail, models? }` |
| GET | `/api/usage` | Any | | This month's total, the limit and cost per agent. |
| GET | `/api/settings` | Any | | `{ workspace, monthlyLimitCents, memoryPaused, sandboxMemory }` |
| PUT | `/api/settings` | Admin | `{ workspace?, monthlyLimitCents?, sandboxMemory? }` | `sandboxMemory` like `2g` or `512m`. |

## Slack bridge

| Method | Path | Role | Body or query | Notes |
|---|---|---|---|---|
| GET | `/api/bridges` | Admin | | Bridges with `status` and `error`. |
| POST | `/api/bridges` | Admin | `{ chatId, channel, botToken, appToken }` | Stores both tokens in the vault and starts the bridge. Returns `{ id, started, error? }`. |
| PATCH | `/api/bridges/:id` | Admin | `{ enabled }` | |
| DELETE | `/api/bridges/:id` | Admin | | |

## Workspace data and hosting

| Method | Path | Role | Body or query | Notes |
|---|---|---|---|---|
| GET | `/api/workspace/export` | Owner | | Downloads the full export as `.tar.gz`. See [Deployment](deployment.md#backups). |
| POST | `/api/workspace/delete` | Owner | `{ password, confirm }` | `confirm` must be the workspace name. Deletes everything and returns the server to first-run setup. Not available on hosted installs. |
| any | `/api/hosting/*` | Admin | | Hosted installs only: forwarded to the control plane with the instance secret added on the server. |
| GET | `/api/search` | Any | `?q=` (at least 2 characters) | `{ agents, chats, messages, tasks }` from chats you can see. |

## Websocket

Connect to `/ws` with the session cookie, or `?token=<session token>`. The server sends `{ "type": "hello" }` and then JSON events, only for chats you can see. It pings every 25 seconds.

| Event `type` | Fields |
|---|---|
| `message` | `chatId`, `message` |
| `message_updated` | `chatId`, `message` (for example an approval card or a plan card that changed) |
| `chat` | `chat` (created, renamed or members changed) |
| `typing` | `chatId`, `agentId`, `on` |
| `agent_status` | `agentId`, `status` |
| `agent_activity` | `agentId`, `chatId`, `entry`, `append?` |
| `approval` | `approval` |
| `task` | `chatId`, `task` |
| `memory` | `memory` |
| `delivery` | `delivery` |
