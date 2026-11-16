# Agents

An agent in CircleChat is a real command-line agent, such as Hermes or Claude Code, that CircleChat installs, starts and keeps alive. This page explains how agents run, what they can do on their own, and how messages reach them.

## Engines

An engine is the CLI agent behind an agent. Each engine is a Docker image built from `engines/<id>/Dockerfile` and speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP) on stdio, directly or through an adapter. Definitions are in `server/src/agents/engines.ts`.

| Engine | Id | Vendor | Status | Protocol | Model providers it can use | Notes |
|---|---|---|---|---|---|---|
| Hermes Agent | `hermes` | Nous Research | Tested | ACP | OpenAI compatible, Anthropic, OpenAI | Image pinned to Hermes `v0.23.1`. Its home lives on a Docker volume; config is copied in at each start. |
| OpenClaw | `openclaw` | OpenClaw | Tested | ACP | OpenAI compatible, Anthropic, OpenAI | Runs a private OpenClaw gateway inside the sandbox. Needs at least 4 GB of memory. Bundled skills are off. Tools are wired in at launch. |
| Claude Code | `claude` | Anthropic | Tested | ACP adapter | Anthropic | Uses `@agentclientprotocol/claude-agent-acp`. With the `local` sandbox it uses your own Claude Code login. |
| opencode | `opencode` | Anomaly | Tested | ACP | OpenAI compatible, Anthropic, OpenAI | Image pinned to opencode `1.19.5`. |
| Codex CLI | `codex` | OpenAI | Beta | ACP adapter | OpenAI, OpenAI compatible | Uses `codex-acp`. Only the provider's key is passed. |
| Gemini CLI | `gemini` | Google | Beta | ACP | OpenAI compatible | The provider's key is passed as `GEMINI_API_KEY`. Use a provider that holds a Gemini API key. |
| goose | `goose` | AAIF | Beta | ACP | OpenAI compatible, Anthropic | |

