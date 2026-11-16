# API gaps found while building the web app

Things the web app needed but the server API doesn't offer (yet). Each one has a
workaround in the web app today.

1. **Unread counts for agents-only chats.** `GET /api/chats` returns `unread` for
   "agents" chats the user is not a member of, counted from `last_read_ts = 0`, and
   `POST /api/chats/:id/read` can't store a read mark for a non-member. So those
   chats show as unread forever. Workaround: the web app hides unread badges for
   chats the user isn't a member of.
2. **Gateway approvals don't change the agent's status.** When a connection or MCP
   tool waits for approval (`decision === "ask"`), the agent stays `working`; only
   ACP permission requests set `waiting_approval`. Workaround: the "Now" strip treats
   an agent with a pending approval as waiting.
3. **No status endpoint for engine installs.** `POST /api/engines/:id/install`
   has no status endpoint of its own; the web app polls `GET /api/engines` every 2 s
   while a job is running (the `job.log` field) and that works, but it re-runs
   `docker image inspect` for every engine each time.
4. **No way to list or delete Slack bridges, or to stop one.** `GET /api/bridges` and
   `POST /api/bridges` exist, but there is no `DELETE /api/bridges/:id` or
   `PATCH` to turn one off. The Slack screen only lists and adds.
5. **No "who reacted / seen by" data.** The prototype shows reactions and "Seen by";
   there is no API for these, so the app does not show them.
6. **No agent "jobs done / typical job" stats.** The prototype profile shows weekly
   stats. Only `monthCostMicros` exists, so the profile shows this month's cost
   and the budget.
7. **`GET /api/tasks` without `chat` returns tasks for every chat**, including chats
   the user can't see. The Tasks screen only lists chats from `GET /api/chats`, so
   nothing leaks in the UI, but the endpoint itself should filter.
8. **New session needs a chat id.** `POST /api/agents/:id/new-session` resets one
   chat's session; there's no "all sessions" option. The profile asks which chat.
9. **No user profile editing or password change.** People added by an admin get a
   temporary password, but there is no endpoint to change it (or your own name).
10. **No connection editing.** You can set grants and policies on a connection, but
    not change its token, repos or base URL. Workaround: remove and connect again.
11. **Desktop notifications for messages need the chat list.** The websocket
    `message` event doesn't say whether the current user is a member; the app checks
    its cached chat list.
