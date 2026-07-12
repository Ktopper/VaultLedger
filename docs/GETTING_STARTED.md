# Getting started with VaultLedger

A non-developer path from a fresh clone to "Claude remembers across
sessions," in under 10 minutes. If you'd rather understand the pieces first,
see the [README](../README.md)'s architecture section and
[`spec.md`](../spec.md); this doc is the fast path.

## 0. Prerequisites

The only genuine wall here is the toolchain, not VaultLedger itself — get
these two things installed first:

**Node 22 LTS**

- macOS: `brew install node@22`
- Windows: download and run the installer from
  [nodejs.org](https://nodejs.org/) (pick the "LTS" build)
- Linux (Debian/Ubuntu, via nodesource):
  `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`

**pnpm**, via Node's built-in Corepack:

```sh
corepack enable pnpm
```

## 1. Clone and bootstrap

```sh
git clone <this repo's URL>
cd VaultLedger
pnpm bootstrap
```

`pnpm bootstrap` runs everything in one shot: installs dependencies, builds
`@vaultledger/core`/`cli`/`mcp-server` (`tsc --build`), builds the Obsidian
plugin (a separate esbuild step — the plugin's `main.js` is gitignored and
`tsc --build` doesn't produce it), then re-runs `pnpm install` once more so
pnpm links the `ledger` bin now that `packages/cli/dist/` exists. (The bin
link is skipped on the very first `install` because `dist/` doesn't exist
yet — that's the one bit of install-order trivia this command exists to hide.)

Confirm it worked:

```sh
ledger --version
```

## 2. Run `ledger setup` against your vault

```sh
ledger setup /path/to/your/vault
```

Point it at an existing Obsidian vault (or any folder of markdown — Obsidian
itself isn't required to use VaultLedger). `setup` first **scans** the vault
and prints what it found, then asks:

```
Write this zone manifest? [y/N]
```

This is the moment worth reading, not skipping past. VaultLedger divides
your vault into zones — trusted (agent can propose edits, you approve them),
agent (the agent's own memory notes), scratch (short-lived agent notes), and
excluded (the agent never reads or writes these at all). A vault with a
`Private/` folder gets a proposed manifest like:

```
Proposed zones: trusted=[**] agent=[Agent/**] scratch=[Agent/Scratch/**] excluded=[Private/**]
```

`Private/` excluded, everything else trusted — that's the actual
auditability boundary VaultLedger enforces in code, not a suggestion in a
prompt. Answer `y` once you're happy with it (or edit `.ledger/permissions.yaml`
by hand afterward — it's just YAML). Scripting or re-running non-interactively?
Pass `--yes` to auto-confirm.

## 3. The green line is the verification

After the zone prompt, `setup` prints a Claude Code MCP config block (see
step 4) and then a closing line like:

```
✓ smoke verified — 4 zone globs, journal healthy, 0 pending
```

**That green line means VaultLedger is verified working.** It just spawned
the real `vaultledger-mcp` server over stdio and called its `ledger_status`
tool — the exact same command Claude Code will run — with **no Claude Code
involved at all**. If everything past this point still doesn't work, the
fault is on the Claude-Code-wiring side, not VaultLedger: this line already
proved the broker, the journal, and the zone manifest are sound.

## 4. Wire it into Claude Code

`setup` prints a config block:

```json
{
  "mcpServers": {
    "vaultledger": {
      "command": "node",
      "args": ["/absolute/path/to/VaultLedger/packages/mcp-server/dist/index.js", "--vault", "/absolute/path/to/your/vault"]
    }
  }
}
```

Paste it into Claude Code's `.mcp.json` (merging with anything already
there). Or skip the copy-paste and have `setup` write it for you — this
merges into an existing file rather than clobbering it, so any other MCP
servers you've already configured are untouched:

```sh
ledger setup /path/to/your/vault --write-mcp ./.mcp.json
```

**Restart Claude Code** so it picks up the new server.

## 5. Install the review plugin (optional but recommended)

```sh
ledger setup /path/to/your/vault --install-plugin
```

This copies the built Obsidian plugin into
`<vault>/.obsidian/plugins/vaultledger/` — the approval queue, agent
activity log, provenance hover, and conflicts view described in the
[README](../README.md#the-review-surface-v02). Copying doesn't activate it;
finish in Obsidian:

1. **Settings → Community plugins**
2. Turn off **Restricted mode**, if it's on
3. Enable **VaultLedger**

## 6. First use

With Claude Code restarted and the MCP server wired, this is regular use —
not a second verification pass (step 3 already did that):

1. Ask the agent to remember something: *"Remember that the launch target is
   Q4."* — the agent calls `memory_remember`.
2. Start a **new** Claude Code session (or just a new conversation).
3. Ask it to recall: *"What's the launch target?"* — the agent calls
   `memory_recall` and gets back the fact, with its original provenance
   (which session wrote it, when, why).

If this step fails but step 3's green line was there, look at the
Claude-Code-side MCP wiring (the `.mcp.json` path, whether Claude Code was
actually restarted) first — VaultLedger itself already proved it works.

## Next steps

- [README](../README.md) — full architecture, the review surface, and
  contradiction detection.
- `ledger status /path/to/your/vault` — zones, pending approvals, recent
  transactions.
- `ledger approve /path/to/your/vault` — review and approve/reject queued
  trusted-zone edits.
- `ledger conflicts /path/to/your/vault` — contradictions the agent's writes
  have flagged.
- Re-running `ledger setup` any time is safe and diagnostic: an
  already-initialized vault, current MCP config, and a healthy smoke check
  all report back as `already`/`verified` rather than re-doing anything.
