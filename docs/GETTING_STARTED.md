# Getting started with VaultLedger

The fastest path from nothing to "Claude remembers across sessions," in under
10 minutes: install Node, then one `npx` command — no clone, no `pnpm`. If
you'd rather understand the pieces first, see the [README](../README.md)'s
architecture section and [`spec.md`](../spec.md); this doc is the fast path.
(Contributing to VaultLedger itself, or want to run from a clone? Skip to
[From source (contributors)](#from-source-contributors) at the end.)

## 0. Prerequisite: Node

The only genuine wall here is the toolchain, not VaultLedger itself — install
**Node 20 or later**:

- macOS: `brew install node@22`
- Windows: download and run the installer from
  [nodejs.org](https://nodejs.org/) (pick the "LTS" build)
- Linux (Debian/Ubuntu, via nodesource):
  `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`

That's it — `npx` ships with Node, so there's nothing else to install.

## 1. Run `ledger setup` against your vault

```sh
npx @vault-ledger/cli@latest setup /path/to/your/vault
```

`npx` downloads `@vault-ledger/cli` on first run (nothing installed globally,
nothing to uninstall later) and runs `ledger setup` against your vault.
Point it at an existing Obsidian vault (or any folder of markdown — Obsidian
itself isn't required to use VaultLedger). `setup` first **scans** the vault
and prints what it found, then asks:

> **One thing setup does to your folder:** if your vault isn't already a Git
> repository, setup runs `git init` in it. That Git history *is* the rollback
> mechanism — it's how `ledger undo` reverts an agent's change. The scan output
> tells you when this will happen, before you confirm. Nothing else is touched:
> besides `.git/`, VaultLedger's only footprint is the `.ledger/` folder (config
> + zone manifest) and the agent zone; your existing notes are left byte-for-byte
> alone.

```
Write this zone manifest? [y/N]
```

This is the moment worth reading, not skipping past. VaultLedger divides
your vault into zones — trusted (agent can propose edits, you approve them),
agent (the agent's own memory notes), scratch (short-lived agent notes), and
excluded (the agent never reads or writes these at all). `.obsidian/**` (your
Obsidian app config/plugins folder — never notes) is always excluded; a vault
that also has a `Private/` folder gets a proposed manifest like:

```
Proposed zones: trusted=[**] agent=[Agent/**] scratch=[Agent/Scratch/**] excluded=[.obsidian/**,Private/**]
```

`.obsidian/` and `Private/` excluded, everything else trusted — that's the
actual auditability boundary VaultLedger enforces in code, not a suggestion in
a prompt. Answer `y` once you're happy with it (or edit
`.ledger/permissions.yaml` by hand afterward — it's just YAML). Scripting or
re-running non-interactively? Pass `--yes` to auto-confirm.

## 2. The green line is the verification

After the zone prompt, `setup` prints a Claude Code MCP config block (see
step 3) and then a closing line like:

```
✓ smoke verified — 5 zone globs, journal healthy, 0 pending
```

The exact counts depend on your vault (a vault with a `Private/` folder shows
5 zone globs, one without shows 4; `pending` is however many trusted-zone
edits are awaiting approval) — **what matters is the leading `✓` and
`journal healthy`, not the specific numbers.** ("journal healthy" refers to
VaultLedger's SQLite index, which lives in your OS application-support
directory — *not* inside the vault — so you won't find it in `.ledger/`; the
vault + Git remain the source of truth, and the journal is a disposable,
rebuildable cache.)

**That green line means VaultLedger is verified working.** It just spawned
the real `vaultledger-mcp` server over stdio and called its `ledger_status`
tool — the exact same command Claude Code will run — with **no Claude Code
involved at all**. If everything past this point still doesn't work, the
fault is on the Claude-Code-wiring side, not VaultLedger: this line already
proved the broker, the journal, and the zone manifest are sound.

## 3. Wire it into Claude Code

`setup` prints a config block:

```json
{
  "mcpServers": {
    "vaultledger": {
      "command": "npx",
      "args": ["-y", "-p", "@vault-ledger/mcp-server", "vaultledger-mcp", "--vault", "/absolute/path/to/your/vault"]
    }
  }
}
```

(The bin name `vaultledger-mcp` differs from the package name
`@vault-ledger/mcp-server`, so the `-p <package> <bin>` form is what tells
`npx` which command to run.)

Paste it into Claude Code's `.mcp.json` (merging with anything already
there). Or skip the copy-paste and have `setup` write it for you — this
merges into an existing file rather than clobbering it, so any other MCP
servers you've already configured are untouched:

```sh
npx @vault-ledger/cli@latest setup /path/to/your/vault --write-mcp ./.mcp.json
```

**Restart Claude Code** so it picks up the new server.

## 4. Install the review plugin (optional but recommended)

```sh
npx @vault-ledger/cli@latest setup /path/to/your/vault --install-plugin
```

This copies the built Obsidian plugin into
`<vault>/.obsidian/plugins/vaultledger/` — the approval queue, agent
activity log, provenance hover, and conflicts view described in the
[README](../README.md#the-review-surface-v02). Copying doesn't activate it;
finish in Obsidian:

1. **Settings → Community plugins**
2. Turn off **Restricted mode**, if it's on
3. Enable **VaultLedger**

## 5. First use

With Claude Code restarted and the MCP server wired, this is regular use —
not a second verification pass (step 2 already did that):

1. Ask the agent to remember something: *"Remember that the launch target is
   Q4."* — the agent calls `memory_remember`.
2. Start a **new** Claude Code session (or just a new conversation).
3. Ask it to recall: *"What's the launch target?"* — the agent calls
   `memory_recall` and gets back the fact, with its original provenance
   (which session wrote it, when, why).

If this step fails but step 2's green line was there, look at the
Claude-Code-side MCP wiring (the `.mcp.json` path, whether Claude Code was
actually restarted) first — VaultLedger itself already proved it works.

## Next steps

- [**Integration guides**](integrations/README.md) — per-harness depth:
  [Claude Code](integrations/claude-code.md) (skills, `CLAUDE.md`, the
  `--write-mcp` merge), [Hermes](integrations/hermes.md), or
  [any other MCP client](integrations/mcp-clients.md).
- [README](../README.md) — full architecture, the review surface, and
  contradiction detection.
- `npx @vault-ledger/cli@latest status /path/to/your/vault` — zones, pending
  approvals, recent transactions.
- `npx @vault-ledger/cli@latest approve /path/to/your/vault` — review and
  approve/reject queued trusted-zone edits.
- `npx @vault-ledger/cli@latest conflicts /path/to/your/vault` —
  contradictions the agent's writes have flagged.
- Re-running `ledger setup` any time is safe and diagnostic: an
  already-initialized vault, current MCP config, and a healthy smoke check
  all report back as `already`/`verified` rather than re-doing anything.

## From source (contributors)

Working on VaultLedger itself, or want to run it from a clone instead of npm?

```sh
git clone https://github.com/Ktopper/VaultLedger.git
cd VaultLedger
pnpm bootstrap
```

`pnpm bootstrap` runs everything in one shot: installs dependencies (which
also links the `ledger`/`vaultledger-mcp` bins — they're committed launcher
scripts, so pnpm links them on the very first `install`, before anything is
built), builds `@vault-ledger/core`/`cli`/`mcp-server` (`tsc --build`), then
builds the Obsidian plugin (a separate esbuild step — the plugin's `main.js`
is gitignored and `tsc --build` doesn't produce it). If you're on **pnpm
10+**, it may pause with an approval prompt for `better-sqlite3`'s native
build script — run `pnpm approve-builds` once and re-run `pnpm bootstrap`
(this only affects installing from source via pnpm; `npx` users never hit
it, since the published package ships prebuilt binaries for common platforms
and only compiles from source — needing a C++ toolchain — on unusual ones).
A related network caveat: those prebuilt binaries download from GitHub release
assets, so an environment behind a **restrictive/corporate proxy** (or an
offline sandbox) that blocks those assets falls back to a source compile — and
if a toolchain isn't reachable either, `better-sqlite3` won't install. On any
broken/partial native install, `ledger doctor <vault>` names it directly (the
`native-deps` check) and every command prints a one-line reinstall hint rather
than a raw bindings error.

Confirm it worked:

```sh
pnpm exec ledger --version
```

A workspace bin like `ledger` isn't on your shell's `PATH` by itself — `pnpm
exec` is what finds it (from the repo root; it resolves via the root
`node_modules/.bin`). If you'd rather type a bare `ledger`, either run
`pnpm -C packages/cli link --global` once, or add a shell alias.

From here, every `npx @vault-ledger/cli@latest <cmd>` command above has a
from-source equivalent: `pnpm exec ledger <cmd>` (same arguments), run from
the repo root. The MCP config block `setup` prints from a clone uses the
repo-dist form instead of `npx`:

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

See the [README's Developer walkthrough](../README.md#developer-walkthrough-v01-internals-manual-steps)
for the exact lower-level commands (init, MCP wiring, remember/recall,
approve, undo) that make up the v0.1 governed-write loop.
