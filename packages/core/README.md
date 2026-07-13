# @vaultledger/core

This is an internal library of VaultLedger — you probably want [`@vaultledger/cli`](https://www.npmjs.com/package/@vaultledger/cli).

`@vaultledger/core` is the broker: the governed, provenance-tracked write path that every VaultLedger mutation goes through on its way into an Obsidian vault. It is consumed by `@vaultledger/server`, `@vaultledger/mcp-server`, and `@vaultledger/cli` and is not meant to be used standalone.

See the [repo README](https://github.com/Ktopper/VaultLedger#readme) and [docs/GETTING_STARTED.md](https://github.com/Ktopper/VaultLedger/blob/main/docs/GETTING_STARTED.md) for how the pieces fit together.
