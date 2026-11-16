# Contributing

Thanks for helping. Before your first pull request is merged you'll be asked to sign the contributor licence agreement (CLA) with one click. It lets the project keep its licensing options open (for example offering CircleChat under other terms to companies that can't use AGPL software); your contribution stays open source here.

- Keep pull requests small and focused, with a test (`npm test`).
- UI copy: plain words, short sentences, say "agent", no em dashes.
- Never log or return secrets. Anything that touches the gateway, vault or sandbox needs a test that proves it stays closed by default.
