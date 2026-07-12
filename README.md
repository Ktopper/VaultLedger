# VaultLedger

**Git for agent beliefs** — a governed memory broker that lets any AI agent use
an Obsidian vault (or any markdown folder) as persistent memory, with
provenance, approval, and rollback enforced *in code, not prompts*.

> **Status:** v0.3b shipped; v0.4 (onboarding & setup) in progress. Shipped: the
> deterministic write-broker core (v0.1), the review surface (v0.2 — localhost
> HTTP bridge + Obsidian plugin), write-time contradiction detection (v0.3a),
> and the Undertow merge — `memory_distill`/`memory_retire`, source-linked
> staleness, memory-health reporting (v0.3b). See [`spec.md`](spec.md) for the
> product spec and [`docs/design/specs/`](docs/design/specs/) for the designs.

## Why

AI agents can now read and write Obsidian vaults as memory — but every existing
solution governs writes with *prompts*, which the model can ignore, hallucinate
around, or violate under drift. There is no enforcement layer. VaultLedger is
that layer: agents never touch files directly. They emit structured operations,
and a deterministic broker validates zone permissions, verifies file hashes,
applies patch-level edits only, stamps provenance, commits each transaction to
Git, and queues protected-zone writes for human approval.

## Quickstart

```sh
git clone <this repo's URL> && cd VaultLedger
pnpm bootstrap                      # install deps, build core/cli/mcp-server/plugin, link the `ledger` bin
ledger setup /path/to/your/vault    # zone review, Claude Code MCP config, a real verification smoke check
```

`ledger setup` walks you through the vault's zone manifest (which folders the
agent may propose edits to vs. never touch), prints — or `--write-mcp <path>`
writes — a Claude Code MCP config block, and finishes with a green `smoke
verified` line proving the real server runs, with no Claude Code involved
yet. Add `--install-plugin` to also install the Obsidian review plugin.
Re-running `ledger setup` is safe and idempotent — an already-set-up vault
reports back diagnostic-shaped (`already` / `verified`) rather than
redoing anything. See **[`docs/GETTING_STARTED.md`](docs/GETTING_STARTED.md)**
for the full non-developer walkthrough (under 10 minutes, zero existing notes
touched).

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
- `.ledger/` is the only in-vault footprint of agent/broker writes besides the
  agent zone. (The one sanctioned human-initiated exception: `ledger setup
  --install-plugin` copies the review plugin into `<vault>/.obsidian/plugins/`
  — an explicit opt-in flag, touching Obsidian config, never notes.)
- Rollback of any transaction or entire session via `git revert`, with the
  memory journal kept consistent.

## Developer walkthrough (v0.1 internals, manual steps)

