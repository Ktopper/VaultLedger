# VaultLedger + Claude Code

Wire an Obsidian vault into Claude Code as governed, persistent memory. New to
VaultLedger? [`docs/GETTING_STARTED.md`](../GETTING_STARTED.md) is the
10-minute fast path; this page is the Claude-Code-specific depth.

## 1. Wire it

Claude Code reads MCP servers from **`.mcp.json`** in your project root. Add the
`vaultledger` entry:

```json
{
  "mcpServers": {
    "vaultledger": {
      "command": "npx",
      "args": ["-y", "-p", "@vault-ledger/mcp-server", "vaultledger-mcp", "--vault", "/absolute/path/to/vault"]
    }
  }
}
```

The bin name `vaultledger-mcp` differs from the package name
`@vault-ledger/mcp-server` — that's what the `-p <package> <bin>` form is for.
`--vault` must be an **absolute** path.

Or skip the copy-paste and let setup write it:

```sh
npx @vault-ledger/cli@latest setup /path/to/vault --write-mcp ./.mcp.json
```

This **merges** into an existing file rather than clobbering it — any other MCP
servers you've configured are untouched.

> **One thing to know about `--write-mcp`:** it *overwrites* our `command` and
> `args` on an existing `vaultledger` entry (siblings and your own extra keys
> like `env` or `disabled` survive). So if you hand-wrote the npx form above and
> later run `--write-mcp` from a *stable* install, your block is rewritten to
> the physical-path form. That's deliberate — a stable path is correct, and
> emitting npx from a source clone would silently test the published package
> instead of your local build — but it's better to know than to discover.

**Restart Claude Code** so it picks up the new server.

## 2. Verify it

Two steps, because they catch different failures.

**Step 1 — the install side:**

```sh
npx @vault-ledger/cli@latest doctor /path/to/vault
```

Checks that the native binding loads, the mcp-server entry resolves, and the
vault, zones, and journal are healthy. Add `--json` for machine-readable
`CheckResult[]`, or `--strict` to treat warnings as failures (exit 1).

**Step 2 — end-to-end:** restart Claude Code, ask the agent to remember
something (*"Remember that the launch target is Q4."*), then in a **new
session** ask it to recall (*"What's the launch target?"*). Check that the note
actually landed in `Agent/Memory/` in the vault.

Step 2 is the real proof, because **doctor validates the install but never reads
YOUR `.mcp.json`** — a stale path there fails only at harness-connect time,
which doctor can't see. Step 1 is what tells you *which side* is broken when
step 2 fails: doctor green + recall broken means the wiring, not VaultLedger.

## 3. Teach it

The fifteen default tools are self-describing, so Claude Code *can* call them. The
standing instruction teaches **when** — six rules, each with its rationale. Read them at
[`skills/vaultledger-memory/SNIPPET.md`](../../skills/vaultledger-memory/SNIPPET.md).
A taste:

> **Recall before you start** on a known entity — because starting cold means
> contradicting what's already known, or re-asking what the user already told
> you.

For vault writes: `vault_propose_replace` (edits), `vault_propose_create` (new
files), `vault_propose_delete`, and `vault_propose_move` (rename/relocate) are the
path — describe the change and the broker builds the diff or does the
git-committed op, all queued for approval; the raw-diff `vault_propose_edit` is a
16th tool behind the `--allow-raw-diff` opt-in, not the default. For discovery,
`vault_read` returns a note's exact bytes and `hash` (the source of a byte-perfect
`old_text` and `expected_hash` a replace needs), `vault_search` greps raw note
content ("which file says X"), and `vault_list` enumerates a folder. Rule 6 (and
rule 1) carry that discipline — read fresh with `vault_read`, copy `old_text`
byte-for-byte; recall first, search on a miss.

Two ways to install it:

**Shape A — as an Agent Skill.** Copy `skills/vaultledger-memory/` into your
project's `.claude/skills/`. `SKILL.md` carries the frontmatter that makes it
trigger on its own.

```sh
cp -R skills/vaultledger-memory .claude/skills/
```

**Shape B — as a standing instruction.** Paste the contents of
[`SNIPPET.md`](../../skills/vaultledger-memory/SNIPPET.md) into your
`CLAUDE.md`. Same rules, always in context.

Pick one. `SNIPPET.md` and `SKILL.md` are held identical by a test, so neither
shape drifts from the other.

## 4. Trust model

Claude Code has its own tool-approval settings, and it will prompt you per its
configuration. **VaultLedger's guarantees do not depend on any of that.** The
broker is the enforcement layer: trusted-zone writes queue for human approval
regardless of what the agent attempts, and regardless of how permissively you've
configured Claude Code's own prompts. A harness's approval UI is a bonus, never
the guarantee.

Review the queue in Obsidian rather than the terminal:

```sh
npx @vault-ledger/cli@latest setup /path/to/vault --install-plugin
```

This copies the review plugin into `<vault>/.obsidian/plugins/vaultledger/` —
approval queue with diffs, agent activity with one-click undo, provenance on
hover, conflicts. Copying doesn't activate it: in Obsidian, **Settings →
Community plugins** → turn off Restricted mode if it's on → enable
**VaultLedger**.
