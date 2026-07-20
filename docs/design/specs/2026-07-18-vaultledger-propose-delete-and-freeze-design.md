# VaultLedger — `vault_propose_delete` + `vault_propose_edit` demotion (0.4.7, the freeze cycle)

**Date:** 2026-07-18
**Status:** design (pre-implementation)
**Source:** planned v1 API completion. **The last feature cycle before API freeze.**

## The cycle

One tool **in** (`vault_propose_delete`), one tool **out** of the default surface
(`vault_propose_edit`, demoted to an expert opt-in). After this merges and
publishes, the **v1 agent surface is frozen** at:

> `vault_read` · `vault_propose_replace` · `vault_propose_create` ·
> `vault_propose_delete` · `ledger_status` + the memory lifecycle
> (`memory_recall`/`remember`/`revise`/`promote`/`retire`/`forget`/`distill`)

— 12 tools by default. Only bug fixes ship afterward until further notice
(§10 declares the freeze in README + CLAUDE.md).

**Why deletion belongs in v1 — and why it's safe:** a governed vault that can
create and edit but never delete accretes cruft the agent can't clean up. The
usual objection (deletion is destructive) does not apply here: **every deletion
lands as a git-committed removal, so `ledger undo` restores the file
byte-for-byte.** Deletion is recoverable by design — that is the argument *for*
supporting it, and the spec makes the recoverability a tested invariant (§8).

---

## WU-1 — `vault_propose_delete` (core + mcp-server)

**Tool:** `{path, expected_hash}` — `expected_hash` **required** (no conditional
shape). The human approves deleting the *exact content they reviewed*; drift →
`STALE_HASH`, identical to an edit. **Structured tool only, no raw-diff form.**
The flow is **`vault_read` → `vault_propose_delete`** (read to obtain the hash of
the content you intend to remove, then propose).

### It is its own op, NOT a diff (design decision)

A whole-file deletion expressed as a `+++ /dev/null` unified diff is the file's
*entire content* as `-` lines. On any non-trivial note that trips the
`PATCH_TOO_LARGE` ratio guard — deletion-via-diff would be rejected for exactly
the files most worth deleting. So `propose_delete` is a **dedicated op carrying
no patch**: `{op:"propose_delete", path, expected_hash, reason, session}`. This
also keeps the apply mechanism a clean `git rm` (below) rather than a
degenerate patch application, and sidesteps the historical
`applyProposeEdit`-rejects-deletion-diffs rule (0.4.4) entirely — that rule
stays; deletion goes through a different door.

### Propose gate — `applyProposeDelete` (queues, never applies directly)

