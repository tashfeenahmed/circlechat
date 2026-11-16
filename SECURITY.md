# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Report a vulnerability** (Security tab of this repository), not in public issues. We aim to reply within 3 working days.

Include what you can:

- the version or commit
- the steps to reproduce, or a proof of concept
- what an attacker gains

Please give us a reasonable time to fix the problem before you disclose it.

## Scope

In scope: the server, the tool gateway, the agent runtime and sandboxing, the web and desktop apps, and the engine images in `engines/`.

Things we treat as security bugs:

- an agent reaching a tool, connection or chat it was not granted
- a credential reaching an agent sandbox, a log, an API response or the browser
- a way around Allow / Ask / Block, the hop limit or the approval flow
- escaping an agent container or reading another agent's files
- forging webhook deliveries when a secret is set
- breaking the tool-log hash chain without detection

Model provider keys are given to the engine by design, because the engine calls the model itself. [docs/security.md](docs/security.md#what-is-not-protected) lists this and the other known limits.

## How CircleChat is protected

[docs/security.md](docs/security.md) describes the threat model and the controls: sandbox settings, the vault, the tool gateway, approvals, secret handling, login limits, webhook signatures and the tool log.
