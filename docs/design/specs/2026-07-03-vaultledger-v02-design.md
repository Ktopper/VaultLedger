# VaultLedger v0.2 — Design (the Obsidian review surface)

**Date:** 2026-07-03
**Scope:** Milestone v0.2 ("the demo that sells") — build-prompts Prompt 9.
**Parent spec:** `spec.md` §2/§8, and the v0.1 design
(`docs/design/specs/2026-07-02-vaultledger-v01-design.md`). Where this doc is
silent, those govern.
**Builds on:** the hardened v0.1 core (trust-boundary security fixes:
containment, symlink realpath, `.ledger`/`.git` always-excluded, case-insensitive
zones). v0.2 branches off that tip.

---

## 1. Goal & scope

Turn invisible agent memory into something you can audit like a bank statement:
an Obsidian plugin — the "what does my agent believe?" surface — backed by a
local HTTP bridge over the v0.1 core.

**In scope:**
- A `ledger serve` **HTTP bridge** (`packages/server`, fastify) exposing core's
  read + approve/undo APIs on loopback, token-authed.
- The **Obsidian plugin** (`packages/obsidian-plugin`, was a stub): approval
  queue with rendered diffs + approve/reject; agent-activity view (recent
  transactions by session) with undo; provenance hover; a **staleness** list.
- A **cross-process safety** layer (mutation lock + WAL) so `serve` and the MCP
  server can run against the same vault concurrently — which is the primary use
  case (watch approvals *while an agent works*).
- `openVault(vaultRoot, opts)` factory extracted into `core` (DRY; the server is
  the third consumer of the stack-wiring after cli/mcp).

**Out of scope (deferred):**
- **Conflicts** population — contradiction detection is v0.3; the `conflicts`
  table stays empty, so the plugin shows a Conflicts tab that is empty in v0.2.
- Refactoring `cli`/`mcp-server` to adopt `openVault` — optional follow-up; not
  churned this cycle.
- Any semantic/embedding features.

---

## 2. Architecture

```
packages/
├── core/            # v0.1 engine + NEW openVault() + NEW cross-process lock + WAL journal
├── server/          # NEW — fastify bridge over core; the plugin's only backend
├── cli/             # + NEW `ledger serve <vault>` (starts the bridge)
├── mcp-server/      # unchanged, except it now acquires the shared mutation lock
└── obsidian-plugin/ # NEW real plugin — BridgeClient + views (was STUB)
```

