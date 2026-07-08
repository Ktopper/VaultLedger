# VaultLedger v0.3b-1 — lifecycle ops (distill + retire) — design

**Date:** 2026-07-08
**Status:** Approved (brainstorm)
**Context:** v0.3b (the Undertow merge) split into two cycles per the scope
decision. **This is b-1: the two new lifecycle ops + their data model.** b-2
(separate spec) adds source-linked staleness + `ledger memory audit` on top; the
"Forward-pins for b-2" section here fixes the cross-cycle decisions so b-2 needs
no migration and hits no shipped-code collisions.

Source of truth for concepts: `docs/design/specs/2026-07-03-undertow-integration-decision.md`,
spec §5.2 / §7 / §8, build-prompts Prompt 10.5. Baseline: `main` @ `b29f9a4`,
518 pass / 1 skip.

---

## 1. Data model

### 1.1 `memory_relations` table (new)
```
memory_id TEXT NOT NULL   -- the distillation
source_id TEXT NOT NULL   -- a cited source memory id
kind      TEXT NOT NULL   -- "distilled"
PRIMARY KEY (memory_id, source_id, kind)
```
Plus `CREATE INDEX ix_memory_relations_source ON memory_relations(source_id)` —
b-2's staleness detection answers "which distillations cite source S?" by this
index. **Rebuildable from the vault** (disposable-index principle, like the whole
journal): `reindex` parses each note's `ledger.derivation.sources` and
repopulates the table, so a journal wipe loses nothing. No baseline-revision
column is stored — detection is **event-driven** (see §6), so relations only need
the (distillation → source) mapping.

### 1.2 Frontmatter (`ledger:` block) extensions
```yaml
ledger:
  # ...existing (id, status, created, source, reason, confidence, supersedes, expires)...
  derivation:              # ONLY on distillations
    kind: distilled
    sources: [mem_x, mem_y]
  retired_reason: "..."     # ONLY when status == retired
  superseded_by: mem_z      # OPTIONAL, only when retired
  score: 0.82               # OPTIONAL numeric evidence (see §5)
```

### 1.3 Status enum + schema
- `MemoryStatus` gains **`retired`** (currently `scratch|working|canonical|forgotten|reverted`).
- `MemoryProvenance` (zod) extended with optional `derivation` (`{kind: "distilled", sources: string[]}`), `retired_reason` (string), `superseded_by` (string, nullable), `score` (number).
- `DEAD_STATUSES` / recall + matcher liveness: `retired` is NOT live (excluded from contradiction comparison sets and from default recall), alongside `forgotten`/`reverted`. (This is what makes the retire-then-remember laundering channel safe: canonical→retired is approval-gated, so a human signed off before the belief left the comparison set.)

---

## 2. `memory_distill(content, sources[], reason, session, entity?, confidence?, score?)`

A **create** op into the agent zone whose `ledger:` block carries the
`derivation` block. Discriminated-union op variant; full broker pipeline (zone,
lint, commit, journal) applies.

- **Source validation:** every `source` id must exist in the journal AND not be
  `forgotten`. **Retired sources ARE citable** (retired = history, still real; only
  `forgotten` = suppressed). An invalid/missing/forgotten source → a typed
  rejection (`INVALID_SOURCE`, retriable:false) before anything is written — no
  partial note, no relations.
- On success: write the note (mirrors `remember`, incl. the leading-frontmatter
  strip + top-level entity/tags persistence), THEN insert one `memory_relations`
  row per source (`memory_id` = new id, `source_id`, `kind:"distilled"`).
- **Undo compensation:** undoing the distill's create transaction removes the
  memory's `memory_relations` rows (they're rebuildable from the file, which the
  revert deletes, but the journal index is cleaned proactively too).

**Tests:** distill with all-valid sources → note has the derivation block,
relations rows exist, one per source; a missing source → `INVALID_SOURCE`, nothing
written; a `forgotten` source → `INVALID_SOURCE`; a `retired` source → allowed;
undo of the distill removes the relations rows; reindex rebuilds relations from
`derivation.sources`.

---

## 3. `memory_retire(id, reason, superseded_by?, session)`

A minimal **metadata patch** — flip `status → retired`, write `retired_reason`
(+ optional `superseded_by`) into the `ledger:` block, never appended prose.
Mirrors `flipFrontmatterStatus` (an approved frontmatter-editing revise).

### 3.1 Transition table (decided)
| from | to `retired` |
|---|---|
| `working` | **immediate** |
| `canonical` | **approval-gated** — enqueue an approval (zone `canonical-retire`), return `{queued, approvalId}`; `Approvals.approve` dispatches the held retire via `store.retire({approved:true})`. Mirrors canonical-forget/revise. |
| `scratch` | `INVALID_TRANSITION` (scratch TTL-archives or is forgotten; retire is for current-knowledge states) |
| `retired` | **idempotent no-op** (returns the retired result; the ONLY idempotent case) |
| `forgotten` / `reverted` | `INVALID_TRANSITION` (NOT a silent no-op — retiring a tombstoned/undone memory is a real error the caller should see) |

