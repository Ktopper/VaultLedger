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

`applyProposeEdit` already **rejects every `+++ /dev/null` deletion diff
outright** (`patchTargetKind === "delete"` → `SYNTAX_BREAK` "file deletion via
vault_propose_edit is not supported", 0.4.4, broker.ts ~:520) — the primary
reason deletion can't ride the diff path at all, at any size. (Secondary, for a
note over the 512-byte `PATCH_RATIO_FLOOR_BYTES`: a whole-file deletion is the
entire content as `-` lines, which also trips the `PATCH_TOO_LARGE` ratio guard —
verified, e.g. a 6 KB note → `PATCH_TOO_LARGE`; a sub-512-byte note like the
Testing fixture is *under* the floor and would not, which is exactly why the
deletion-*kind* guard, not the size guard, is the load-bearing barrier.) So
`propose_delete` is a **dedicated op carrying no patch**:
`{op:"propose_delete", path, expected_hash, reason, session}`. This keeps the
apply mechanism a clean `git rm` (below), and the 0.4.4 deletion-diff rejection
**stays** — deletion goes through a different door, not by loosening that rule.

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

**Dual-mode on ONE op string** (delete differs from replace/create here): there
is no natural `revise`-shaped op to reshape a delete into (no patch), so
`propose_delete` is used for BOTH propose and apply, and the broker's
`case "propose_delete"` **branches on `opts.approved`** (mirroring `case "revise"`
→ `applyRevise(op, approved)`): `approved === false` → `applyProposeDelete`
(queue); `approved === true` → `applyDelete` (perform). Two wiring points the
spec-review surfaced, both REQUIRED:
1. **`Approvals.approve()`'s `switch (op.op)`** (queue.ts ~:149) ends in a
   `default → INVALID_TRANSITION`; a `propose_delete` would hit it and throw. Add
   `case "propose_delete": return this.dispatchApply(id, op);` (mirror
   `create`/`revise`). `dispatchApply` calls `broker.apply(op, {approved:true,
   approvalId:id})` — which is what stamps the delete txn's `approval_id` for
   reconcile's id-match close, so wire through it, not a bespoke path.
2. **`broker.apply()`'s dispatch switch** gets `case "propose_delete"` branching
   on `opts.approved` as above.

`applyDelete` (the approved branch): under `withVaultLock`, re-resolve the
canonical abs, re-check existence (gone → clean `NOT_FOUND`/`STALE_HASH`, never a
half-delete) and re-compare the hash (drift during the queue wait → `STALE_HASH`);
then `unlinkSync` + `git.commitPaths([path], formatMessage({op:"delete",…}))` —
the exact `doArchive` mechanics without a destination path; journal a **`delete`**
transaction: `hash_before` = the content hash, `hash_after: null` (like
`forget`), `approval_id` from the held approval, `commit_sha` recorded.
(Confirmed at spec-review: `TransactionRow.op`, `formatMessage.op`, and reconcile
are all op-string-generic — a new `"delete"` string needs NO schema/enum change;
and `undoTransaction`/`undoSession` are `commit_sha`-driven with `memory_id:null`
skipping the memory-status block, so undo restores with no new-op special-casing.)

### Undo — restores byte-for-byte

`ledger undo <txnId>` = `git revert` of the delete commit → the file returns with
its pre-delete bytes. `undo` is commit-`sha`-driven (not op-specific), so a
`delete` txn reverts like any other — **confirm** `undoTransaction` needs no
new-op special-casing (it should not; verify in the plan). §8 asserts the
restored file hashes to the pre-delete digest.

### No new `RejectionCode`

Delete reuses `NOT_FOUND` (retriable at the call site), `STALE_HASH`, and
`LEDGER_GUARD`. **The server `Record<RejectionCode, number>` map is unchanged** —
the exhaustive tables that grow are the op union, the broker `apply()`
exhaustiveness switch, **the `Approvals.approve()` `switch` (new
`case "propose_delete"`)**, and the catalog-count tables (§WU-3). The `delete`
journal txn-op is a plain string (`TransactionRow.op` is `string` — no enum/schema
change), not a rejection code.

