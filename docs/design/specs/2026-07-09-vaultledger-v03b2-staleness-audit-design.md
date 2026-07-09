# VaultLedger v0.3b-2 — source-linked staleness + `ledger memory audit` — design

**Date:** 2026-07-09
**Status:** Approved (brainstorm)
**Context:** v0.3b (Undertow merge) cycle 2 of 2. b-1 shipped the lifecycle ops
(`memory_distill`/`memory_retire` + `memory_relations` + `retired` status). b-2
adds the *intelligence*: flag a distillation stale when a source it cites is
retired/revised/gone, surfaced in the conflicts queue + a new `ledger memory
audit`. Builds directly on b-1's forward-pins **P1/P2/P3** (see
`docs/design/specs/2026-07-08-vaultledger-v03b1-lifecycle-ops-design.md`) — this
spec resolves them into buildable detail.

Baseline: `main` @ `94c05aa`, 573 pass / 1 skip. Built subagent-driven with the
two-stage review; the detection + audit units touch the trust model and the
shipped 5-column conflict key, so they get an adversarial pass.

**WU order (deliberate):** WU-1 (approval-stale generalization) FIRST — it's the
smallest (~20 lines) and it cleans up the "zombie-pending approval" behavior so
b-2's own retire-event tests assert against clean stale semantics instead of
being written around the old behavior and then rewritten.

---

## WU-1 — generalize approval dispatch: a no-longer-applicable held op stales (not strands)

**Problem (clean-room spot-check d):** a queued canonical-retire whose target is
`forget`-ten before the retire approval is approved → approving the retire throws
`INVALID_TRANSITION` and the approval **stays `pending`** (a zombie a human must
manually reject). Only the propose_edit `STALE_HASH` path currently stales.

