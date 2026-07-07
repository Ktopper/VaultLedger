# VaultLedger

**Git for agent beliefs** — a governed memory broker that lets any AI agent use
an Obsidian vault (or any markdown folder) as persistent memory, with
provenance, approval, and rollback enforced *in code, not prompts*.

> **Status:** v0.1 in development. This is the deterministic write-broker core —
> the layer every agent write must pass through. See [`spec.md`](spec.md) for the
> product spec and [`docs/design/specs/`](docs/design/specs/) for the
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

## 2-minute walkthrough (v0.1)

This walks through the exact commands and tool calls that make up the v0.1
governed-write loop: init a vault, wire an agent to it over MCP, remember and
recall a fact, check status, approve a queued edit, and undo a transaction.
(This is also, almost verbatim, what `packages/mcp-server/test/v01-gate.e2e.test.ts`
asserts end-to-end — the "2-minute walkthrough" and the release gate are the
same loop.)

**1. Install and build**

```sh
corepack enable pnpm
pnpm install
pnpm build
```

This builds `@vaultledger/core`, `@vaultledger/cli` (the `ledger` bin), and
`@vaultledger/mcp-server` (the `vaultledger-mcp` bin) via `tsc --build`.

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

**3. Wire an agent to it over MCP**

Point an MCP-capable client at the built server binary, passing the vault as
`--vault`. See [`packages/mcp-server/examples/mcp.json`](packages/mcp-server/examples/mcp.json):

```json
{
  "mcpServers": {
    "vaultledger": { "command": "vaultledger-mcp", "args": ["--vault", "/absolute/path/to/your/vault"] }
  }
}
```

`vaultledger-mcp` resolves to `packages/mcp-server/dist/index.js` (its `bin`
entry) once the package is installed/linked; if you're running straight out
of this repo without a global link, point `command` at
`node` and `args` at `["<repo>/packages/mcp-server/dist/index.js", "--vault", "..."]`
instead. The server exposes 7 tools: `memory_recall`, `memory_remember`,
`memory_revise`, `memory_promote`, `memory_forget`, `vault_propose_edit`, and
`ledger_status`.

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
pnpm -C packages/obsidian-plugin build         # produces main.js
```

Copy `packages/obsidian-plugin/manifest.json` and `main.js` into
`<vault>/.obsidian/plugins/vaultledger/`, then enable **VaultLedger** in
Obsidian's Community Plugins settings. (See
[`packages/obsidian-plugin/SMOKE.md`](packages/obsidian-plugin/SMOKE.md) for the
manual verification checklist.)

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
  7 MCP tools listed above, wired over stdio via the official MCP SDK.
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
  relations, source-linked staleness, promotion rules, memory-health report.
- **v1.0** — polish, packaged installers, community-plugin submission, guides.

## License

MIT