### 3.2 `superseded_by` validation
If provided, it MUST reference an existing, non-`forgotten` memory → else a typed
rejection. Rationale: an unvalidated `superseded_by` is a dangling pointer an
agent can use to fake a supersession lineage — the same family as the
`supersedes` validation the matcher relies on. (Pointing at a `retired` memory is
allowed — you can supersede with, or be superseded by, a historical belief.)

**Tests:** working→retired applies (file status flips, `retired_reason` written);
canonical→retired queues an approval in zone `canonical-retire`, file unchanged,
`approve` applies + `reject` leaves it; scratch→retired and forgotten→retired and
reverted→retired all throw `INVALID_TRANSITION`; retired→retired is an idempotent
no-op; `superseded_by` pointing at a missing/forgotten id → typed rejection;
pointing at a live/retired id → accepted and written.

---

## 4. Recall
Default recall **excludes** `retired` (as it does `forgotten`/`reverted`). An
explicit `status: retired` filter includes them (queryable history). **Test:**
a retired memory is absent from default recall, present under `status: retired`.

---

## 5. Confidence-as-evidence
`remember`/`distill` accept an optional numeric `score`, stored in the `ledger:`
block as `score` alongside the authoritative `confidence` enum. **A test asserts
no lifecycle gate reads it** — promotion/retire/forget/approval decisions are
driven only by status + approval, never by `score`. (Guarded evidence is the
point: because `score` lives in the ledger block, the ledger-guard prevents an
agent quietly rewriting its own recorded confidence — an editable evidence record
would be worthless. See §7.)

---

## 6. Detection is event-driven (why the data model is this shape)
b-2's staleness fires on an **event** — "when a source is retired OR revised, flag
every distillation citing it" (spec §5.2). So b-1 stores only the
(distillation → source) mapping; no per-source baseline revision is needed. The
value that dedups a staleness flag (b-2) is the source's content hash **at the
event**, not a stored baseline. This is stated here so b-1 doesn't over-build the
relations table.

---

## 7. Free invariant (state it + test it): the ledger-guard already covers the new fields
`derivation`, `retired_reason`, `superseded_by`, and `score` all live inside the
`ledger:` block, and `governedProvenanceChanged` (the ledger-guard) compares the
ENTIRE ledger block. So **an unapproved `revise` that forges `derivation.sources`
onto an existing distillation, fakes a `superseded_by`, or rewrites a recorded
`score` is already rejected with `LEDGER_GUARD`** — zero new code. The legitimate
writers (distill = a create; retire = an approved frontmatter revise) are
unaffected. **Test:** an unapproved `memory_revise` that adds/changes
`derivation.sources` / `superseded_by` / `score` on a note → `LEDGER_GUARD`.

---

## Forward-pins for b-2 (design now, build in b-2 — no migration, no collision)

### P1 — stale-source is a new conflict KIND in the existing `conflicts` table
`kind = "stale-source"`, `memory_a` = distillation, `memory_b` = source,
`pair_lo/pair_hi` = sorted(distillation, source), `value_hash` = the source's
content hash at the retire/revise event, `fact_key` = a constant (e.g.
`"source"`). Reuses the just-shipped 5-column unique key
`(pair_lo, pair_hi, kind, fact_key, value_hash)` → WU-2 dedup for free (each new
source revision that triggers → a new row; re-flagging the same revision →
deduped). **No schema change in b-2.**

### P2 — the both-sides-live filter MUST become kind-aware (the one thing that must be fixed in design)
`Conflicts.list("open")` + `GET /conflicts` currently drop any row where EITHER
side's status is in `DEAD_STATUSES` (which includes `retired`). A stale-source
row's defining condition is that its **source side is retired/revised** — so under
the current filter every staleness flag b-2 creates would be **invisible the
moment it's born**, silently, with tests passing (a liveness filter "can't miss a
code path"). **Pin:** liveness becomes kind-aware —
- `value-conflict` / `negation-conflict`: BOTH sides must be live (unchanged).
- `stale-source`: only the **distillation** side (`memory_a`) must be live; a
  retired/revised source is the point. A `forgotten`/`reverted` distillation moots
  the flag.
One paragraph here; one code change + test in b-2.

### P3 — `ledger memory audit` is a state-based scan under the event-driven flags
Event-driven detection (P1) misses the **already-retired-at-distill** case: if an
agent distills citing a source that is already `retired`, the retire event
predates the relation row, so no inline flag ever fires. So b-2's `ledger memory
audit` is a **state-based scan** — enumerate every distillation citing a
currently-`retired` (or since-revised) source, deduped by the same P1 key — layered
UNDER the inline event flags. The scan catches the already-retired case AND
doubles as the recovery path after a journal rebuild.

---

## Process
b-1 is built via subagent-driven-development with the two-stage review, TDD per
task, on branch `feat/v0.3b1-lifecycle-ops`. The two new ops touch the trust
model (new status, new gate, source validation), so `memory_distill`,
`memory_retire`, and the ledger-guard-coverage invariant get an adversarial
code-review pass. Gate: `pnpm build && pnpm -w lint && pnpm test` green; merge;
push. Then brainstorm b-2 (staleness + audit).
