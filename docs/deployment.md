# Deployment

This page describes how to run CircleChat on a Linux server that people reach over the internet. It assumes you have done [Getting started](getting-started.md) once on a local machine.

The recommended setup:

- CircleChat bound to `127.0.0.1`, with a TLS reverse proxy (Caddy or nginx) in front.
- `CIRCLECHAT_TRUST_PROXY=1`, so cookies are `Secure`.
- `CIRCLECHAT_AGENT_LISTEN=docker0`, so agent containers can reach the tool gateway.
- A host firewall that allows the agent listener from the Docker bridge only.
- A systemd unit, a nightly backup, and the vault key stored somewhere else.

## Install on the server

```bash
sudo useradd --system --create-home --home-dir /opt/circlechat circlechat
sudo usermod -aG docker circlechat
sudo -u circlechat git clone https://github.com/tashfeenahmed/circlechat.git /opt/circlechat/app
cd /opt/circlechat/app
sudo -u circlechat npm ci
sudo -u circlechat npm run build
```

The server starts agent containers with `docker run`, so its user must be able to use Docker. Membership of the `docker` group gives root-equivalent access to the host. Use a dedicated user and don't run anything else as it.

Agent containers run as the same user id as the server (`--user <uid>:<gid>`), so files in the agents' home folders are owned by that user.

## TLS proxy

Keep `CIRCLECHAT_HOST=127.0.0.1` and put a proxy with TLS in front. The proxy must pass websockets (`/ws`) through.

### Caddy

Caddy gets a certificate on its own and forwards websockets and the `X-Forwarded-*` headers by default.

```caddyfile
chat.example.com {
	reverse_proxy 127.0.0.1:3100
}
```

### nginx

```nginx
server {
    listen 443 ssl;
    server_name chat.example.com;
    # ssl_certificate and ssl_certificate_key here

    client_max_body_size 4m;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;
    }
}
```

### Trusting the proxy

Set `CIRCLECHAT_TRUST_PROXY=1`. With it on:

- `X-Forwarded-Proto: https` marks the request as HTTPS, so the session cookie gets the `Secure` flag.
- `X-Forwarded-For` is the address used for login limits.

Only turn it on when the server can be reached through the proxy alone. If clients can reach the port directly, they can send these headers themselves.

## Agents on Linux

Agent containers reach the tool gateway at `host.docker.internal`. On Linux that name points to the Docker bridge address (usually `172.17.0.1`), not to loopback. A server bound to `127.0.0.1` can't be reached from a container.

Set `CIRCLECHAT_AGENT_LISTEN=docker0`. CircleChat then opens a second listener on the bridge address that serves only:

- `/mcp/<token>`: the tool endpoint. Each URL carries a per-session token.
- `/healthz`: returns `ok`.

Everything else returns 404 on that listener. The API and the web app stay on loopback, and the bridge address is not reachable from the internet. If `docker0` has no address yet (Docker not started), the server waits and retries every 5 seconds.

With a host firewall such as ufw, allow the port from the bridge only:

```bash
sudo ufw allow in on docker0 to any port 3100 proto tcp
```

Why this design: binding the whole server to the bridge would expose the API to every container, and host networking for agents would give sandboxes the host's network.

On macOS with Docker Desktop, `host.docker.internal` reaches the host's loopback, so you don't need this setting.

## systemd

`/etc/systemd/system/circlechat.service`:

```ini
[Unit]
Description=CircleChat
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
User=circlechat
Group=circlechat
WorkingDirectory=/opt/circlechat/app
Environment=CIRCLECHAT_DATA=/opt/circlechat/data
Environment=CIRCLECHAT_HOST=127.0.0.1
Environment=CIRCLECHAT_PORT=3100
Environment=CIRCLECHAT_TRUST_PROXY=1
Environment=CIRCLECHAT_AGENT_LISTEN=docker0
ExecStart=/usr/bin/node server/src/index.ts
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now circlechat
journalctl -u circlechat -f
```

On `SIGTERM` the server stops its listeners, stops every agent and closes the database. A turn that was running when the server stopped is marked failed ("server restarted mid-turn") and is not retried, because it may already have had side effects. Messages that were still queued are delivered after the restart.

To keep the vault key out of the data folder, set `CIRCLECHAT_MASTER_KEY` with `EnvironmentFile=` pointing to a file only root can read.

## Backups

The operator commands in `server/src/cli.ts` write to stdout. They use `CIRCLECHAT_DATA` like the server and are safe to run while it is up (SQLite WAL).

| Command | Output |
|---|---|
| `node server/src/cli.ts backup` | A `.tar.gz` with a consistent copy of the database (`circlechat.db`, made with `VACUUM INTO`) and the `agents/` folder. No vault key. |
| `node server/src/cli.ts export` | The full data export as a `.tar.gz`: `workspace.json` (every table as JSON, password hashes and secret values left out), `circlechat.db`, `agents/` and a `README.txt`. The owner can download the same file in Settings, Server, Your data. |
| `node server/src/cli.ts state` | `{"users":n,"agents":n,"workspace":"..."}` |
| `node server/src/cli.ts set-password-hash <email>` | Reads an scrypt hash on stdin, sets it as that person's password and signs them out everywhere. Prints `ok`. |

