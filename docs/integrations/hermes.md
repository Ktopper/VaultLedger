# VaultLedger + Hermes

Wire an Obsidian vault into [Hermes](https://hermes-agent.nousresearch.com/) as
governed, persistent memory.

> **Caveat:** Verified against the official Hermes docs (linked below), but not
> yet run against a live Hermes install. The VaultLedger side — the server, the
> tools, the broker — is the same one the other guides use and is well tested;
> what's untested here is the Hermes-side wiring described on this page.

New to VaultLedger? [`docs/GETTING_STARTED.md`](../GETTING_STARTED.md) is the
10-minute fast path.

## 1. Wire it

Hermes reads MCP servers from **`~/.hermes/config.yaml`**, under the
`mcp_servers` key. Each entry takes `command`, `args`, an optional `env`, and
`enabled` (default `true`).

**Recommended: a one-time global install.** Agent harnesses spawn MCP servers as
bare subprocesses, so a `PATH`-resolved bin is more reliable here than `npx`:

```sh
npm install -g @vault-ledger/mcp-server
```

```yaml
mcp_servers:
  vaultledger:
    command: "vaultledger-mcp"
    args: ["--vault", "/absolute/path/to/vault"]
    enabled: true
```

This still honors VaultLedger's rule, which is **"never a path that can be
pruned"** — not "always literally npx." A `PATH`-resolved bin name is durable;
`~/.npm/_npx/<hash>/…` is not. (One caveat on the global form: *if you use nvm,
reinstall `@vault-ledger/mcp-server` after switching Node versions — global bins
are Node-version-scoped.*)

**Alternative, no global install** — the npx form:

```yaml
mcp_servers:
  vaultledger:
    command: "npx"
    args: ["-y", "-p", "@vault-ledger/mcp-server", "vaultledger-mcp", "--vault", "/absolute/path/to/vault"]
    enabled: true
```

The bin name `vaultledger-mcp` differs from the package name
`@vault-ledger/mcp-server`, which is why the `-p <package> <bin>` form is
needed. `--vault` must be absolute either way.

**Reload:** restart with `hermes chat`, or run `/reload-mcp` in an active
session.

## Tool names in Hermes

Hermes registers MCP tools as `mcp_<server>_<tool>`, converting hyphens and dots
to underscores. Under the `vaultledger` server name above, the twelve tools appear
as:

```
mcp_vaultledger_memory_recall      mcp_vaultledger_memory_distill
mcp_vaultledger_memory_remember    mcp_vaultledger_vault_read
mcp_vaultledger_memory_revise      mcp_vaultledger_vault_propose_replace
mcp_vaultledger_memory_promote     mcp_vaultledger_vault_propose_create
mcp_vaultledger_memory_retire      mcp_vaultledger_vault_propose_edit
mcp_vaultledger_memory_forget      mcp_vaultledger_ledger_status
```

For vault writes, `vault_propose_replace` (edits) and `vault_propose_create` (new
files) are the default path — describe the change as exact find/replace text or
full content and the broker builds the diff; `vault_propose_edit` (a raw unified
diff) is the advanced surface, for a caller that already holds one. Before an edit,
`vault_read` returns the note's exact bytes and `hash` — the source of a
byte-perfect `old_text` and the `expected_hash` a replace needs. That read-fresh,
byte-for-byte-`old_text` discipline is rule 6 of the standing instruction below.

> **Gotcha:** the optional `tools.include` / `tools.exclude` filters match the
> **original** tool names — `memory_recall`, `vault_propose_edit` — **not** the
> registered `mcp_vaultledger_*` names. Filtering on the registered name
> silently matches nothing.

## 2. Verify it

Two steps, because they catch different failures.

**Step 1 — the install side:**

```sh
npx @vault-ledger/cli@latest doctor /path/to/vault
```

Checks that the native binding loads, the mcp-server entry resolves, and the
vault, zones, and journal are healthy. `--json` for machine-readable
`CheckResult[]`; `--strict` to treat warnings as failures (exit 1).

**Step 2 — end-to-end:** reload Hermes (`/reload-mcp` or restart `hermes chat`),
ask the agent to remember something, then in a **new session** ask it to recall.
Check that the note landed in `Agent/Memory/` in the vault.

Step 2 is the real proof, because **doctor validates the install but never reads
YOUR `~/.hermes/config.yaml`** — a stale path there fails only at
harness-connect time, which doctor can't see. Step 1 tells you *which side* is
broken when step 2 fails.

## 3. Teach it

The tools describe *how* to call them; the standing instruction teaches *when*.
Six rules with their rationale, at
[`skills/vaultledger-memory/SNIPPET.md`](../../skills/vaultledger-memory/SNIPPET.md).
A taste:

> **Prefer `memory_retire` over `memory_forget`** — because retired stays
> queryable in history and can still be cited; forget tombstones it.

`SNIPPET.md` is paste-ready for a Hermes profile or system prompt — paste it
whole.

## 4. Trust model

Hermes has **no interactive per-call approval prompts** for custom MCP entries —
it executes what the config specifies.

That's acceptable rather than alarming, and it's worth being precise about why:
it makes VaultLedger's broker the only enforcement layer in the loop, which is
exactly the product's thesis. Trusted-zone writes still queue for human approval
no matter what the agent tries — enforced in code, not in a prompt the model can
drift around and not in a dialog box the harness happens to show. The guarantee
was never coming from the harness.

Review the queue with `npx @vault-ledger/cli@latest approve /path/to/vault`, or
install the Obsidian plugin (`setup /path/to/vault --install-plugin`).

## Sources

- [Hermes MCP feature guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)
- [Hermes MCP config reference](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference)
