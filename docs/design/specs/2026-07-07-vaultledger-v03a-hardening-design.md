# VaultLedger v0.3a hardening batch — design

**Date:** 2026-07-07
**Status:** Approved (brainstorm)
**Context:** Closes the last two known governance policy-seams from the v0.3a
reviews plus three usability nits from the dogfood pass, BEFORE the v0.3b
Undertow lifecycle work adds new ops (each a new seam). Five work units, all
small, TDD'd, subagent-built with the two-stage (spec + code-quality) review —
same process as the v0.3a patch backlog. Sequenced first per the scope decision.

Baseline: `main` @ `adf7e8a`, 491 pass / 1 skip, build + lint clean.

---

## WU-1 — content-revise of a `canonical` belief requires approval

**Hole (MEDIUM, review):** the ledger-guard (`governedProvenanceChanged`) protects
the `ledger:` block + top-level `entity`, but a canonical belief's **body** can
still be inverted across 2–3 unapproved `revise`s — the ~50% `PATCH_TOO_LARGE`
cap is iterable. Same family as the ledger-guard, distinct surface.

**Design — mirror the forget gate 1:1 (`MemoryStore.forget`'s canonical gate):**
- Scope: **canonical only.** Working stays immediate — it is provisional by
  definition, and gating it would put an approval on the agent's normal
  course-correction loop (the approval fatigue the zone model exists to avoid).
- In `MemoryStore.revise`, add `opts?: { approved?: boolean }`. If the target
  memory's status is `canonical` AND not `opts.approved`, enqueue an approval —
  held_operation = the full revise op (`{op:"revise", path, patch, expected_hash,
  reason, session, ...}`), zone `"canonical-revise"`, state `pending` — and
  return a queued result `{ queued: true, approvalId }` WITHOUT applying. Scratch
  / working targets apply immediately, exactly as today.
- `Approvals.approve` already dispatches a held `revise` via `dispatchApply`
  (`broker.apply(op, { approved: true })`) — so approving applies it. Confirm the
  held-op JSON shape round-trips through `dispatchApply` unchanged; no new
  approve-case needed (revise is already handled).
- MCP `memory_revise` relays the union: `{ queued, approvalId }` (canonical) vs
  the applied result (scratch/working). Structured, no throw.
- **Queue, not block** (unlike the ledger-guard, which rejects): changing an
  established belief's content is legitimate but needs human sign-off — the
  promote/forget governance model. The iteration attack is closed because *each*
  revise is individually gated.

**Stated consequence (must be written in the spec, not just code):** an approved
canonical-revise dispatches with `{approved:true}`, which **bypasses the
ledger-guard by design**. So the **approval diff is the human's one and only
chance** to catch a status/entity change smuggled into a content revise. The
approval renderer already shows the FULL diff (`renderApprovalDiff`) — this is
acceptable, but it is a load-bearing invariant: **the approval diff view must
never be "optimized" into a summary/truncation that could hide a smuggled
provenance change.** (The existing renderer truncates only oversized diffs with a
visible marker; keep that property.)

**Required tests:**
- Gate: revise a CANONICAL memory (unapproved) → `{queued, approvalId}`, file
  unchanged, pending approval in zone `canonical-revise`; `approve()` → the patch
  lands; `reject()` → file stays. Working/scratch revise still immediate.
- **Audit (carry over the forget-gate audit — no agent-reachable path revises a
  canonical without approval):** (a) MCP `memory_revise` on a canonical → queued,
  not applied; (b) confirm the MCP surface cannot emit a raw broker revise op
  that bypasses the store gate (the 7 tools are the only surface; `memory_revise`
  → `store.revise`); (c) `vault_propose_edit` already queues (regression).
- Idempotent re-approve safe (mirror the forget idempotency guard if the same
  concern applies to a held revise).

---

## WU-2 — conflict dedup key must include the conflicting values (dismiss-once fix)

**Hole (MEDIUM, review):** the conflicts unique key
`UNIQUE(pair_lo, pair_hi, kind, fact_key)` omits the values, and inserts use
`ON CONFLICT DO NOTHING` — so one **dismissed** conflict permanently swallows
every FUTURE **different-valued** contradiction on that pair+fact (it never
reopens). Nastier now that the canonical-exception trains users to dismiss benign
rows.

**Design — value-hash in the unique key** (chosen over reopen-the-dismissed-row,
to PRESERVE the audit record: a dismissed row stays dismissed; a genuinely new
contradiction is its own row):
- Add a `value_hash TEXT NOT NULL` column to `conflicts`; new unique index
  `UNIQUE(pair_lo, pair_hi, kind, fact_key, value_hash)`.
- **NOT NULL is load-bearing (SQLite footgun):** SQLite treats NULLs as
  *distinct* in a UNIQUE index, so any NULL `value_hash` is permanently
  un-dedupable — every rescan would spawn a duplicate. The column must end up
  `NOT NULL` and the insert path must NEVER write NULL.
- **`value_hash` defined for BOTH conflict kinds (deterministic, no
  `Math.random`):**
  - `value-conflict`: hash the **order-normalized canonical value pair** (the two
    canonicalized fact values, sorted so A-vs-B and B-vs-A hash equal — matching
    the existing `pair_lo/pair_hi` normalization).
  - `negation-conflict`: hash the **normalized statement pair** (the two folded
    subject/object statements, order-normalized).
  - Defining both now prevents the negation path from either crashing the NOT
    NULL invariant or silently getting a constant hash (which would reintroduce
    dismiss-forever for negations only).
- **Migration:** add the column, **backfill every existing row** with a non-null
  hash (hash the stored `detail` string verbatim — robust even if re-parsing the
  original values is fragile), THEN build the new unique index (drop the old one).
  Order matters: backfill before the NOT NULL/unique constraint so no row is left
  NULL. Idempotent (`IF NOT EXISTS` / guarded), consistent with existing
  migrations in `journal/db.ts`.
- Effect: a new contradiction with DIFFERENT values on the same pair+fact →
  different `value_hash` → a **new open row** (not swallowed); re-detecting the
  SAME values → same hash → dedup as before (no duplicates).

**Accepted consequence (state it):** a fact whose value keeps changing accumulates
**one row per distinct value pair** over time. That is honest behavior — each is a
real, separately-dismissable contradiction — not a leak.

**Required tests:**
- Dismiss a value-conflict on (pair, fact, valueA↔valueB); a later detection with
  a DIFFERENT value (valueA↔valueC) → a NEW open row (RED before the fix: swallowed).
- Re-detecting the SAME value pair → still exactly one row (dedup preserved).
- The SAME for a **negation-conflict** (distinct statement pair → new row; same →
  dedup) — proves the negation hash isn't constant.
- Migration: an existing pre-migration conflicts DB opens, every row gets a
  non-null `value_hash`, the unique index exists, re-open is idempotent, and no
  row is un-dedupable (a rescan produces no duplicate of a backfilled row).

---

## WU-3 — validate `expected_hash` format at enqueue (dogfood nit)

**Problem:** a `propose_edit`/`revise` op with a bare hex digest (missing the
`sha256:` prefix) enters the queue fine and only fails at **approve** time (goes
stale) — a confusing, delayed, non-actionable failure for the agent.

**Design:** validate the `expected_hash` format when the op enters the queue /
is applied — reject a malformed hash immediately with a typed, actionable
`BrokerError` (e.g. `STALE_HASH` or a dedicated `MALFORMED_HASH` — pick per the
existing error taxonomy; a distinct code is clearer) at the point the op is
accepted (propose_edit enqueue AND direct revise), so the agent gets the
rejection at call time, not approval time. The canonical format is
`sha256:<64 hex>` — validate the prefix + hex length.

**Required tests:** propose_edit / revise with a bare hex (no `sha256:`) → typed
rejection at enqueue/apply time, nothing queued; a well-formed hash still works.

---

## WU-4 — absolute-byte floor on the 50% patch guard (dogfood nit)

**Problem:** the `PATCH_TOO_LARGE` guard (patch changes > ~50% of lines/bytes)
is over-tight on very short notes — a legitimate one-line edit to a tiny file
trips it (hit repeatedly during dogfood setup).

**Design:** in `broker/patch.ts` `applyPatch`, only enforce the ratio guard when
the original content exceeds a small absolute-byte floor (e.g. **512 bytes**).
Below the floor, a large-ratio change on a tiny note is allowed (the ratio is
meaningless at that size). Keep the ratio guard unchanged above the floor. Named
constant; documented rationale.

**Required tests:** a one-line edit to a sub-floor tiny note SUCCEEDS (RED before:
`PATCH_TOO_LARGE`); an above-floor note with a >50% change still throws
`PATCH_TOO_LARGE` (guard intact where it matters).

---

## WU-5 — legacy-entity backfill (dogfood residual)

**Problem:** `remember` now writes `entity` to note frontmatter (shipped), and an
incremental reindex preserves a journal-only entity — but a **full rebuild from an
empty journal cannot recover a PRE-FIX legacy note's entity** (it was never in the
file). Those notes silently drop from same-entity comparison sets after a full
rebuild.

**Design:** a one-shot maintenance command `ledger memory backfill-entity <vault>`
(and the underlying core function): iterate journal memories; for each whose
JOURNAL row has a non-null `entity` but whose FILE lacks a top-level `entity`,
write the entity into the note's top-level frontmatter through the broker as an
**approved** revise (entity is governed → `{approved:true}`, which also triggers
the pre-image baseline for any still-untracked note). After the backfill, every
memory is self-describing and survives a full rebuild. Idempotent (skip notes
whose file already carries the entity). Report counts (backfilled / skipped /
errors), non-fatal per note (one bad note doesn't abort the run).

**Required tests:** a legacy note (journal entity set, file has none) → after
backfill the FILE carries the top-level entity and a subsequent full rebuild
recovers it; a note already carrying entity is skipped (idempotent); a
missing/corrupt note is recorded, not fatal.

---

## Gate & process
Each WU: failing test first, then implement, then the two-stage review. After all
five: `pnpm build && pnpm -w lint && pnpm test` green; merge to `main`; push.
Then start the v0.3b Undertow brainstorm.