A nightly backup with cron:

```cron
15 3 * * * cd /opt/circlechat/app && CIRCLECHAT_DATA=/opt/circlechat/data node server/src/cli.ts backup > /var/backups/circlechat/$(date +\%F).tar.gz
```

Keep in mind:

- **Store the vault key separately.** Neither backup nor export contains it. Without it, the stored keys in a backup can't be read.
- **Docker named volumes are not included.** Engine state kept on a volume (such as `cc-<agent id>-hermes`) is not in the backup. Engine config in those volumes is copied in again from the agent's home at each start.
- **Agent homes can hold model keys in plain text** (engine config files). Protect backups like the data folder itself.

### Restoring a backup

There is no restore command. To restore a `backup` archive:

```bash
sudo systemctl stop circlechat
sudo -u circlechat mv /opt/circlechat/data /opt/circlechat/data.old
sudo -u circlechat mkdir -p /opt/circlechat/data
sudo -u circlechat tar -xzf backup.tar.gz -C /opt/circlechat/data
sudo -u circlechat cp /opt/circlechat/data.old/master.key /opt/circlechat/data/   # or your saved copy
sudo chmod 600 /opt/circlechat/data/master.key
sudo systemctl start circlechat
```

The archive holds `circlechat.db` and `agents/` at its root, which is the layout of the data folder.

### Resetting a password

Make a hash with CircleChat's scrypt format and pipe it to the CLI:

```bash
HASH=$(node --input-type=module -e "const m = await import('./server/src/crypto.ts'); console.log(m.hashPassword(process.argv[1]))" 'new password here')
echo "$HASH" | CIRCLECHAT_DATA=/opt/circlechat/data node server/src/cli.ts set-password-hash ada@example.com
```

## Upgrading

1. Take a backup.
2. Pull and build:

   ```bash
   cd /opt/circlechat/app
   sudo -u circlechat git pull
   sudo -u circlechat npm ci
   sudo -u circlechat npm run build
   ```

3. Restart: `sudo systemctl restart circlechat`.
4. Rebuild engine images that changed: Settings, Engines, **Update**, or the `docker build` commands in [Getting started](getting-started.md#install-an-engine).

The database schema is created with `CREATE TABLE IF NOT EXISTS` at every start. Read the [changelog](../CHANGELOG.md) before upgrading for any manual steps.

## Seed file

A seed file creates the owner, the workspace, model providers and starter agents on first boot, without a browser. It is useful for scripted installs.

```bash
CIRCLECHAT_SEED=/opt/circlechat/seed.json node server/src/index.ts
```

```json
{
  "workspace": "Acme",
  "owner": { "email": "ada@acme.test", "name": "Ada", "passwordHash": "scrypt$<salt>$<key>" },
  "providers": [
    { "id": "starter", "kind": "openai-compatible", "baseUrl": "http://host.docker.internal:3001/v1", "apiKey": "...", "models": ["auto"] }
  ],
  "agents": [{ "name": "Hermes", "engine": "hermes", "model": "starter:auto" }],
  "chat": "dm"
}
```

| Field | Required | Meaning |
|---|---|---|
| `workspace` | no | Workspace name. Default `My team`. |
| `owner.email` | yes | The owner's email. |
| `owner.name` | no | Default: the part of the email before `@`. |
| `owner.passwordHash` | one of these | An scrypt hash in CircleChat's format (see [Resetting a password](#resetting-a-password)). Whoever writes the file never needs the password. |
| `owner.password` | | A plain password, hashed when the seed is applied. Prefer `passwordHash`. |
| `providers[]` | no | `id`, `kind` (`openai-compatible`, `anthropic` or `openai`), `baseUrl`, `apiKey`, `models`, `label`. Keys go into the vault. |
| `agents[]` | no | `name`, and optionally `handle`, `engine` (default `hermes`), `model`, `roleTitle`, `instructions`, `sandbox` (`docker` or `local`). Seeded agents start on the **Does it, then tells me** autonomy level. |
| `chat` | no | `"dm"`: a one-to-one chat with each agent, and the first agent says hello. Any other text: a group with that name, the owner and every agent. `""`: no chat. Left out: a group called `General`. |
| `welcome` | no | A first message in the group, used only when there are no agents. |

Rules:

- The seed runs only while there are no users, so it can never overwrite a workspace in use.
- The file is deleted afterwards, whether it was applied or skipped, because it may hold a model key.
- If the seed fails, the server prints `Seed file failed: ...` and exits with code 1.

## Health checks

`GET /healthz` returns `200 ok` on the main port and on the agent listener. It does not check Docker or the database.
