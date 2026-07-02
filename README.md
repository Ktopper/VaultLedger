# VaultLedger

**Git for agent beliefs** — a governed memory broker that lets any AI agent use
an Obsidian vault (or any markdown folder) as persistent memory, with
provenance, approval, and rollback enforced *in code, not prompts*.

> **Status:** v0.1 in development. This is the deterministic write-broker core —
> the layer every agent write must pass through. See [`spec.md`](spec.md) for the
> product spec and [`docs/superpowers/specs/`](docs/superpowers/specs/) for the
> v0.1 design.

## Why

AI agents can now read and write Obsidian vaults as memory — but every existing
solution governs writes with *prompts*, which the model can ignore, hallucinate
around, or violate under drift. There is no enforcement layer. VaultLedger is
that layer: agents never touch files directly. They emit structured operations,
and a deterministic broker validates zone permissions, verifies file hashes,
applies patch-level edits only, stamps provenance, commits each transaction to
Git, and queues protected-zone writes for human approval.

## Architecture

```
vaultledger/
├── packages/
│   ├── core/            # broker: zones, hashing, patch apply, Git, journal (SQLite)
│   ├── mcp-server/      # MCP tools: remember / recall / revise / promote / forget / status
│   ├── cli/             # ledger init | status | approve | undo | log
│   └── obsidian-plugin/ # review queue, diffs, provenance hover, rollback (v0.2)
```

- **MCP memory server** — exposes memory tools to any MCP client. Agents never
  touch files directly.
- **Deterministic write broker** — validates every operation against a
  permissions manifest, applies patch-level edits with hash checks, stamps
  provenance, commits each transaction to Git, queues protected-zone writes for
  approval.
- **Obsidian review plugin** (v0.2) — the "what does my agent believe?" surface:
  approval queue with diffs, provenance on hover, one-click rollback.

## Core guarantees

- The model never writes vault files directly — all mutations go through the
  broker.
- Patch-level edits only; whole-file rewrites are a broker rejection.
- Every mutation is attributable: who, when, why, which session, which commit.
- `.ledger/` is the only in-vault footprint besides the agent zone.
- Rollback of any transaction or entire session via `git revert`, with the
  memory journal kept consistent.

## Stack

TypeScript throughout (Node MCP server + write broker; Obsidian plugin; SQLite
index).

## Status & roadmap

- **v0.1** — core broker + MCP server + CLI (approve/undo). Prove the loop.
- **v0.2** — Obsidian review plugin.
- **v0.3** — lifecycle automation, contradiction/staleness queues.
- **v1.0** — polish, packaged installers, integration guides.

## License

MIT
