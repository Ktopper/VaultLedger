# @vault-ledger/mcp-server

The MCP server that gives an AI agent memory tools over an Obsidian vault, governed by the VaultLedger broker — every write is patch-level, provenance-tracked, and attributable.

Add it to your agent's `.mcp.json`:

```json
{
  "mcpServers": {
    "vaultledger": {
      "command": "npx",
      "args": ["-y", "-p", "@vault-ledger/mcp-server", "vaultledger-mcp", "--vault", "/path/to/vault"]
    }
  }
}
```

Run `npx @vault-ledger/cli setup /path/to/vault` first to initialize the vault. See the [repo README](https://github.com/Ktopper/VaultLedger#readme) and [docs/GETTING_STARTED.md](https://github.com/Ktopper/VaultLedger/blob/main/docs/GETTING_STARTED.md) for full setup.
