# Contributing

Thanks for helping with CircleChat. This page explains how to propose a change and what we look for in a pull request.

By taking part you agree to follow the [code of conduct](CODE_OF_CONDUCT.md).

## Before you start

- **Bugs:** open an issue with the steps to reproduce, what you expected, and what happened. Include the CircleChat version, the engine and your OS.
- **Security problems:** don't open an issue. Follow [SECURITY.md](SECURITY.md).
- **Larger changes:** open an issue first to agree on the approach, so your work isn't wasted.

## Contributor licence agreement

Before your first pull request is merged you'll be asked to sign the contributor licence agreement (CLA) with one click. It lets the project keep its licensing options open (for example, offering CircleChat under other terms to companies that can't use AGPL software). Your contribution stays open source here.

## Set up

```bash
git clone https://github.com/tashfeenahmed/circlechat.git
cd circlechat
npm install
npm test
```

See [docs/development.md](docs/development.md) for the repo layout, the scripts, the test engine and how to run the web app with hot reload.

## Pull requests

- Keep pull requests small and focused, with a test (`npm test`).
- Run `npm run typecheck` and `npm test` before you push. CI runs both, and builds the web app.
- Explain the change and why in the description. Link the issue.
- Update the docs in `docs/` when behaviour, settings or the API change, and add a line to [CHANGELOG.md](CHANGELOG.md) under Unreleased.

## Rules we hold every change to

- **UI copy:** plain words, short sentences, say "agent", no em dashes.
- **Secrets:** never log or return secrets. Store them in the vault and return only a flag such as `hasSecret`.
- **Closed by default:** anything that touches the gateway, vault or sandbox needs a test that proves it stays closed by default.
- **Code style:** TypeScript that Node can run directly, formatted with Prettier (`.prettierrc.json`), with the `SPDX-License-Identifier: AGPL-3.0-only` header. See [Code style](docs/development.md#code-style).

## Licence

CircleChat is licensed under AGPL-3.0-only. The name and logo are trademarks: see [TRADEMARK.md](TRADEMARK.md).