**Design — generalize the existing `STALE_HASH → {stale}` path in
`Approvals.approve`/`dispatchApply`:**
- When a held op's dispatch throws a `BrokerError` whose code is in an **explicit
  STALE-ELIGIBLE ALLOWLIST** — `STALE_HASH`, `INVALID_TRANSITION`,
  `ALREADY_CLOSED`, `ALREADY_REVERTED` (the "the world moved, this held op no
  longer applies" class) — mark the approval `stale` and return `{stale:true}`.
- **Any OTHER error RE-THROWS.** Never "mark stale on any failure": a transient
  bug (a DB error, a lock timeout) must NOT silently bury a legitimate pending
  approval. The allowlist is the whole safety property.
- **`NOT_FOUND` is deliberately EXCLUDED** (a held op whose target file vanished
  entirely). It's ambiguous — "the world moved" OR a transient sync flake where the
  file returns. The conservative call is to **leave the approval `pending` for
  human review** rather than auto-stale a possibly-recoverable op. Stated so the
  exclusion reads as a decision, not an oversight.
- **Record the rejection code on the staled row** (`stale_reason` column on
  `approvals`, migration-added) so the human browsing the queue sees *why* it
  became unapplicable (`stale: INVALID_TRANSITION`), not just *that* it did.

**Tests:** approve a held retire whose target became `forgotten` → approval
`stale`, `stale_reason = INVALID_TRANSITION`, no throw, target untouched; the
existing propose_edit `STALE_HASH → {stale}` path still works (now via the
allowlist) and records `STALE_HASH`; a dispatch that throws a NON-allowlisted
error (simulate) still throws and leaves the approval `pending`.

Commit: `feat(core): stale an approval whose held op is no longer applicable (allowlisted codes, recorded reason)`

---

## WU-2 — `stale-source` conflict kind + kind-aware liveness (P1/P2)

### 2.1 The row (P1 — reuse the shipped 5-column key, roles by LOOKUP)
A staleness flag is a `conflicts` row with `kind = "stale-source"`. The pair is
{distillation, source}. **Keep the universal `memory_a == pair_lo == id-sorted-low`
convention (5146b44)** — do NOT make `memory_a` semantically "the distillation."
Roles are recovered by a **PER-PAIR edge query** (NOT a per-memory lookup): the
distillation in this row is the side `a` for which an edge
`(memory_id = a, source_id = the-other-side)` exists in `memory_relations`.
**This must be per-pair because b-1 allows distillation CHAINS** (D2 cites
distillation D1 — clean-room spot-check a): on a stale-source row for pair
{D2, D1}, BOTH sides appear as some `memory_id` (D2 cites D1; D1 cites its own
source), so a per-memory "is this side any `memory_id`?" test is ambiguous — but
only the edge `(memory_id=D2, source_id=D1)` matches THIS pair. Cycles are
impossible (a source must pre-exist the distillation citing it; ids are fresh), so
exactly one direction of the pair matches. `fact_key` = the constant `"source"`.
Reuses the unique key `(pair_lo, pair_hi, kind, fact_key, value_hash)` → **no
schema change**.

### 2.2 `value_hash` and the LOAD-BEARING detail format
`value_hash = conflictValueHash(detail)` — the ONE hash-of-detail rule (WU-2/F1:
one preimage, no second path to diverge). The stale-source `detail` **encodes the
source's (status, content-identity)** so the hash distinguishes source-states:

> **Detail template (HASH-STABLE — see below):**
> `stale-source: <distillationId> cites <sourceId> now <sourceStatus> (content <contentId>)`
> where `<contentId>` = the source note's content sha256 when the file exists
> (`retired`, `forgotten`→Archive), or the literal `GONE` when it doesn't
> (`reverted`/`missing`).

Consequences of this being right:
- **Content-hash-as-dedup-value, transitively** (the sha is a component of detail).
- **WU-2 dedup for free:** re-flagging the same source-state → same detail → same
  hash → dedup (the audit scan re-running never re-floods); a new fact-changing
  revise → new content sha → new row.
- **Status is in the preimage,** so retiring a source *after* a dismissed
  revise-flag raises a FRESH row (different status) instead of deduping into the
  dismissal — the correct behavior, and the one a bare content hash gets wrong.
- **GONE needs no special machinery** — it's just another `<contentId>` value.

**⚠ The detail string is now a dedup PREIMAGE — its format is load-bearing.** A
cosmetic rewording in some future cleanup silently changes every stale-source
hash: existing dismissed flags stop deduping and the queue re-floods on the next
scan. Therefore:
- **Deterministic components ONLY** — status + content identity. **No timestamps,
  no counters, no locale-dependent formatting.**
- A **golden-string test** pins the exact rendered format for a fixed input.
- A comment marks the template **hash-stable** (same treatment
  `conflictValueHash`'s preimage already carries).
- **Any future change to this template is a MIGRATION event, not a copyedit** —
  state this in the code comment.

### 2.3 Kind-aware both-sides-live filter (P2)
`Conflicts.list("open")` + `GET /conflicts` become kind-aware:
- `value-conflict` / `negation-conflict`: BOTH sides live (unchanged).
- `stale-source`: only the **distillation** side must be live — identified by the
  PER-PAIR edge query (§2.1), NOT by `memory_a`/`pair_lo` position (source and
  distillation ids sort randomly; checking `memory_a` would filter the wrong side
  for ~half of rows — silent, and it passes any test that doesn't control id
  ordering). A `forgotten`/`reverted` distillation moots the flag; the source being
  dead is the whole point.

**Tests:** a stale-source row survives `list()` even though its source side is
`retired`; a `forgotten` distillation's stale-source row is filtered out; **create
stale-source rows with BOTH id orderings** (source-id < distillation-id AND >) and
assert the filter keeps both (the P2 regression a position-based check would fail);
**a CHAIN fixture** — a stale-source row on a pair {D2, D1} where BOTH sides are
distillations (D2 cites D1; D1 cites source S), asserting the per-pair edge query
picks D2 (not D1) as the live-side to check, and covering both id orderings (the §2.1
ambiguity a per-memory lookup would get wrong); the golden-string detail test;
same-source-state re-flag dedups, new state → new row; a GONE-source flag hashes
deterministically.

Commit: `feat(core): stale-source conflict kind (hash-stable detail) + kind-aware both-sides-live filter`

---

## WU-3 — event-driven detection (retire always; revise on fact-change)

- **On `retire` of a source** (`store.retire`, after the status flip lands): for
  every distillation citing it (`journal.getDistillationsCitingSource(sourceId)`),
  insert a stale-source flag — detail status `retired`, contentId = sha of the
  current file. **Always** (retirement is a definitive "no longer current" event).
- **On `forget` of a cited source** (`store.forget`, after the archive lands): the
  SAME as retire — flag every citing distillation (detail status `forgotten`,
  contentId = the Archive-file sha). **This event is agent-reachable and must not
  be omitted:** forgetting a WORKING source is ungated, so without this trigger an
  agent could distill from a working source, forget the source, and the
  distillation would cite gone content with **no flag** until someone happens to
  run `audit` — the same laundering shape as the gaps already closed, only lazier.
  Retire and forget share ONE helper.
- **Undo of a cited source's create is SCAN-ONLY** (deliberately NOT an inline
  event): `undo` is CLI/human-initiated, so the operator is present to run `ledger
  memory audit`, and the state scan (WU-4) catches the resulting
  `reverted`/missing source. Stated explicitly so it reads as a decision, not an
  omission.
- **On a `revise` that changes a source's content**, flag citing distillations
  **only if the extracted FACTS changed** (your lean — noise control: prose
  course-correction on a working source is silent). 
  - **In-path fact-diff, NO persisted baseline** (disposable-index preserved —
    git/file is the source of truth): computed in the **memory-layer revise path**
    from the source's **pre- and post-apply content** (read around the broker
    call — `store.revise` already reads the file to compute `expected_hash`, and
    reads the applied result), using the contradiction engine's `extract()` on
    both. If the canonicalized facts differ AND the memory is cited by any
    distillation, flag those distillations (detail status = the source's current
    status e.g. `working`, contentId = sha-after). This same in-path computation
    covers the approved-canonical-source revise (applied via `dispatchApply`) —
    wire both apply paths through one memory-layer staleness helper.
  - A cheap guard first: skip the whole fact-diff unless
    `getDistillationsCitingSource(id)` is non-empty (most memories cite nobody).