The [Quickstart](#quickstart) above (`pnpm bootstrap` + `ledger setup`) is the
fast path for getting a vault wired up. This section instead walks through the
exact lower-level commands and tool calls that make up the v0.1 governed-write
loop — useful if you're working *on* VaultLedger itself, or just want to see
each moving part: init a vault, wire an agent to it over MCP, remember and
recall a fact, check status, approve a queued edit, and undo a transaction.
(This is also, almost verbatim, what `packages/mcp-server/test/v01-gate.e2e.test.ts`
asserts end-to-end — this walkthrough and the release gate are the same loop.)

**1. Install and build**

```sh
corepack enable pnpm
pnpm install
pnpm build
```

This builds `@vaultledger/core`, `@vaultledger/cli` (the `ledger` bin), and
`@vaultledger/mcp-server` (the `vaultledger-mcp` bin) via `tsc --build`. (`pnpm
bootstrap` does this plus the Obsidian plugin build plus the bin-link fixup
below, in one command — see [Quickstart](#quickstart).)

> **Invoking `ledger`:** pnpm links the `ledger` bin from
> `packages/cli/dist/index.js`, which doesn't exist until `pnpm build` runs — so
> the link is skipped during the initial `pnpm install`. After building, either
> run `pnpm install` once more to (re)create the bin link, or invoke the CLI
> directly as `node packages/cli/dist/index.js <args>` (equivalent to `ledger
> <args>` below). The MCP server is likewise `node packages/mcp-server/dist/index.js`.

**2. Initialize a vault**

```sh
ledger init /absolute/path/to/your/vault --yes
```

Without `--yes`, `init` only *scans* the vault (note/link counts, detected
folders, a proposed zone manifest) and prints what it would do — no writes at
all. With `--yes`, it writes exactly two things: `.ledger/config.json` (a
generated vault id + config) and `.ledger/permissions.yaml` (the zone
manifest: `trusted` / `agent` / `scratch` / `excluded` globs), and runs `git
init` if the vault isn't already a git repo. Every other file in the vault —
your existing notes — is left byte-for-byte untouched; `.ledger/` (plus the
agent zone it points at, typically `Agent/`) is VaultLedger's only footprint.
(`ledger setup` wraps this same scan-then-prompt flow — see Quickstart.)

**3. Wire an agent to it over MCP**

Point an MCP-capable client at the built server binary, passing the vault as
`--vault`. (`ledger setup` — or `ledger setup --write-mcp <path>` — generates
this block for you; see [`packages/mcp-server/examples/mcp.json`](packages/mcp-server/examples/mcp.json)
for a static example):

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

Running straight out of this repo, `node <repo>/packages/mcp-server/dist/index.js`
is the reliable invocation (the bare `vaultledger-mcp` bin only resolves once the
package is globally installed/linked). The server exposes 9 tools: `memory_recall`,
`memory_remember`, `memory_distill`, `memory_revise`, `memory_promote`,
`memory_forget`, `memory_retire`, `vault_propose_edit`, and `ledger_status`.

**4. Remember, then recall**

An agent calls `memory_remember` with the fact it wants to keep:

```json
{ "content": "Nova's launch target is Q4.", "entity": "nova", "reason": "user shared a deadline", "tags": ["deadline"] }
```

This lands immediately as a new scratch-status note under `Agent/Memory/`,
stamped with provenance frontmatter (id, session, reason, timestamp) and
committed to git as `ledger: create ...`. Any session — including a later one,
after the agent's context resets — recovers it with `memory_recall`:

```json
{ "entity": "nova" }
```

which returns the memory with its original provenance intact (it still says
which session created it, not whoever's asking).

**5. Propose a trusted-zone edit**

Writes to the *trusted* zone (ordinary vault notes, not the agent zone) are
never applied directly — `vault_propose_edit` always queues them for human
approval:

```json
{ "path": "Projects/Nova.md", "patch": "<unified diff>", "expected_hash": "sha256:...", "reason": "assign an owner" }
```

The file is untouched on disk until a human approves it.

**6. Check status**

```sh
ledger status /absolute/path/to/your/vault
```

Prints the zone manifest, the count of pending approvals, and the most recent
transactions (op, path, status) from the journal.

**7. Approve the queued edit**

```sh
ledger approve /absolute/path/to/your/vault            # list pending approvals with rendered diffs
ledger approve /absolute/path/to/your/vault --id <id>  # apply the queued patch (or --reject to discard it)
```

**8. Undo**

```sh
ledger undo /absolute/path/to/your/vault <txnId>          # revert one transaction (git revert + journal update)
ledger undo /absolute/path/to/your/vault session:<sessionId>  # revert every applied transaction for a session
```

`ledger log /absolute/path/to/your/vault` lists transactions (with `--entity`
/ `--session` / `--limit` filters) if you need to find a `<txnId>` to undo.

## The review surface (v0.2)

v0.2 adds a **"what does my agent believe?"** surface: a local HTTP bridge and
an Obsidian plugin that shows the approval queue with diffs, recent agent
activity with one-click undo, provenance on hover, and a staleness list — so you
can audit agent memory like a bank statement.

**1. Start the bridge**

```sh
ledger serve /absolute/path/to/your/vault      # add --port N to pin a port
```

`ledger serve` runs a small localhost (`127.0.0.1`-only) HTTP server over the
same governed core, and publishes a runtime discovery file to the OS
app-support dir (**never** into the synced vault): `<app-support>/<vaultId>/
bridge.json` = `{ port, token, pid, startedAt }`, written `0600`. The bearer
token in that file is what authorizes the plugin; it never rides along with
Obsidian Sync / iCloud / Git. Starting `serve` again reuses the token by
default; `--rotate-token` mints a fresh one (revoking the old). It's safe to run
`serve` **while an agent works** through the MCP server — a cross-process lock
(plus WAL) serializes every vault mutation, so the two never corrupt the Git
index.

**2. Install the plugin**

```sh
ledger setup /absolute/path/to/your/vault --install-plugin
```

Builds happen as part of `pnpm bootstrap`; `--install-plugin` copies
`manifest.json` + `main.js` into `<vault>/.obsidian/plugins/vaultledger/`.
Copying doesn't activate it — finish in Obsidian: **Settings → Community
plugins** → turn off Restricted mode if it's on → enable **VaultLedger**.
(Building the plugin manually is still `pnpm -C packages/obsidian-plugin
build`; see [`packages/obsidian-plugin/SMOKE.md`](packages/obsidian-plugin/SMOKE.md)
for the manual verification checklist.)

**3. Use it**

With the bridge running, the plugin auto-discovers it (reads `vaultId` from the
synced-safe `.ledger/config.json`, then the token from app-support). Open the
**Approval Queue** view to see pending trusted-zone edits with rendered diffs and
Approve/Reject buttons; open **Agent Activity** to see recent transactions grouped
by session with Undo; hover any note carrying `ledger:` frontmatter to see its
provenance (source / reason / date / status). The **Conflicts** tab lists
detected contradictions (v0.3a) with Resolve/Dismiss. Every mutation still goes
through the broker — the plugin is a pure client and writes nothing directly.

## Contradiction detection (v0.3a)

VaultLedger stops just governing writes and starts **protecting truth**: when an
agent writes a claim that contradicts an existing belief on the same entity, the
contradiction is surfaced for human resolution instead of letting memory silently
drift. It runs write-time (on `remember`/`revise`), is **non-blocking** (never
fails the write) and **precision-first** — a deterministic, lineage-aware
heuristic that only flags high-confidence contradictions (a differing value for
the same attribute, or a narrow negation flip) between two *live* memories on the
same entity, and never between a memory and the one it supersedes. It's a
"favor precision over recall" design: a noisy conflict queue is useless, so when
a value can't be canonicalized with confidence it is **not** flagged.

**Two preconditions** for a flag (both are precision-first by design, so it's
worth stating them explicitly):

1. **Facts are `key: value` lines.** The extractor reads declared facts like
   `deadline: 2026-08-15` — a bare prose sentence (`the deadline is Q4`) is *not*
   parsed as a fact, so two prose notes never conflict.
2. **At least one side is a *live* belief** (`working` or `canonical`). Detection
   protects *established* truth from new drift; two brand-new `scratch` claims are
   deliberately not compared (both are still provisional).

Minimal reproduction (via the MCP tools):

```text
1. memory_remember { "content": "deadline: 2026-08-15", "entity": "nova", "reason": "..." }   → scratch memory A
2. memory_promote  { "id": "<A>", "target_status": "working", "reason": "..." }               → A is now live (scratch→working is immediate, no approval)
3. memory_remember { "content": "deadline: 2026-09-01", "entity": "nova", "reason": "..." }   → contradiction queued
4. ledger conflicts /path/to/vault                                                            → deadline: "2026-08-15" vs "2026-09-01"
```

Detected conflicts land in a queue, surfaced three ways:

```sh
ledger conflicts /path/to/vault                 # list open conflicts (entity, kind, detail, both memories)
ledger conflicts /path/to/vault resolve <id>    # close a conflict you've handled
ledger conflicts /path/to/vault dismiss <id>    # dismiss a false positive (permanent — never resurfaces)
ledger conflicts /path/to/vault --rescan        # re-run detection across the vault
```

Also via the bridge (`GET /conflicts`, `POST /conflicts/:id/{resolve,dismiss}`)
and the plugin's **Conflicts** tab. Resolving/dismissing just closes the item —
you make any actual memory edits through the normal broker ops. Conflicts
referencing a memory that's later undone/forgotten drop off the queue
automatically. Embedding/LLM-assisted detection is a later milestone; the
`ContradictionDetector` interface is the drop-in seam.

## Architecture (v0.1 + v0.2 + v0.3a)

- [`packages/core`](packages/core) — the broker: zone resolution, patch-level
  edits with hash checks, the SQLite journal + reindex/reconcile, the memory
  store (remember/revise/promote/forget), recall, the TTL sweep, the approval
  queue, and undo (`git revert` + journal compensation). Everything else is a
  thin adapter over this package.
- [`packages/cli`](packages/cli) — the `ledger` bin: `init`, `status`, `log`,
  `reindex`, `approve`, `undo`, `serve`, `conflicts`, each a thin wrapper over a
  testable command function in `packages/cli/src/commands/`.
- **Contradiction engine (v0.3a)** — `packages/core/src/contradiction/`
  (extract → detect → match → check) + the `conflicts/` queue: a precision-first,
  lineage-aware, pluggable detector run non-blocking on every write.
- [`packages/mcp-server`](packages/mcp-server) — the `vaultledger-mcp` bin: the
  9 MCP tools listed above, wired over stdio via the official MCP SDK.
- [`packages/server`](packages/server) — **(v0.2)** the fastify bridge behind
  `ledger serve`: token-authed, loopback-only HTTP over the core, the plugin's
  only backend.
- [`packages/obsidian-plugin`](packages/obsidian-plugin) — **(v0.2)** the review
  surface: a thin HTTP client (`BridgeClient`) + XSS-safe DOM rendering + the
  Obsidian views/hover.

Concurrency (v0.2): `core` gained a WAL journal and a cross-process mutation lock
(`vault.lock` in app-support) that every mutating entry point — the broker's
writes, `undo`, and thus the CLI, MCP server, and bridge — acquires, so `ledger
serve` and `vaultledger-mcp` are safe against one vault at once.

For the full designs, see
[`docs/design/specs/`](docs/design/specs/) (v0.1: `2026-07-02-*`; v0.2:
`2026-07-03-*`; v0.3a: `2026-07-05-*`).

## Stack

TypeScript throughout (Node MCP server + write broker; Obsidian plugin; SQLite
index).

## Status & roadmap

- **v0.1** — core broker + MCP server + CLI (approve/undo). Prove the loop. ✅
- **v0.2** — `ledger serve` bridge + Obsidian review plugin (approval queue,
  activity/undo, provenance hover, staleness); concurrency-safe. ✅
- **v0.3a** — write-time contradiction detection + conflicts queue (CLI / bridge /
  plugin); reindex/reconcile hardening. ✅
- **v0.3b** — the Undertow merge: `memory_distill`/`memory_retire`, source
  relations, source-linked staleness, promotion rules, memory-health report. ✅
- **v0.4** — onboarding & setup: `ledger setup` (interactive zone review,
  Claude Code MCP config emit/merge, a real-subprocess smoke check, opt-in
  `--install-plugin`), `pnpm bootstrap`, [`docs/GETTING_STARTED.md`](docs/GETTING_STARTED.md).
  In progress.
- **v1.0** — polish, packaged installers, community-plugin submission, guides.

## License

MIT