---

## WU-2 — plugin: a deletion must render unmistakably as a deletion

Approve-on-delete is the **highest-consequence click** in the review UI, so it
must never read as an ordinary edit.

- **`render.ts` (server) needs the file content, which the held op does NOT
  carry** (spec-review blocker): `renderApprovalDiff(heldJson)` is a pure
  function with no fs access; the create branch can synthesize `"" → content`
  only because the **create op carries `content`** in the held JSON. A
  `propose_delete` held op is `{path, expected_hash}` — no content (deliberately:
  storing it would bloat the queue and could drift from `expected_hash`). **Fix:
  the file still exists on disk at `/approvals` time** (it's removed only on
  approve), so the `/approvals` handler (`server/src/app.ts`, which already has
  `ctx.vaultRoot`/`ctx.manifest`) reads the current content via
  `assertContainedAndReadable` + a bounded read and passes it into a **widened
  `renderApprovalDiff(heldJson, { deleteContent })`**. Render then synthesizes the
  **`DELETE <path>` header** + the **full content as `-` lines**. If the file is
  already absent (deleted out-of-band before approval), render shows a
  `DELETE <path> — file already absent` marker instead of throwing.
- **Bound the delete render to the `vault_read` 64 KiB note ceiling**, not
  unbounded: `/approvals` renders *every* pending row on every call, so an
  unbounded per-row content render is a DoS foot-gun. 64 KiB matches the largest
  note `vault_read`/the structured tools will touch, so a deletable note's full
  content fits; a (pathological) larger file's delete render is capped with the
  existing truncation marker. (The current `DIFF_RENDER_LIMIT` is 20 000 chars;
  the plan sets the delete bound explicitly against the 64 KiB read cap.)
- **The CLI `ledger approve` surface needs the SAME content-read (re-review
  finding — High):** the terminal review renders via `cli/src/commands/approve.ts`'s
  `renderHeldOperation(op)` — also a pure `(op) => string`. A `propose_delete`
  held op has no `patch`/`content`, so it falls through to `"(no diff available)"`
  — the terminal shows the reviewer NOTHING about what is being deleted, the exact
  blind spot WU-2 exists to kill, on a second surface. So the delete case is NOT
  "a renderer case only": the CLI renderer must be threaded a vault handle
  (`vaultRoot`/`manifest`) and do the same bounded content-read as the server
  before rendering the `content → ""` DELETE view. Both display surfaces (server
  `renderApprovalDiff` and CLI `renderHeldOperation`) get the delete content-read.
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
than introducing an env-var pattern that exists nowhere else. **Threading (spec-review correction):** `buildTools(ctx)` is called by
`createServer(ctx)` (index.ts:68), NOT by `main`/`loadServerContext`. So `main`
parses `parseAllowRawDiff(argv)` and passes it into `loadServerContext` via
**`LoadServerContextDeps`** (a new field, parallel to the existing `skipSweep`);
`loadServerContext` sets `allowRawDiff` on the returned **`ServerContext`** (a new
interface field). `buildTools(ctx)` reads `ctx.allowRawDiff` and includes the
`vault_propose_edit` `ToolDef` **iff** it is set. Carrying the flag on `ctx` (not
a new `createServer`/`buildTools` param) means every existing
`createServer(ctx)`/`buildTools(ctx)` call site — including all tests — keeps
compiling untouched; a test that wants the raw-diff tool sets `allowRawDiff:true`
on the ctx it builds.

### Catalog count is now conditional

