# Integrations — pick your harness

VaultLedger is an MCP server, so anything that speaks MCP can use the vault as
governed memory. These guides are the per-harness depth; if you're setting up
for the first time, start with
[`docs/GETTING_STARTED.md`](../GETTING_STARTED.md) — the 10-minute fast path
from nothing to "the agent remembers across sessions."

| Guide | For |
|---|---|
| [Claude Code](claude-code.md) | Anthropic's CLI — `.mcp.json`, skills, `CLAUDE.md` |
| [Hermes](hermes.md) | Nous Research's agent — `~/.hermes/config.yaml` |
| [Generic MCP clients](mcp-clients.md) | Any other harness, and the minimal contract |

## What every integration has in common

Whatever the harness, the shape is the same three things. VaultLedger runs as a
**stdio MCP server** launched by a `command` + `args` pair that ends in
**`--vault <absolute path>`** — that argument is what binds the server to a
specific vault, and it must be absolute. The command itself must be **durable**:
a published bin name on your `PATH`, or the `npx -p @vault-ledger/mcp-server
vaultledger-mcp` form — never a path into an npx/dlx cache
(`~/.npm/_npx/<hash>/…`), which npm can prune weeks later and turn a working
config into a silent "MCP server not responding." Then there's a **standing
instruction** that teaches the agent *when* to reach for the tools — the tools
are self-describing, so an agent can call them; the discipline is what makes the
memory good instead of noisy.

Each guide follows the same four beats: **wire it**, **verify it**, **teach
it**, **trust model**.

## The constant across all of them

VaultLedger's broker is the enforcement layer. Trusted-zone writes queue for
human approval regardless of what the agent attempts, in every harness on this
list and every one that isn't. A harness's own approval prompts are a *bonus* —
never the guarantee.
