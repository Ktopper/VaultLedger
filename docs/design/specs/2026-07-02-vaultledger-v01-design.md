# VaultLedger v0.1 — Design (the governed-write loop)

**Date:** 2026-07-02
**Scope:** Milestone v0.1 ("prove the loop") — build-prompts 1–8.
**Parent spec:** `spec.md` (Spec v1, 2026-07-02). This document resolves the
implementation ambiguities the build-prompts leave open; where it is silent,
`spec.md` governs.
**Out of scope this cycle:** Obsidian plugin (v0.2, stub only), contradiction
detection (v0.3), hardening/release (v1.0).

---

## 1. Goal & success criteria

Prove the core thesis end-to-end: **every agent write to a vault goes through a
deterministic broker** that validates zone, verifies hash, applies patch-level
edits only, stamps provenance, commits to Git, and journals the transaction —
with human approval for trusted zones and one-command rollback.

v0.1 is done when the Prompt 8 e2e scenario passes:

1. `ledger init` on a fixture vault with existing notes writes nothing into user
   folders (only `.ledger/`).
2. MCP session A: `remember` 3 facts, `propose_edit` 1 trusted-zone note.
3. Assert: the trusted edit is **queued, not applied**; the 3 memories carry
   provenance frontmatter; Git has **one commit per applied transaction**.
4. A fresh MCP session B: `recall` returns session A's memories with provenance.
5. `ledger undo` of one transaction restores the prior file bytes **exactly**
   AND the journal no longer reports that memory as live.
6. A write to an excluded path → clean, machine-readable rejection.

Plus the spec §9 bar: a non-developer can point it at an existing vault and have
Claude Code remembering across sessions with zero existing notes modified.

---

## 2. Monorepo layout & tooling

```
vaultledger/
├── pnpm-workspace.yaml
├── package.json              # root scripts: build, test, lint, typecheck
├── tsconfig.base.json        # strict, ESM, composite project references
├── eslint.config.js
├── vitest.config.ts          # projects per package
├── CLAUDE.md                 # standing instructions (from build-prompts)
└── packages/
    ├── core/                 # the engine — everything real lives here
    ├── mcp-server/           # @modelcontextprotocol/sdk stdio server (thin)
    ├── cli/                  # commander (thin)
    └── obsidian-plugin/      # STUB ONLY — compiles + one placeholder test
```

- **Language:** TypeScript strict, ESM. Project references so `core` builds once
  and `cli`/`mcp-server` consume its types and compiled output.
- **Dependencies:** `zod` (schemas), `better-sqlite3` (journal), `simple-git`
  (Git transactions), `picomatch` (zone globs), `gray-matter` (frontmatter),
  `diff` (unified-diff parse/apply), `commander` (CLI),
  `@modelcontextprotocol/sdk` (MCP), `vitest` (tests).
- **pnpm** via `corepack enable pnpm` (Node 22 ships corepack; pnpm not
  otherwise installed).
- **Architecture rule:** `cli` and `mcp-server` contain no business logic — they
  are adapters that validate input with `core`'s zod schemas and call `core`
  APIs. All broker/memory/journal/scanner logic is in `core` and unit-tested
  there.

---

## 3. State separation & data model

### 3.1 Where state lives

Per spec §6, the **only in-vault footprint** is `.ledger/`:

- `.ledger/permissions.yaml` — the zones manifest (§4).
- `.ledger/config.json` — holds a **generated vault ID** (a random stable
  identifier, minted once at `init`) plus config (TTL, patch-size threshold,
  mode).

The **SQLite journal/index lives outside the vault**, in the OS app-support dir,
in a subdirectory **keyed by the generated vault ID from `config.json`** — NOT
by a hash of the vault's absolute path.

