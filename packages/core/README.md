# @vault-ledger/core

This is an internal library of VaultLedger — you probably want [`@vault-ledger/cli`](https://www.npmjs.com/package/@vault-ledger/cli).

`@vault-ledger/core` is the broker: the governed, provenance-tracked write path that every VaultLedger mutation goes through on its way into an Obsidian vault. It is consumed by `@vault-ledger/server`, `@vault-ledger/mcp-server`, and `@vault-ledger/cli` and is not meant to be used standalone.

See the [repo README](https://github.com/Ktopper/VaultLedger#readme) and [docs/GETTING_STARTED.md](https://github.com/Ktopper/VaultLedger/blob/main/docs/GETTING_STARTED.md) for how the pieces fit together.