**Data flow:** Obsidian plugin (client, in the vault's Electron process) → HTTP
over `127.0.0.1` → `packages/server` (fastify) → `@vaultledger/core` → vault +
Git + journal. The plugin never touches files or the journal directly; **every
mutation goes through the broker**, per the standing instructions.

**`openVault(vaultRoot, { now, genId, env, sweep? })`** (new, in `core`) — the
single stack-wiring factory: read config + permissions, open the journal (WAL,
see §3), `ensureJournal` + `reconcile`, build `LedgerGit`/`Broker`/`MemoryStore`/
`Approvals`, return a `VaultContext` (incl. `db`, `session`, and the mutation
lock handle). Used by the server now; cli/mcp keep their existing wiring this
cycle (documented follow-up).

---

## 3. Concurrency: two-process safety (the load-bearing addition)

v0.2 **creates** a two-process scenario: the demo is watching the approval queue
in Obsidian (`ledger serve`) *while an agent mutates the vault* (the MCP server).
Both hold a `Broker` over the same vault, **Git repo**, and journal. Unmanaged,
this races Git's index (→ corrupt index / failed commits) and violates the v0.1
single-writer assumption. v0.2 must make concurrent processes safe.

**Cross-process mutation lock.** A single advisory lock guards every vault
mutation. It lives in the app-support dir (never in the vault):
`<app-support>/<vaultId>/vault.lock`. **Every entry point** — the broker's
mutating operations (`apply` create/revise/propose_edit, `archive`, `undo*`,
`Approvals.approve`) — acquires the lock for the duration of a single
transaction (validate → write → git commit → journal record) and releases it.
Implementation: an O_EXCL-style advisory lockfile with bounded retry + stale
detection (e.g. `proper-lockfile`, pure-JS — no native dep), owned by `core` so
cli, mcp-server, and server all inherit it via the shared broker path. The
in-process `LedgerGit` promise-mutex (v0.1) still serializes within a process;
this lock adds *cross*-process serialization.

**Lock lifetime is per-transaction**, not process-held: acquired at the start of
a single mutating transaction and released in its `finally`. A crashed process
leaves a stale lockfile that the retry/stale-detection reclaims. Process shutdown
(§5) only needs to release a lock that happens to be held by an **in-flight**
transaction at signal time.

**`Approvals` funnels through the broker, not a second lock site.**
`Approvals.approve` does not acquire the lock itself — it re-runs the held op via
`Broker.apply(op, {approved:true})` (for revise/propose_edit) or, for a canonical
promote, via `MemoryStore.setStatus` which itself routes through a broker
`revise`; both paths acquire the lock at the broker's mutating boundary.
`Approvals.reject` performs no vault mutation (journal-only) and needs no lock. So
"every entry point" reduces to a single mechanical guarantee: **the lock wraps
the broker's mutating operations (and `undo*`)**, and everything else reaches
mutation through them.

**Lock staleness must exceed the slowest transaction.** A transaction holds the
lock across a Git commit, which can be slow (first commit on a large vault, cold
disk). If stale-detection fires shorter than a slow commit, a second process
reclaims the lock **mid-transaction** — the exact corruption the lock exists to
prevent. `proper-lockfile` refreshes the lock's mtime on an `update` interval;
the config MUST keep `update` comfortably below `stale` (e.g. `update: 2000`,
`stale: 20000`) so an active holder is never seen as stale. This is asserted in
the lock config and covered by a test with an **artificially slow commit**
(inject a delay into the git step) proving a second acquirer waits rather than
stealing the lock.

**Journal in WAL.** `openJournal` sets `PRAGMA journal_mode = WAL` and
`PRAGMA busy_timeout = 5000` so concurrent readers (the plugin polling status)
don't block the writer and a brief contention retries rather than erroring.
(WAL was slated for v1.0; concurrency pulls it forward.)

**Concurrent startup reindex must converge, not duplicate.** Two processes
starting on the same vault (serve + MCP) can both observe an empty journal and
both run `ensureJournal`/`reconcile`. WAL serializes the writes, but the rebuild
must be **idempotent** — memory upserts keyed on `ledger.id`, transaction inserts
skipped when `hasCommit(sha)` — so a double-run converges rather than duplicating
rows. v0.1 `reindex` already upserts + skips-by-commit; v0.2 adds an explicit
test (run reindex twice / concurrently → identical row counts), since v0.2 makes
simultaneous startup routine.

> **Scope note (final-review):** the concurrent-startup test races two
> `openVault` calls in one Node process; that converges reliably (the
> reindex/reconcile insert loops have no `await` in the body, so each runs
> atomically w.r.t. the event loop). The narrower **cross-OS-process** startup
> race (two genuinely separate processes both rebuilding the *same empty*
> journal in the same instant) still relies on the app-level `hasCommit` check
> rather than a `UNIQUE(commit_sha)` DB constraint — a carryover of the v0.1
> `ensureJournal` check-then-act limitation. Worst case is a duplicate
> transaction *index* row (cosmetic; the vault + Git remain the source of truth,
> and a later reindex from scratch de-dups), never vault corruption. Promoting
> this to a DB-level `UNIQUE(commit_sha)` + `ON CONFLICT DO NOTHING` is a
> low-risk v0.3 hardening.

**Scope note:** the lock covers vault+Git mutations. Pure reads (recall, status)
take the journal in WAL without the mutation lock. Test: a two-process test in
the server suite spawns a competing writer and asserts serialized, non-corrupt
commits (no failed/interleaved Git index).

---

## 4. The bridge HTTP API (`packages/server`)

A tiny read-mostly JSON API, all requests bearer-token-authed (§5), bound to
loopback.

| Method | Route | → core |
|---|---|---|
| GET | `/status` | zones, mode, pending/txn counts |
| GET | `/approvals` | pending approvals, each with a server-rendered diff |
| GET | `/transactions?session=&entity=&limit=` | journal history |
| GET | `/memories?entity=&status=&tag=` | recall results w/ provenance |
| GET | `/staleness` | working memories flagged stale (TTL sweep `findStale`) |
| GET | `/conflicts` | empty in v0.2 (v0.3 populates) |
| GET | `/provenance?path=` | one note's `ledger:` frontmatter (for hover) — **zone-checked, see below** |
| POST | `/approvals/:id/approve` | `Approvals.approve` → applied \| stale |
| POST | `/approvals/:id/reject` | `Approvals.reject` |
| POST | `/undo` `{ target }` | `undoTransaction` \| `undoSession` (`session:<id>`) |

**Error mapping.** Every handler maps `BrokerError` → `{ error: { code, message,
retriable } }` with an HTTP status: `FORBIDDEN_ZONE` → 403, `NOT_FOUND` → 404,
`STALE_HASH`/`REVERT_CONFLICT`/`ALREADY_REVERTED` → 409, `INVALID_TRANSITION` →
422, validation error → 400. Never a raw stack. Diffs are rendered **server-side**
(reuse the CLI's diff renderer) and returned as plain strings.

**`/provenance?path=` runs zone resolution (security).** It reads a note's
frontmatter by caller-supplied path — so it MUST NOT leak excluded-zone content.
It resolves the zone (with the v0.1 realpath/case-fold containment: `.ledger`/
`.git` and `excluded` globs, symlink-checked) and returns **403 FORBIDDEN_ZONE**
for excluded/escaping paths — the same containment the broker enforces on writes.
Test: `/provenance?path=Private/secret.md` (excluded) → 403; a `..`/symlink path
→ 403.

---

## 5. Server security & lifecycle

**`ledger serve <vault> [--port N] [--rotate-token]`** → `openVault` + start
fastify on `127.0.0.1:<port>` (0 = OS-assigned free port, the default).

**Runtime discovery file — NOT in the vault.** On serve start, write
`<app-support>/<vaultId>/bridge.json` = `{ port, token, pid, startedAt }`,
**written with mode `0o600`** (owner read/write only) — it holds a token granting
approve/undo and must not be group/world-readable even within app-support.
- **Why not `.ledger/config.json`:** `.ledger/` **syncs** with the vault (iCloud /
  Obsidian Sync) and is committed if the vault is a Git repo. A bearer token that
  grants approve/undo must never ride along. `.ledger/config.json` keeps only the
  synced-safe `vaultId` (+ v0.1 config); the **token lives only in app-support**,
  which never syncs.
- **Plugin discovery:** the plugin reads `vaultId` from the vault's
  `.ledger/config.json` (safe to sync), computes the OS app-support path (same
  resolver as `core`'s `journalPath`), and reads `bridge.json` for the live
  `{port, token}`. This also **solves port discovery** — no "print the port"
  guesswork. Obsidian plugins are desktop Electron with Node `fs`, so this works.
- **Pid-aware token lifecycle** (so `--rotate-token` is meaningful, not inert):
  on start, `serve` reads any existing `bridge.json`. If it names a **live** pid
  → refuse to start (a bridge is already running for this vault). If it names a
  **dead** pid → **reuse** its token by default (a client that already read it
  keeps working across a restart); `--rotate-token` mints a **fresh** token to
  deliberately revoke the old one. No file → mint fresh. `close()` only unlinks
  `bridge.json` if it still describes *this* instance (pid+port match), so a late
  shutdown can't delete a newer server's live file. The file is written
  atomically (temp file created `0o600`, then renamed) so a token is never
  briefly world-readable.

**Auth + origin guard.** Every request requires `Authorization: Bearer <token>`;
missing/wrong → **401**. Reject requests whose `Host`/`Origin` header isn't
loopback (defense against DNS-rebind from a browser reaching the local port).

**Lifecycle.** TTL sweep runs once at serve start (long-running session, per v0.1
§6), stderr-summarized. SIGINT/SIGTERM → release the mutation lock, close the
journal handle, remove `bridge.json`, exit. On startup, if a stale `bridge.json`
names a dead `pid`, overwrite it.

---

## 6. Obsidian plugin (`packages/obsidian-plugin`)

Thin client over the bridge, following kepano/obsidian-skills conventions. `no
writes except through the bridge`.

**Units:**
- **`BridgeClient`** — typed `fetch` wrapper. Resolves `{port, token}` via the
  discovery file (§5), sets the bearer header, maps non-2xx `{error}` bodies to
  typed results. Pure, unit-testable against a running/injected server.
- **Approval Queue view** (sidebar `ItemView`) — pending approvals, each with its
  rendered diff and Approve/Reject buttons; stale items visibly flagged; refresh
  on interval + on demand.
- **Agent Activity view** (`ItemView`) — recent transactions grouped by session,
  each with Undo (single) and undo-session buttons.
- **Provenance hover** — for a note carrying `ledger:` frontmatter, a hover
  popover: source / reason / date / status / confidence (via `/provenance`).
- **Staleness list** — filterable list of flagged working memories. **Conflicts**
  tab present but empty (v0.3).
- `manifest.json` + esbuild bundle; `main.js` entry.

**Rendering is XSS-safe by construction (security).** Diff bodies and note
frontmatter contain **arbitrary note content**, and the plugin runs in Electron
(XSS → RCE). The pure render helpers (diff → DOM, provenance → DOM, group-by-
session) build DOM via `document.createElement` + `textContent` / `createSpan` /
`createDiv` **only — never `innerHTML`/`insertAdjacentHTML`**. This is enforced
by a unit test with a hostile fixture (a diff containing `<img src=x
onerror=...>` and `<script>`), asserting the produced nodes are inert text, not
parsed elements. It is a test, not a convention.

---

## 7. Testing

- **`packages/server` — full TDD.** Spin the fastify app over a temp vault + real
  core (fastify `inject`), exercising: every GET shape; auth (401 on missing/bad
  token); origin guard (non-loopback Host → rejected); error mapping (403/404/
  409/422); approve (applied + stale), reject, undo (ok + REVERT_CONFLICT); the
  `/provenance` zone check (403 on excluded/traversal); and the **two-process**
  test (concurrent writer → serialized, non-corrupt commits).
- **`core` `openVault` + lock + WAL** — unit tests: opens/wires/auto-heals;
  mutation lock serializes two in-process acquirers; WAL pragmas set.
- **`packages/obsidian-plugin`** — unit-test `BridgeClient` (against an injected
  server) and the **pure render helpers incl. the hostile-diff XSS test**. The
  Obsidian-API glue (`ItemView`/hover registration) gets a **documented manual
  smoke checklist** (lives at `packages/obsidian-plugin/SMOKE.md`), not automated
  tests (no headless Obsidian).
- **Gate:** `pnpm build && pnpm lint && pnpm test` stays green; v0.2 work is
  additive. A short README section documents `ledger serve` + installing the
  plugin (copy `manifest.json`+`main.js` into `<vault>/.obsidian/plugins/`).

---

## 8. Deferred to later milestones

- Conflicts population + the contradiction engine (v0.3).
- cli/mcp adopting `openVault` (cleanup follow-up).
- **v0.3 hardening backlog (from the v0.2 final review — all low-severity):**
  - `UNIQUE(commit_sha)` + `ON CONFLICT DO NOTHING` on `transactions`, to make the
    cross-process empty-journal reindex race converge at the DB level (§3 note).
  - Approval-vs-transaction reconcile cross-check: the approve→apply crash gap can
    leave an approval `pending` after its write already landed; `reconcile` should
    detect an applied op whose approval is still pending and resolve it.
  - An explicit `bodyLimit` on `POST /undo` (and mutation routes) for
    defense-in-depth against oversized request bodies.
- Multi-vault serve, packaged Obsidian community-plugin submission, auto-start of
  `serve` from the plugin, richer diff UI (v1.0).
- TOCTOU/symlink-race hardening and the byte-identical-outside-hunks lint (carried
  from v0.1 §12).