> **Rationale (review fix #1):** a path hash breaks the moment the vault moves
> or is opened at a different absolute path on a second machine — exactly the
> sync scenario the state separation exists to survive. The vault ID travels
> inside `.ledger/config.json` (which syncs with the vault), so any machine
> resolves the same journal directory. App-support base resolved
> cross-platform (`~/Library/Application Support/VaultLedger` on macOS;
> `env.XDG_DATA_HOME`/`~/.local/share` on Linux; `%APPDATA%` on Windows).

### 3.2 SQLite tables (v0.1)

- **`transactions`** — `id`, `op`, `path`, `hash_before` (nullable for create),
  `hash_after` (nullable for forget/tombstone), `session`, `reason`,
  `memory_id`, `commit_sha`, `created_at`, `status` (`applied` | `reverted`).
  A revert is itself recorded as a transaction row of `op = 'revert'` (referencing
  the undone txn/session) whose own `status` is `applied`; the transaction it
  undoes is flipped to `status = reverted`.
- **`memories`** — `id`, `path`, `entity`, `status`
  (`scratch` | `working` | `canonical` | `forgotten` | `reverted`),
  `confidence`, `created`, `source`, `supersedes`, `expires`,
  `last_referenced`.
- **`memory_tags`** — `memory_id`, `tag` (join table).
  > **Review fix #6:** `recall` filters by tag per spec §7, so tags need a
  > queryable home; a join table keeps a memory's multiple tags normalized.
- **`approvals`** — `id`, `held_operation` (JSON blob of the ProposedOperation),
  `zone`, `reason`, `session`, `state`
  (`pending` | `approved` | `rejected` | `stale`), `created_at`, `resolved_at`.
- **`conflicts`** — schema created but unpopulated in v0.1 (v0.3 fills it).

The journal is the **index for `recall`**: structured queries by entity, tag,
status, recency, and limit. No embeddings in v0.1.

### 3.3 The journal is a disposable index — rebuildable from the vault

> **Review fix (main):** the journal directory is resolved by vault ID (§3.1) so
> machine B finds the *right* directory — but the journal itself does **not**
> sync, so on a second machine (or after deleting the journal) that directory is
> empty and `recall` would return nothing even though the vault carries every
> memory. This is cheap to fix because the source of truth already lives in
> synced artifacts: **provenance frontmatter** lives in the agent-zone notes and
> **transaction history** lives in Git.
>
> Provide **`ledger reindex`**, which rebuilds the journal from the vault:
> - walk the agent zone, parse each note's `ledger:` frontmatter → rebuild the
>   `memories` and `memory_tags` rows;
> - walk `ledger:` commits in Git history → rebuild the `transactions` rows.
>
> Reindex **auto-triggers** when a known vault ID (present in
> `.ledger/config.json`) resolves to a **missing or empty** journal — so machine
> B self-heals on first use with no user action. This also formalizes the
> architecture: **the vault + Git are the source of truth; the SQLite journal is
> a disposable performance index.** Covered by a test that deletes the journal
> and asserts `recall` returns the same memories after auto-reindex.

### 3.4 Startup reconcile (crash safety)

> **Review fix #5:** there is a crash gap between `gitCommit` and
> `journal.record`. Structured commit messages carry the txn id, memory id, and
> session. On broker/CLI/server startup, a cheap reconcile scans recent
> `ledger:` commits and detects any commit with **no matching journal row**,
> then repairs the journal from the commit metadata (or flags it if
> unrepairable). Acceptable-for-v0.1 insurance; pairs naturally with WAL in
> v1.0.

---

## 4. Schemas, permissions & zone resolution (Prompt 2)

### 4.1 ProposedOperation

Agents emit structured operations, never raw writes. Because `remember` and
`forget` are not patch-over-existing-file operations, the schema is a
**discriminated union on `op`**, not one shape with optional fields:

> **Review fix #2:** create/move ops don't fit the patch pipeline — there is no
> `expected_hash` and no diff, so the rewrite guard and hashCheck can't apply.
> Each op variant carries exactly the fields its validation path needs.

- **`create`** (backs `remember`): `path`, `content` (full initial body incl.
  provenance frontmatter), `reason`, `session`, `entity?`, `tags?`.
  Validation: `expected_hash` MUST be null/absent; **target must not exist**;
  path must resolve to the agent (or scratch) zone.
- **`revise`**: `path`, `expected_hash` (required), `patch` (unified diff),
  `reason`, `session`, `entity?`. Validation: hashCheck + patch-size guard +
  markdownLint.
- **`propose_edit`** (trusted zone): same shape as `revise` but zone resolves to
  trusted → **always** produces an approval item, never applied inline. See §6.2
  for how an *approved* one is subsequently executed (it does not re-enter the
  queue gate).
- **`promote`**: `id` (memory id), `target_status`, `reason`, `session`.
- **`forget`**: `id`, `reason`, `session`. Applied as a **move** to
  `Agent/Archive/` plus a status/frontmatter flip to `forgotten` — its own
  validation path (source must exist; destination computed; no diff), never a
  hard delete.

### 4.2 MemoryProvenance frontmatter (spec §5.2)

zod schema for the `ledger:` frontmatter block: `id`, `status`, `created`,
`source`, `reason`, `confidence`, `supersedes` (nullable), `expires`
(nullable). Round-trips through `gray-matter` without disturbing the rest of the
note.

### 4.3 PermissionsManifest (spec §5.1)

Zones as glob lists: `trusted`, `agent`, `scratch`, `excluded`. `mode`:
`safe` | `assisted` | `autonomous` (default `assisted`). Per-folder overrides.

### 4.4 resolveZone(path, manifest)

`picomatch` glob matching. **Excluded always wins.** Otherwise most-specific
match (longest/most-segment glob) wins; per-folder overrides beat base zone
globs. **A path matching no glob falls back to `trusted`** — the safe default,
since trusted writes require approval and cannot be silently applied (this
matters because `resolveZone` is unit-tested independently of the scanner's
`**`→trusted catch-all). Ties and overlaps are deterministic and covered by unit
tests (a path matching both a `trusted` and an `agent` glob, an `excluded` glob
overlapping an `agent` glob, nested overrides, unmatched paths, etc.).

---

## 5. Broker pipeline (Prompt 3)

Each stage returns a typed result; any failure short-circuits to a clean
rejection `{ code, message, retriable }`. The agent can react to the code.

**revise / propose_edit path:**
`validate(op, manifest)` → `hashCheck(file, expected_hash)` →
`applyPatch` (patch-level only; **reject if > threshold % of lines changed** —
whole-file-rewrite guard, threshold configurable, default ~50%) →
`markdownLint` (v0.1 heuristic — see below) →
`gitCommit` (structured message) → `journal.record`.

**`markdownLint` — what v0.1 actually enforces.** The ideal is "structural tokens
(wikilinks, frontmatter, callouts, block refs) outside the changed hunks are
byte-identical." v0.1 does NOT compute hunk ranges; it uses a deterministic
*count* heuristic over the whole before/after: the frontmatter block must still
parse as a closed YAML block, and the counts of wikilinks, callout headers, and
block refs must not decrease. This is a conservative approximation with two known
edges: it **rejects** an edit that legitimately removes a link/callout, and it
does **not** catch a structural edit made *inside* a hunk. Tightening to the true
byte-identical-outside-hunks check (which requires threading the patch's hunk
ranges into the linter) is deferred to a later milestone (§12).

**create path (remember):** `validate` (zone + target-absent) → write file →
`gitCommit` → `journal.record`. No hashCheck/patch guard.

**forget path:** `validate` (source exists) → move to `Agent/Archive/` + flip
frontmatter → `gitCommit` → `journal.record`.

**Trust-boundary hardening (all enforced in code in v0.1 — the write path ships
now, so the boundary is defended now, not deferred to a v1.0 "security pass"):**
- **Path containment.** Every filesystem access resolves the op path against
  `vaultRoot` and rejects (`FORBIDDEN_ZONE`) unless the resolved absolute path
  stays under the vault root — a `..` traversal can never read/write/delete
  outside the vault, even on the approved-execution path.
- **Symlink containment.** Containment is also checked against the *canonical*
  (realpath-resolved) nearest existing ancestor of the target, so a symlink
  planted inside the vault (e.g. `Agent/evil → /etc`) cannot be used to escape;
  legitimate not-yet-existing nested creates still work.
- **`.ledger/` and `.git/` are always excluded**, hard-coded in `resolveZone`
  (not just scanner defaults and not overridable by any manifest) — an agent can
  never `propose_edit` its own security policy (`.ledger/permissions.yaml`) or
  git internals.
- **Case-insensitive zone matching.** Zone globs match with `nocase`, so on a
  case-insensitive filesystem (macOS/APFS, Windows/NTFS) `private/secret.md`
  cannot dodge an excluded `Private/**` glob.

Remaining hardening for a later milestone (§12): TOCTOU between check and write,
symlink races, and patch-bomb size ceilings beyond the current patch-size guard.

### 5.1 Rejection codes

`FORBIDDEN_ZONE` (also covers a path escaping the vault root), `STALE_HASH`,
`PATCH_TOO_LARGE`, `SYNTAX_BREAK`, `NOT_FOUND`, `TARGET_EXISTS` (create onto an
existing path), `APPROVAL_REQUIRED`, `REVERT_CONFLICT` (undo cannot cleanly
revert — see §5.3), `ALREADY_REVERTED` (undo of a transaction already reverted).

### 5.2 Git identity

> **Review nit #7:** ledger commits use a dedicated author,
> `VaultLedger <ledger@local>`, so agent transactions are distinguishable from
> the user's own commits in `git log`. Commit message format:
> `ledger: <op> <basename> [<memory_id>] <session>`.

### 5.3 Undo (with journal compensation)

`undoTransaction(txnId)` / `undoSession(sessionId)` do a `git revert`, **and**:

> **Review fix #3:** `git revert` fixes files but the `memories`/`transactions`
> rows still describe the pre-revert world. Undo MUST also compensate the
> journal: set the original transaction `status = reverted`, and record the
> revert as its **own** `op = 'revert'` transaction row.
>
> **Memory-status compensation (final-review fix): re-derive from the file, do
> not blind-set `reverted`.** After the revert, the memory's journal status is
> re-derived from the source of truth — the file (§6.0):
> - if the note no longer exists at HEAD (an originating `create` was reverted)
>   → mark the memory `reverted` so `recall` stops returning a belief whose file
>   is gone;
> - if the note still exists (a content `revise` or a `promote` status-flip was
>   reverted) → set the memory row to the status now in the note's `ledger:`
>   frontmatter (git already restored it), keeping a still-true belief **live in
>   recall**.
>
> Blindly marking the memory `reverted` on *any* linked transaction was a bug:
> undoing a routine content edit made a live, correct memory silently vanish
> from `recall` — the exact failure the product exists to prevent, in the
> opposite direction. This is covered by an explicit test (undo a revise →
> `recall` still returns the memory) alongside the create-undo e2e assertion
> (success criterion step 5).

**Revert conflicts.** `git revert` of an older transaction can conflict when a
later commit touched the same file. Behavior:

> **Review fix:** a dirty revert **aborts cleanly** (`git revert --abort`, no
> partial working-tree state, no journal mutation) and returns `REVERT_CONFLICT`;
> the target transaction is **flagged for manual resolution** rather than
> force-applied. `undoSession` reverts its commits in **reverse chronological
> order** to minimize conflicts. Covered by a test that mutates a file after a
> transaction, then asserts undo of the earlier transaction returns
> `REVERT_CONFLICT` and leaves the working tree and journal untouched.

---

## 6. Memory store & lifecycle (Prompt 4)

> **Status source-of-truth invariant (WU3b review fix):** a memory's `status`
> lives in both the note's `ledger:` frontmatter and the journal `memories.status`
> row, and `reindex` rebuilds the journal *from the file* (§3.3: vault + Git are
> the source of truth). Therefore **every status transition writes the file's
> frontmatter through the broker**, not just the journal row — otherwise the
> change is silently lost on a journal rebuild. `promote` (scratch→working) and
> approved `promote` (working→canonical) flip `ledger.status` in the note via a
> broker `revise` (audited, committed); `forget` flips it to `forgotten` as part
> of the archive move. The journal row updates in the same operation and stays a
> pure cache of what the files say.

- **`remember()`** → `create` op into the agent zone, provenance frontmatter,
  `status = scratch`.
- **`revise()`** → `revise` op; bumps provenance (`created`/`reason`), links
  `supersedes` to the prior memory id.
- **`promote()`** → `scratch → working` allowed by rule (referenced ≥N times, or
  agent proposes with reason); **`working → canonical` always creates an
  approval item** instead of writing.
- **`forget()`** → `forget` op (tombstone → `Agent/Archive/`,
  `status = forgotten`). Git retains history; never hard-deleted.
- **TTL sweep** → scratch older than config TTL (default 14 days) → archived;
  emit staleness flags for working memories unreferenced for N days. There is no
  daemon in v0.1: the sweep triggers lazily at **MCP-server startup** (a genuine
  long-running session). The **CLI does NOT auto-sweep** — a read-only command
  like `status`/`log` must never silently write commits or move files
  (auditability), so `loadContext` runs only journal-DB repairs
  (`ensureJournal` + `reconcile`), never a vault-mutating sweep. Sweep stays
  available as a core API and can be wired to an explicit command later.
- **Approval queue** → SQLite `approvals` table + core API
  (`list` / `approve` / `reject`). Approving **re-runs the held operation
  through the broker** (does not blind-apply a stored diff) — but through the
  apply path, not the queue gate (§6.2).

### 6.2 How an approved trusted-zone edit is applied

> **Review fix (main issue):** a `propose_edit` is queued precisely *because* its
> zone resolves to trusted. If approval simply re-submitted the same operation,
> the broker's trusted-zone rule would queue it again — an infinite re-queue.
> Resolution: approval re-runs the held op through the broker's **full validation
> and apply stages** (`hashCheck` + patch-size guard + `markdownLint` + `gitCommit`
> + `journal.record`) via an explicit **approved-execution context** that
> **bypasses the trusted-zone queue gate**. The gate is the *only* stage skipped;
> every safety check still runs. This keeps the two required behaviors distinct:
> the first submission is queued-not-applied (e2e step 3), and the approval
> applies with all checks intact (including the stale-hash check in §6.3).

The trusted-zone gate is therefore a single decision point with two entry modes:
default (agent-initiated) → queue; approved-execution → apply-with-full-checks.

### 6.3 Stale approvals

> **Review fix #4:** a held `propose_edit` carries an `expected_hash` that can go
> stale while pending (the user edits the note). On approve, the broker re-runs
> (§6.2) and `hashCheck` may return `STALE_HASH`; the approval is then marked
> `stale` and flagged for regeneration — **never silently applied against changed
> bytes**. Explicit test case.

### 6.4 `APPROVAL_REQUIRED` vs a queued result

Two distinct outcomes from the same trusted-zone gate, by entry tool:

- `vault_propose_edit` (MCP) is the *intended* way to touch a trusted note: it
  **succeeds** and returns a `{ queued: true, approval_id }` result.
- A direct `memory_revise` whose path resolves to a trusted zone is a *misuse*:
  it is **rejected** with `APPROVAL_REQUIRED` (retriable via `propose_edit`),
  rather than being silently queued. This keeps the agent's tool intent explicit.

**`propose_edit` on a non-trusted path (v0.1 behavior).** `propose_edit`
conservatively **queues any non-excluded path** — including agent/scratch — rather
than applying it directly; an excluded (or `.ledger/`/`.git/`) path is rejected
`FORBIDDEN_ZONE` and never queued. Queuing an agent-zone `propose_edit` is
harmless over-gating (the human just approves a write the agent could have made
directly via `memory_revise`); the intended use is trusted notes. Routing an
agent-zone `propose_edit` straight to an apply is a possible v0.2 refinement.

---

## 7. Onboarding scanner (Prompt 5)

Read-only walk of the vault (respecting `.gitignore`-style excludes), parsing
frontmatter (`gray-matter`) and links (light wikilink regex). Produces a
**VaultProfile**: note count, link count, detected folders (daily notes,
templates, attachments, likely projects), and a **proposed PermissionsManifest**
with conservative defaults — everything `trusted`; `Agent/**` created as the
agent zone with `Agent/Scratch/**` carved out as a distinct **scratch** zone
(TTL rules, relaxed) and `Agent/Archive/**` reserved for tombstones; `Private/**`
excluded if present. Emitting an explicit scratch zone gives the create/TTL code
paths (§4.1, §6) somewhere to resolve to. **Writes nothing inside user
folders**; only `.ledger/` is written, and only after explicit confirmation.

---

## 8. CLI (Prompt 6) — commander

- `ledger init <vault>` — scan → show profile → confirm → write `.ledger/`,
  `git init` if absent, mint vault ID.
- `ledger status` — zones, pending approvals, last 10 transactions.
- `ledger approve [id]` — interactive queue with colored diffs (`diff` lib);
  approving re-runs through the broker (surfaces `STALE_HASH` per §6.3).
- `ledger undo <txn|session>` — journal-compensated revert (§5.3); surfaces
  `REVERT_CONFLICT` on a dirty revert.
- `ledger log [--entity X] [--session Y]` — journal-indexed history.
- `ledger reindex` — rebuild the journal from vault frontmatter + Git history
  (§3.3); also auto-triggered when a known vault's journal is missing/empty.

Journal lives in the app-support dir keyed by vault ID (§3.1), never in the
vault.

---

## 9. MCP server (Prompt 7)

`@modelcontextprotocol/sdk` stdio server exposing the spec §7 tools:
`memory_recall`, `memory_remember`, `memory_revise`, `memory_promote`,
`memory_forget`, `vault_propose_edit`, `ledger_status`. Each validates input
with `core`'s zod schemas, routes through `core`, and returns provenance-rich
results. `recall` filters: `entity`, `tag`, `status`, `since`, `limit` —
journal-indexed, no embeddings. Ships a stdio entrypoint and a `.mcp.json` /
`claude_desktop_config` example. Integration test spawns the server over a
fixture vault and runs `remember → recall → revise → undo`.

---

## 10. Testing strategy

TDD, package by package, build-prompts 1–8 in order, with a code-reviewer
checkpoint after each package.

- **`core`** carries the bulk:
  - zone resolution incl. overlap/exclusion/override cases;
  - broker happy path, `STALE_HASH`, `FORBIDDEN_ZONE`, `PATCH_TOO_LARGE`,
    `SYNTAX_BREAK`, `TARGET_EXISTS`, undo chains, **journal compensation on
    undo**, **`REVERT_CONFLICT` on a dirty revert** (working tree + journal
    untouched), **stale-approval on approve**;
  - each lifecycle transition and each rejection;
  - **`reindex` rebuilds an identical journal** after the journal is deleted
    (recall returns the same memories via auto-reindex);
  - scanner produces expected profile + writes nothing to user folders;
  - startup reconcile repairs a simulated commit-without-journal-row.
- **`cli`** / **`mcp-server`** — thin integration tests.
- **e2e** — the full Prompt 8 six-step scenario as an automated test, plus a
  2-minute README walkthrough.

---

## 11. Standing instructions (→ repo CLAUDE.md)

- The model never writes vault files directly; all mutations go through the
  broker.
- Patch-level edits only; whole-file rewrites are a broker rejection.
- Every mutation must be attributable: session, reason, commit.
- `.ledger/` is the only in-vault footprint besides the agent zone.
- When in doubt between convenience and auditability, choose auditability.

---

## 12. Deferred to later milestones

**Already hardened in v0.1** (moved forward from the planned v1.0 security pass,
because v0.1 ships the write path): path-traversal containment, symlink-escape
containment (realpath), `.ledger/`+`.git/` always-excluded, case-insensitive zone
matching. See §5.

**Known v0.1 limitations (accepted):**
- Multi-step operations (e.g. `forget` = frontmatter-flip commit **then** archive
  move; approval-row state **after** the applied op) are not single-commit atomic.
  A crash between steps leaves a transient inconsistency, self-healing on the next
  `reindex` (file frontmatter is the source of truth) or visible on retry. A
  reconcile pass for the approval-row-vs-applied-op gap is future work.
- `markdownLint` is a count heuristic, not the true byte-identical-outside-hunks
  check (§5) — tightening needs hunk ranges threaded into the linter.
- TOCTOU between the containment check and the write, and symlink races, are not
  closed (a later hardening pass).

**Later milestones:**
- Obsidian plugin (v0.2) — stub compiles this cycle.
- Contradiction/negation detection + `conflicts` population (v0.3).
- Embeddings-assisted recall/conflict, team tier, WAL, Windows path specifics,
  byte-identical-outside-hunks lint, TOCTOU/symlink-race + patch-bomb hardening,
  installers (v1.0).
