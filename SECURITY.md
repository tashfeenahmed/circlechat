# Security

Please report vulnerabilities privately through GitHub's "Report a vulnerability" (Security tab), not in public issues. We aim to reply within 3 working days.

In scope: the server, the tool gateway, the agent runtime and sandboxing, the web and desktop apps, the engine images in `engines/`.

Things we treat as security bugs:
- an agent reaching a tool, connection or chat it was not granted
- a credential reaching an agent sandbox, a log, an API response or the browser
- a way around Allow / Ask / Block, the hop limit or the approval flow
- escaping an agent container or reading another agent's files
- forging webhook deliveries when a secret is set
- breaking the tool-log hash chain without detection