Mirrors `applyProposeReplace`'s discipline:
1. **Containment / zone** — `assertContained`/`resolveAbs` (the 0.4.6
   canonical-path gate): traversal & symlink escape → `FORBIDDEN_ZONE`; an
   **excluded** path is unreachable (a delete targeting an excluded zone maps the
   same way reads do — but a delete is a WRITE-class op, so it surfaces
   `FORBIDDEN_ZONE` like propose, not the read oracle's `NOT_FOUND`). Zone rules
   inherit from `propose_edit` unchanged: trusted requires approval.
2. **Existence** — `!existsSync` → **`NOT_FOUND`** thrown with `retriable: true`
   at the call site (a wrong path is agent-fixable; matches the 0.4.5/0.4.6
   precedent).
3. **Hash pin** — `assertHashFormat(expected_hash)` → read → `hashBytes` compare;
   mismatch → **`STALE_HASH`**. This pins the exact content the human will
   review.
4. **Governance mirror (the third call site of the ONE predicate)** —
   creation guards `governedProvenanceChanged("", content)`; deletion guards
   **`governedProvenanceChanged(content, "")`** — same `lint.ts` predicate, no
   new regex. A file carrying governed provenance (a `ledger:` block / top-level
   `entity`) → **`LEDGER_GUARD`** (retriable) with a message steering to the
   memory tools: *"this note is a governed memory; memories retire, they do not
   delete — use `memory_retire` (keeps it citable in history) or `memory_forget`
   (tombstones it), not `vault_propose_delete`."* Memories retire; plain
   documents delete.
5. **Enqueue** — store the held op `{op:"propose_delete", path: <canonical>,
   expected_hash}` (path canonicalized per §3).

### Apply — on approve (the `doArchive` template, minus the move)

`Approvals.approve` re-runs the held op through the broker with
`{approved:true}`. The apply path (a new `applyDelete`, or the approved branch of
`applyProposeDelete`):
- Under `withVaultLock`: re-resolve the canonical abs, re-check existence (gone →
  clean `NOT_FOUND`/`STALE_HASH`, never a half-delete) and re-compare the hash
  (drift during the queue wait → `STALE_HASH`).
- `unlinkSync` + `git.commitPaths([path], formatMessage({op:"delete",…}))` — the
  exact `doArchive` mechanics without a destination path.
- Journal a **`delete`** transaction: `hash_before` = the content hash,
  `hash_after: null` (like `forget`). `commit_sha` recorded so reconcile/undo
  see it as any other mutation.

### Undo — restores byte-for-byte

`ledger undo <txnId>` = `git revert` of the delete commit → the file returns with
its pre-delete bytes. `undo` is commit-`sha`-driven (not op-specific), so a
`delete` txn reverts like any other — **confirm** `undoTransaction` needs no
new-op special-casing (it should not; verify in the plan). §8 asserts the
restored file hashes to the pre-delete digest.

### No new `RejectionCode`

Delete reuses `NOT_FOUND` (retriable at the call site), `STALE_HASH`, and
`LEDGER_GUARD`. **The server `Record<RejectionCode, number>` map is unchanged** —
the only exhaustive tables that grow are the op union + the `apply()`
exhaustiveness switch, and the catalog-count tables (§ WU-3). A `delete` journal
txn-op string is added (typing/reconcile), not a rejection code.

---

## WU-2 — plugin: a deletion must render unmistakably as a deletion

Approve-on-delete is the **highest-consequence click** in the review UI, so it
must never read as an ordinary edit.

- **`render.ts` (server)** already synthesizes `"" → content` for a create; add
  the mirror for `propose_delete`: a **`DELETE <path>` header** followed by the
  **full content being removed** as `-` lines. The `DIFF_RENDER_LIMIT` cap is
  **raised (or lifted) for a deletion** — a human approving a removal must be
  able to see everything that goes; truncating the very thing being destroyed is
  the wrong economy here (bound it generously; justify the number in the plan).
- **Plugin `renderDiff`** gets a **delete banner / distinct styling** so the row
  is visually a deletion, not a red-heavy edit. The full-content removal lines
  render via the existing `-`-line path (XSS-safe `textContent`, per the bundle
  purity guard).
- **Plugin versions on its own train** (manifest bump + esbuild rebuild +
  store/releases/`--install-plugin`), NOT npm — same cadence as the 0.4.1 plugin
  release.

---

## WU-3 — `vault_propose_edit` demotion to an expert opt-in

The raw-diff tool leaves the **default** agent surface. Agents get the structured
tools only; a diff-holding expert client can opt back in.

### Mechanism: a CLI flag `--allow-raw-diff` (ruled; justification for the record)

`vaultledger-mcp --allow-raw-diff` — parsed exactly like the existing
`--no-sweep` (`parseNoSweep` in `mcp-server/src/index.ts`; add
`parseAllowRawDiff`). **Chosen over an env var because:** (1) it lives *visibly*
next to `--vault` in the harness's own MCP config block, so a reader of the
config can see the raw-diff surface is enabled and *why* — an ambient env var is
invisible there; (2) it's per-invocation, not per-shell/global; (3) it matches
the codebase's established arg-flag precedent (`--no-sweep`, `--vault`) rather
than introducing an env-var pattern that exists nowhere else. Threaded through
`loadServerContext` → `buildTools(ctx, { allowRawDiff })` so `buildTools` includes
the `vault_propose_edit` `ToolDef` **iff** the flag is set.

### Catalog count is now conditional

- **Default (no flag): 12** — 7 memory + `vault_read` / `vault_propose_replace` /
  `vault_propose_create` / `vault_propose_delete` / `ledger_status`
  (`−vault_propose_edit +vault_propose_delete` vs 0.4.6's 12; net unchanged).
- **With `--allow-raw-diff`: 13** — `+vault_propose_edit`.

**Every count table tests BOTH configs:** `listToolNames()` takes the flag (or a
default arg) and returns 12 or 13; `mcp-server/test/tools.test.ts`,
`placeholder.test.ts`, `stdio.smoke.test.ts` assert the default 12 AND a
flag-on 13 (a new case). The exact tool-name arrays update accordingly.
`vault_propose_edit` remains fully implemented in core (broker unchanged) — only
its default *registration* changes.

### Docs

The skill + guides present the structured tools as the **only** agent path;
`vault_propose_edit` is documented once, as the expert `--allow-raw-diff` escape
hatch, not in the agent's rule set. (Doc edits sequence after the pending
`docs/structured-tools-guidance` merge — §10.)

---

## 3. Path canonicalization — folded for ALL propose ops (ruled)

The 0.4.6 merge-gate reviewer flagged that the approval queue stores the **raw
agent path** (`Notes/../Foo.md`), not the resolved target. For a **delete** —
the highest-consequence approval — the human must see exactly what is removed, so
this is folded in now, and **consistently across every propose op** (edit /
replace / create / delete) rather than delete-only.

- At the propose gate, store the **canonical path** (the `zonePath` the 0.4.6
  `assertContained` already computes — `..`- and symlink-resolved,
  root-relative) in the held op, instead of the raw `op.path`. Display (plugin,
  CLI `approve`, `GET /approvals`) and apply then agree on the real target.
- **Low regression risk:** for a normal path, `canonical === raw`, so existing
  propose tests (which use normal paths) are unaffected; only `..`/symlink inputs
  change, and to the more-truthful value. A test asserts a `Notes/../Foo.md`
  propose stores/display `Foo.md`.
- This retires the 0.4.6 "display-path canonicalization" backlog item.

---

## 4. Watch items (folded)

- **Queue storage/display:** the held op is `{op:"propose_delete", path
  (canonical), expected_hash}`; `render.ts` synthesizes the `content → ""`
  DELETE view (§WU-2). Downstream (`GET /approvals`, plugin, CLI `approve`) needs
  a `propose_delete` case in the renderer only — the approval/apply plumbing is
  inherited.
- **Delete vs a pending approval on the same file:** no pre-check. Each queued op
  re-verifies at ITS OWN approve time, so the interactions resolve cleanly:
  approving a delete then approving a stale pending edit on the same path →
  `STALE_HASH`/`NOT_FOUND` at the edit's approve; two pending deletes → the second
  fails (`NOT_FOUND`, file already gone). Document this; add a test for
  delete-then-stale-edit.

---

## 5. Tests

- **Unit / propose gate:** delete-of-missing-file → `NOT_FOUND` (retriable);
  delete-with-stale-hash → `STALE_HASH`; delete-of-governed-memory (a note with a
  `ledger:` block) → `LEDGER_GUARD` with the steering message (assert it names
  `memory_retire`/`memory_forget`); delete of a plain trusted note → queues;
  excluded/`..`/symlink target → `FORBIDDEN_ZONE` (inherits the 0.4.6 gate);
  canonical path stored (`Notes/../Foo.md` → `Foo.md`).
- **NAMED e2e — delete then undo restores byte-identical (the recoverability
  invariant):** propose_delete a seeded note → approve → file gone from disk AND
  git → `undo` → file restored, and its bytes **hash to the pre-delete digest**
  (not just "exists"). This is the load-bearing "recoverable by design" claim —
  pin it with a hash equality.
- **Registration:** default `buildTools(ctx)` → 12 names, no `vault_propose_edit`,
  yes `vault_propose_delete`; `buildTools(ctx, {allowRawDiff:true})` → 13,
  `+vault_propose_edit`. The three count-assertion sites cover both.
- **Plugin:** the delete render carries the DELETE header + the full content as
  removal lines (not just the path); the delete banner class is present.

### Fixture — the field-incident Testing note

Reuse the real "Testing" note fixture from 0.4.6 (`test/fixtures/testingNote.ts`,
150 bytes, sha256 `55bf4472…`) as the **delete e2e** subject: deleting a
"disposable proposal for testing the approval workflow" is *genuinely the cleanup
its purpose calls for*. The undo-restores-byte-identical test asserts the
restored file re-hashes to `TESTING_NOTE_SHA256`.

---

## 6. Versioning & publish

- **core + mcp-server → 0.4.7.** core: the `propose_delete` op + `applyProposeDelete`
  + the `delete` apply/txn + the canonicalization fold. mcp-server: the
  `vault_propose_delete` tool, `--allow-raw-diff` + conditional registration,
  catalog tables. **cli 0.4.1 / server → bumps only if `render.ts` changes ship
  (it does — the delete render) → server 0.4.1.** Wait: confirm whether the
  delete render lives in `server` (the bridge `render.ts`) — if so **server →
  0.4.1** (its first bump since 0.4.0); the plan verifies and versions it.
- **plugin → its own bump** (own train, not npm) for the delete render/banner.
- Ordered publish **core → mcp-server** (+ server if bumped), same runbook.

---

## 7. Freeze declaration (after merge + publish)

Add to **README** and **CLAUDE.md**: the v1 agent surface is frozen at the 12
default tools above; `vault_propose_edit` is the sole expert opt-in
(`--allow-raw-diff`); only bug fixes ship until further notice. This is written so
future sessions inherit the freeze as a standing constraint (a new feature tool
is now an explicit un-freeze decision, not a default).

---

## 8. Non-goals

- **No hard/unrecoverable delete** — every delete is a git-committed removal that
  `undo` restores; there is no "permanently erase" path (that would break the
  recoverability invariant that justifies the feature).
- **No raw-diff deletion** (`+++ /dev/null`) — structured `propose_delete` only;
  `applyProposeEdit` still rejects deletion diffs.
- **No bulk/directory delete** — single file by exact path.
- **No removal of `vault_propose_edit` from core** — it stays implemented and
  reachable via `--allow-raw-diff`; only default registration changes.
- **No new rejection codes** — delete reuses existing codes.