- **Default (no flag): 12** — 7 memory + `vault_read` / `vault_propose_replace` /
  `vault_propose_create` / `vault_propose_delete` / `ledger_status`
  (`−vault_propose_edit +vault_propose_delete` vs 0.4.6's 12; net unchanged).
- **With `--allow-raw-diff`: 13** — `+vault_propose_edit`.

**`listToolNames(allowRawDiff = false)` — a DEFAULTED arg** so the smoke sites
that call it bare keep compiling; returns the 12 default names, or 13 with the
flag. **The default count STAYS 12** (`−vault_propose_edit +vault_propose_delete`),
so the NUMERIC asserts don't change — only the tool-name *content* and a new
flag-on case:
- `tools.test.ts` — the exact name ARRAY swaps `vault_propose_edit` →
  `vault_propose_delete`, plus a NEW `allowRawDiff:true` → 13-name case; `tools.size`
  and the listToolNames-in-sync assertions stay 12 by default.
- `placeholder.test.ts` (`toHaveLength(12)`), `stdio.smoke.test.ts`
  (`.toBe(12)`, spawns bare), `bin.launcher.smoke.test.ts` (`listToolNames()`
  bare) — **numeric asserts unchanged at 12**; they only needed the defaulted
  `listToolNames` arg so they keep compiling.

**Behavioral `propose_edit` tests MUST migrate to a flag-on context** (they fetch
`vault_propose_edit` from the DEFAULT `buildTools`/`createServer`, which no longer
registers it, so `tools.get("vault_propose_edit")!` crashes / `callTool` returns
unknown-tool): `tools.test.ts` (the `tools.get("vault_propose_edit")` sites,
~:218/:242), `inputBounds.test.ts` (the propose_edit byte-bound test, ~:217), and
`v01-gate.e2e.test.ts` — **TWO separate contexts** (re-review): `ctxA` happy-path
queue (~:188) AND `ctxC` the excluded-path `FORBIDDEN_ZONE` step (~:309); BOTH
`loadServerContext` builders need `allowRawDiff:true`, or `callToolC` returns
unknown-tool BEFORE the zone check and the asserted `FORBIDDEN_ZONE` flips. Each
migrated site rebuilds its ctx with `allowRawDiff:true`. `vault_propose_edit`
stays fully implemented in core (broker unchanged) — only its default
*registration* moves behind the flag.

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
- **Cosmetic caveat (noted so a future reader isn't alarmed):** for
  `propose_replace`/`propose_edit`, the queued patch's `---`/`+++` headers are
  generated from the RAW `op.path`, so after this fold the stored (canonical)
  `op.path` and the patch's header path can differ for a `..`/symlink input.
  Harmless — jsdiff applies hunks to the `before` string and ignores header
  paths, and `patchTargetKind` only inspects for `/dev/null` — but the plan
  should either regenerate the header from the canonical path too, or leave a
  one-line comment at the divergence.
- This retires the 0.4.6 "display-path canonicalization" backlog item.

---

## 4. Watch items (folded)

- **Queue storage/display:** the held op is `{op:"propose_delete", path
  (canonical), expected_hash}`. Downstream `GET /approvals` + the plugin + CLI
  `ledger approve` each need a `propose_delete` render case — and (§WU-2) the
  server `renderApprovalDiff` AND the CLI `renderHeldOperation` need a **vault
  handle for the delete content-read**, not merely a switch case (neither carries
  one today). The approval/apply plumbing below the renderer is inherited.
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
  `+vault_propose_edit`. The count sites (WU-3) cover both configs; default stays 12.
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
  + `applyDelete` + the `delete` txn + the canonicalization fold. mcp-server: the
  `vault_propose_delete` tool, `--allow-raw-diff` + conditional registration,
  catalog tables.
- **server → 0.4.1** (its first bump since 0.4.0): confirmed `renderApprovalDiff`
  lives in `packages/server/src/render.ts`, and the delete-render + the
  `/approvals` content-read (blocker-1 fix) ship there. cli 0.4.1 unchanged.
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