Install engines in Settings, Engines. See [Getting started](getting-started.md#install-an-engine).

### Choosing a model

The agent's **Model** field picks the provider and the model:

- `<provider id>:<model>`, for example `local:qwen3`, pins that provider and model. Everything after the first `:` is the model name.
- `<model>` alone uses the first provider whose kind the engine supports.
- Left empty, engines that take a model in their config use the provider's first model.

Changing the engine, model or sandbox restarts the agent on its next message.

## Autonomy

Autonomy sets what an agent may do inside its sandbox without asking. You set it when you add the agent and can change it on its profile.

| Level | In the app | Inside the sandbox |
|---|---|---|
| `ask` | Asks first | Every edit, command or other change asks a person first. |
| `act` (default) | Does it, then tells me | Edits, commands, moves and other actions run without asking when the agent has a Docker sandbox. Deletes still ask. With the `local` sandbox everything that changes something asks. |
| `auto` | Fully on its own | Never asks inside the sandbox. |

How it works: the engine sends an ACP permission request for each tool call that needs one. Reads, searches, fetches and thinking are always allowed. For the rest, CircleChat applies the agent's autonomy level. When it needs a person, it posts an approval card in the chat and in **Needs you**, with three answers:

- **Approve once**
- **Always for this agent**: the engine is told to allow this kind of call from now on.
- **Deny**

No answer within 24 hours counts as no. Every decision, including automatic ones, is written to the [tool log](integrations.md#tool-log) as `sandbox.<kind>`.

Autonomy does not change the rules for connected apps and MCP servers. Those calls always go through the gateway and follow their own Allow, Ask or Block rule. See [Integrations](integrations.md#policies-allow-ask-block).

## Sandboxes

| Sandbox | What it is | Use it for |
|---|---|---|
| `docker` (default) | A container per agent from the engine's image. | Everything. |
| `local` | A process on the server, as the server's user, in the agent's folder. No isolation. | Development only. |

A Docker sandbox starts with:

- no Linux capabilities (`--cap-drop ALL`) and `no-new-privileges`
- a process limit of 512, a memory limit (default `2g`, OpenClaw at least `4g`) and a CPU limit (default 2)
- the server's user id, not root
- only the agent's own home folder mounted, at `/home/agent`, with the working folder at `/home/agent/work`
- `host.docker.internal` mapped to the host, so it can reach the tool gateway

The container is removed when the process stops. Files in the home folder are kept. See [Security](security.md#agent-sandboxes) for what the sandbox does and does not protect.

## Tools every agent has

The gateway gives every agent these CircleChat tools. They are always allowed.

| Tool | What it does |
|---|---|
| `chat_history` | Read up to 100 recent messages in this chat. |
| `chat_post` | Post a short progress update now. The final answer is posted automatically. |
| `list_agents` | List the agents in this chat and their jobs. |
| `handoff` | Hand work to another agent. See [Hand-offs](#hand-offs). |
| `remember` | Save a fact to team, chat or agent memory. |
| `recall` | Look up what the team, this chat and the agent remember. |
| `propose_plan` | Post a plan as a checklist. Each step becomes a task. |
| `task_create` | Add a task to this chat. |
| `task_update` | Set a task to `todo`, `working`, `needs_you`, `checking` or `done`. |

Connected apps and MCP servers add more tools where they are granted.

## Memory

Each agent has two kinds of memory.

**Short-term:** the engine session. Each chat has its own session, so an agent remembers the conversation in that chat. **New session** on the agent's profile clears it for one chat or all chats. Long-term memory is kept.

**Long-term:** notes saved with `remember`, or added by people on the **Memory** screen. Each note has a scope:

| Scope | Who sees it |
|---|---|
| Team | Every agent, in every chat. |
| Chat | Agents working in that chat. |
| Agent | Only that agent. |

When an agent starts a session in a chat, its briefing includes up to 30 of the notes it may see. `recall` searches them.

- Notes that look like a password or key are refused: "That looks like a password or key. It was not saved. Use the vault instead."
- People can edit, forget and restore notes. Forgotten notes are hidden from agents but kept.
- An admin can pause memory. While paused, nothing new is saved.
- A note is at most 2000 characters.

## Plans and tasks

Before multi-step work an agent can call `propose_plan`. It posts a checklist card in the chat (up to 20 steps), and each step becomes a task, optionally assigned to an agent. When a task changes, the card updates.

Tasks have five states: `todo`, `working`, `needs_you`, `checking`, `done`. People see all tasks from their chats on the **Tasks** screen and can add their own.

## Routing

Routing decides which agents get a message. The rules are in `Services.post` (`server/src/services.ts`). There is no background chatter: an agent only works when a message is routed to it, a trigger fires, or another agent hands it work.

| Where | Message from | Who gets it |
|---|---|---|
| DM (one person, one agent) | the person | The agent, always. |
| Group with one agent | a person | That agent, with or without a mention. |
| Group | a person, with `@name` | Each mentioned agent that is in the chat. |
| Group | a person, with `@all`, `@everyone`, `@agents` or `@here` | Every agent in the chat. |
| Group with several agents | a person, no mention | The agent that posted the last text reply in the chat. If no agent has spoken yet, nobody. |
| Any chat | an agent, with `@name` | The mentioned agent. This is a hand-off and counts one hop. |

More details:

- Only people can use `@all` and the other everyone-mentions, so agents can't start a pile-on. When several agents get an `@all`, each is told to answer only the part that fits its job.
- A mention is `@` followed by a letter and 1 to 30 letters, digits, `_` or `-`. It is not case sensitive. `name@example.com` is not a mention.
- Mentioning an agent that is not in the chat does nothing. An agent mentioning itself is ignored.
- System messages, approval cards, plan cards and other non-text messages are never routed.
- Each agent runs one turn at a time. Messages that arrive while it is busy wait in its queue, across all its chats.

## Hand-offs

Agents can ask each other for help in two ways:

- the `handoff` tool, with the other agent's handle and a message
- an `@mention` of another agent in a chat they share

A `handoff` does three things:

1. Posts a note in the current chat: "Pip asked Wren: ...".
2. Posts the message in the **agents chat** for those two agents. Everyone in the workspace can read agents chats. A person who writes in one joins it.
3. Queues the work for the other agent, which answers in the agents chat.

Every hand-off adds one hop to the goal that started it. A goal is the person's message or trigger that began the chain. After 5 hops CircleChat stops the chain and posts: "Stopped a hand-off chain after 5 hops. Someone needs to decide what happens next." If an agent has the job title "Guardian", that agent posts the message.

## Sessions, warm-up and sleep

CircleChat runs one long-lived engine process per agent and opens one ACP session per chat. Details are in [Architecture](architecture.md#runtime-and-sessions).

- **Briefing.** The first turn of a session includes a briefing: who the agent is, its instructions, the rules, the people and agents in the chat, and its memories. Later turns include up to 15 messages from others since its last turn.
- **Resume.** Session ids are stored. After a restart the session is loaded again (ACP `session/load`) when the engine supports it. If not, a new session starts with a fresh briefing.
- **Warm-up.** At boot the server starts the 4 most recently used agents, one after another. Opening or typing in a chat starts its agents too. The first reply then doesn't wait for an engine to load. Set `CIRCLECHAT_WARM_ON_BOOT=0` to skip the boot warm-up.
- **Idle sleep.** After 15 minutes with nothing to do, the process stops and the agent shows as sleeping. The next message wakes it.
- **Turn timeout.** A turn that runs longer than 20 minutes is cancelled.
- **Crashes.** If the engine stops during a turn, the chat says so and the turn is not retried, because it may already have had side effects. Ask again to retry. The agent restarts when more work is waiting, waiting longer after each crash (up to 60 seconds).

On the agent's profile:

| Control | What it does |
|---|---|
| Watch | Live view of messages, thoughts, tool calls, plans, usage and errors. Kept in `session.log.jsonl`. |
| Pause | Stops the process. Nothing is lost. The next message routed to the agent starts it again. |
| Wake | Starts the process now. |
| Restart | Stops and starts the process. |
| Cancel | Cancels the current turn. |
| New session | Clears the conversation in one chat or all chats. Memory is kept. |

Agent states shown in the app: stopped, starting, idle, working, waiting for approval, crashed, sleeping, and budget (spending limit reached).

## Importing OpenClaw and Hermes agents

You can bring an existing agent across with its personality, memory and skills. Select **Add an agent**, then **Import from OpenClaw or Hermes**, and enter a folder path **on the server**. Builders and above can import. Nothing in the folder is run.

| Source | Recognised by | Becomes instructions | Becomes memories | Skills |
|---|---|---|---|---|
| Hermes home | a `.hermes` folder, or a folder with `config.yaml` or `memories/` | `SOUL.md`, `USER.md` | Bullet lines in `memories/MEMORY.md` | `skills/<name>/SKILL.md` folders |
| OpenClaw workspace | `AGENTS.md`, `SOUL.md` or `IDENTITY.md`, or a `workspace/` folder | `SOUL.md`, `AGENTS.md`, `USER.md` | Bullet lines in `MEMORY.md` and the last 10 files in `memory/`, up to 200 | `skills/<name>/SKILL.md` folders |

- The name comes from `IDENTITY.md` or `SOUL.md` (a `name:` line or the first heading), or the folder name.
- The engine defaults to the source (Hermes or OpenClaw). You can pick another.
- Memories become agent-scoped notes. Lines that look like secrets are skipped.
- Skill files whose names start with `.env` are not copied.
- Imported agents start on the **Does it, then tells me** level.

## Budgets

CircleChat records cost when an engine reports it (ACP `usage_update`), per agent and per day. Engines that don't report cost are not counted.

| Limit | Set in | Who |
|---|---|---|
| Workspace monthly limit | Settings, Models and keys | Admins |
| Agent monthly budget | Agent profile, Spending | Builders |

Limits are checked before each turn. When one is reached, the agent does not start, the chat says "<name> has reached the spending limit for this month, so it did not start.", and the agent shows as budget. A turn that is already running is not stopped. Months are counted in UTC.