- Runs **post-commit, non-blocking** (mirrors `checkContradictions` — a staleness
  failure never fails the write).

**Tests:** retire a source cited by 2 distillations → 2 stale-source flags (status
`retired`); a fact-changing revise of a cited working source → flags (status
`working`); a **prose-only** revise of a cited source (facts unchanged) → NO flag;
a revise of a memory cited by nobody → no flag, no cost; re-detecting the same
event dedups.

Commit: `feat(core): source-linked staleness on retire (always) + revise (fact-change only, in-path diff)`

---

## WU-4 — state-based scan: `ledger memory audit`

Event-driven detection is blind to **post-hoc death** by construction (a source
cited while live that dies LATER — clean-room spot-check a: the D2→D1 dangling
edge). So a state-based scan closes it and doubles as post-rebuild recovery.

- **Core `auditMemories(...)`:** enumerate every distillation
  (`memory_relations` distinct `memory_id`); for each cited `source_id`, resolve
  the source's status and existence; if the source is **dead-or-gone** —
  `retired | forgotten | reverted | missing` (widened per spot-check a) — ensure a
  stale-source flag (same detail template + `value_hash` → deduped by the same key;
  re-running the scan never duplicates). Idempotent.
- **CLI `ledger memory audit <vault>`:** run the scan, print a summary
  (`stale distillations: N` + the distillation→source pairs and each source's
  dead/gone reason). Mirror `backfill-entity`'s reporting/exit-code convention.
- Surface: stale-source rows appear in the existing conflicts queue (CLI `ledger
  conflicts`, bridge `/conflicts`, plugin **Conflicts** tab) via the kind-aware
  filter; `audit` is the state-based entry point + a human-readable report.

**Tests:** a distillation whose source became `reverted` AFTER distillation (event
missed it) → the scan flags it; a live-source distillation → not flagged; the scan
is idempotent (second run adds no rows); a `forgotten`-source and a `retired`-source
distillation are both flagged; after a journal wipe + reindex, the scan re-derives
the same flags (recovery).

Commit: `feat(core,cli): ledger memory audit — state-based stale-source scan (dead-or-gone sources)`

---

## Out of scope / notes
- **Plugin labeling:** stale-source rows already render in the Conflicts tab; a
  distinct "Staleness" label/section is a cosmetic follow-up, not b-2.
- **The b-1 open question ("flag on fact-change vs any byte")** is RESOLVED here:
  fact-change (WU-3). Recorded.
- No change to the 5-column conflict key or `conflictValueHash` — stale-source
  rides both exactly as the b-1 pins promised.

## Process
Branch `feat/v0.3b2-staleness-audit`. WU-1 → WU-2 → WU-3 → WU-4. WU-2 (the
hash-stable preimage + kind-aware filter) and WU-3/WU-4 (detection touching the
trust model) get the adversarial code-review pass; WU-1 gets a careful self-review
(the allowlist must not over-capture). Gate: `pnpm build && pnpm -w lint && pnpm
test` green; merge; push. That completes v0.3b (the Undertow merge).
