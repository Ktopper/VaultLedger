# VaultLedger v0.3a — Design (contradiction queue + hardening)

**Date:** 2026-07-05
**Scope:** the first half of milestone v0.3 — **write-time contradiction detection
+ the conflicts queue**, plus three low-risk hardening items carried from the v0.2
final review. Build-prompts Prompt 10; spec §5.4.
**Parent spec:** `spec.md` (v1.1) and the v0.1/v0.2 designs. Where this doc is
silent, those govern.
**Builds on:** the shipped v0.2 (core broker + WAL journal + cross-process lock +
`ledger serve` bridge + Obsidian plugin).

> **Milestone split (bookkeeping).** `spec.md` §8 defines v0.3 as "lifecycle +
> audit — absorbs Undertow": `memory_distill`, `memory_retire`, a source-relations
> table, source-linked staleness, optional numeric confidence, promotion rules,
> and a memory-health report / `ledger memory audit`. This cycle deliberately
> ships only the **contradiction queue + hardening** and labels itself **v0.3a**.
> Everything else moves to **v0.3b (the Undertow merge, build-prompts Prompt
> 10.5)** — see §9. The v0.3a contradiction matcher is designed **lineage-aware**
> (§3.1) precisely because v0.3b's source-linked staleness depends on the same
> lineage model.

---

## 1. Goal & scope

Turn VaultLedger from *governing* writes to *protecting truth*: when an agent
writes a claim that contradicts an existing belief on the same entity, surface it
for human resolution instead of letting memory silently drift — **canonical is
never silently contradicted** (spec §5.4).

**In scope (v0.3a):**
- A core **contradiction engine** — a deterministic, precision-first heuristic
  behind a pluggable interface (an embedding/LLM checker drops in at v1.1).
- A **conflicts queue** — populate the existing (empty) `conflicts` table; a
  `Conflicts` core API (list / resolve / dismiss).
- **Surfacing** end-to-end: `ledger conflicts`, bridge `GET /conflicts` (+ resolve/
  dismiss), and the plugin's already-scaffolded Conflicts tab.
- **Three hardening items** from the v0.2 backlog (§8).

**Out of scope → v0.3b (§9):** distill/retire, the `memory_relations` table,
source-linked staleness, numeric confidence, promotion-rule automation, the
memory-health report. **Out of scope → v1.1:** embedding/LLM-assisted detection.

---

## 2. Architecture

```
packages/core/src/
├── contradiction/
│   ├── detector.ts   # ContradictionDetector interface + v0.3a deterministic impl
│   ├── extract.ts    # pull normalized {key -> canonical value} facts from a memory
│   ├── matcher.ts    # EntityMatcher: the lineage-aware, live-only comparison set
│   └── check.ts      # checkContradictions(journal, memId): detect + queue (post-commit)
├── conflicts/
│   └── queue.ts      # Conflicts: list/get/resolve/dismiss over the conflicts table
├── memory/store.ts   # MODIFY: remember/revise call checkContradictions after commit
└── journal/db.ts     # MODIFY: conflicts schema migration + UNIQUE indexes (§4, §8)
```

Pluggable by construction:
- `interface ContradictionDetector { detect(a: MemoryFacts, b: MemoryFacts): Conflict[] }`
- `interface EntityMatcher { comparisonSet(mem: MemoryRow, journal): MemoryRow[] }`

v0.3a ships deterministic implementations; v1.1 swaps in embeddings without
touching `check.ts` or its callers. `packages/server` / `cli` / `obsidian-plugin`
gain thin conflict surfacing.

---

## 3. The detection heuristic (precision-first)

**Principle:** favor **precision over recall**. A conflict queue full of false
positives is worse than one that misses some — a noisy queue gets ignored, which
defeats the feature. Every rule below is tuned to *not flag when uncertain*.

### 3.1 The comparison set (EntityMatcher) — lineage-aware, live-only

For a memory `M`, the set of memories it is checked against is built by
`comparisonSet(M, journal)` and is deliberately narrow:

1. **Same entity.** Candidates share `M`'s `entity` (frontmatter `entity` field,
   exact after case/whitespace-fold), or a shared `aliases` entry. (Heading/full-
   text matching is deferred; the interface allows it later.)
2. **Live only.** Exclude any candidate whose status is `forgotten`, `reverted`,
   or `retired` — a contradiction with a dead belief isn't actionable. Only
   `canonical` and `working` memories are compared against (scratch is provisional
   and not worth flagging).
3. **Not lineage-linked (the single biggest false-positive guard).** Exclude any
   candidate related to `M` by lineage, because those value changes are
   *intentional*, not contradictions:
   - **supersedes chain:** exclude anything `M` supersedes or that supersedes `M`,
     followed transitively in both directions (a `revise` sets
     `new.supersedes = old`, so the updated memory legitimately differs from the
     one it replaced).
   - **derivation/distill links (v0.3b hook):** when the `memory_relations` table
     lands in v0.3b, exclude candidates joined to `M` by a derivation/source
     relation. v0.3a builds the exclusion as a pluggable set so v0.3b only adds a
     source; nothing in `matcher.ts` restructures.

This lineage-awareness is a shared dependency with v0.3b's source-linked staleness
(Prompt 10.5), which is why it's designed in now.

### 3.2 Value normalization (extract.ts) — canonical or don't flag

`extract(memory)` produces `MemoryFacts` = a map of `key -> CanonicalValue`. Keys
come from non-`ledger` frontmatter fields plus `key: value` / `**key:** value`
lines in the body. Each value is normalized to a canonical, *typed* form:
- **dates** → parsed to ISO (`Aug 15`, `August 15, 2026`, `2026-08-15` all →
  `2026-08-15` when a year is determinable);
- **numbers** → canonical numeric (strip units/commas where unambiguous);
- **strings** → case/whitespace-folded.

**Uncertainty loses to precision:** if a value can't be parsed to a comparable
canonical form (free prose, ambiguous date with no year, mixed types), it is
marked *unparseable* and **never produces a flag**. A pair is only ever compared
when both sides canonicalize to the **same comparable type**.

### 3.3 The two signals

`detect(a, b)` (both already lineage-filtered and same-entity) emits:
1. **`value-conflict` (primary):** the same key appears in both `a` and `b` with
   canonical values of the same type that **differ** (`deadline: 2026-08-15 vs
   2026-09-01`). Unparseable or type-mismatched values are skipped, never flagged.
2. **`negation-conflict` (secondary, narrow):** one memory asserts
   `<subject> is <X>` and the other `<subject> is not/no longer/isn't <X>`, where
   subject and `X` match after normalization. Kept intentionally narrow (exact
   normalized subject+predicate) to hold the precision line.

Each detected conflict carries a human-readable `detail`
(e.g. `deadline: "2026-08-15" vs "2026-09-01"`).

Fully deterministic; unit-tested with fixture pairs: true contradictions flagged;
lineage-linked updates, unrelated memories, and compatible/near-miss pairs
(`Aug 15` vs `2026-08-15`; unparseable prose) **not** flagged.

---

## 4. The conflicts queue, hook & schema

### 4.1 Hook — non-blocking, post-commit, lock-free

`MemoryStore.remember` and `revise` call `checkContradictions(journal, memId)`
**after** the broker write has committed. It only **reads** memories and **writes
`conflicts` rows** — no vault/Git mutation — so it needs the journal only, **not
the vault lock**. It is **non-blocking**: wrapped so a detection error is caught +
logged and never fails the underlying write (the write already succeeded and is
the source of truth). **Canonical memories are never modified** — the whole point.

### 4.2 Schema migration + dedup enforced in the DB

The v0.1 `conflicts` table (`id, memory_a, memory_b, kind, created_at, state`)
gains `entity`, `detail`, `resolved_at`, and an **order-normalized pair key**
(`pair_lo`, `pair_hi` = the two memory ids sorted) via a lightweight `openJournal`
migration (read `pragma table_info`; `ALTER TABLE ADD COLUMN` for any missing —
safe because the table is empty in every existing journal). `state ∈ {open,
resolved, dismissed, moot}`.

**Dedup is a DB constraint, across ALL states, not an app-level check-then-insert**
(the same medicine as the `UNIQUE(commit_sha)` hardening in §8, and for the same
race class): a **`UNIQUE(pair_lo, pair_hi, kind)`** index, with inserts using
`ON CONFLICT DO NOTHING`. The key spans every state — so a **dismissed** conflict
is *not* resurrected by a later re-detection or `--rescan`; dismissal is
permanent. (Re-opening is a deliberate future action, not an accident.)

### 4.3 Moot conflicts never accumulate as zombies

A conflict referencing a memory that later dies (undone / forgotten / reverted /
retired) is no longer actionable. Two defenses, belt-and-suspenders:
- **Guarantee — `list()` filters to both-sides-live:** `Conflicts.list("open")`
  (and `GET /conflicts`) returns only conflicts where **both** referenced memories
  are still live (status not `forgotten`/`reverted`/`retired`). This can't miss a
  code path, so no zombie is ever *shown*.
- **Tidiness — close on death:** the existing undo-compensation and `forget` paths
  (which already touch the journal) additionally mark referencing `open` conflicts
  `moot`, so the stored rows stay honest for audit.

### 4.4 `Conflicts` API

`list(state?)`, `get(id)`, `resolve(id)`, `dismiss(id)`. Resolution just **closes
the item** (`resolved`/`dismissed`, stamps `resolved_at`); v0.3a does **not**
auto-edit memories on resolve — the human makes any actual edits via normal broker
ops (e.g. `forget` the loser). Conflicts are **derived, not source-of-truth**:
`reindex`/`reconcile` don't rebuild them; a `ledger conflicts --rescan` re-runs
detection across the agent zone on demand (respecting the all-states dedup).

---

## 5. Surfacing (CLI, bridge, plugin)

- **CLI:** `ledger conflicts` (list open, showing both memories, kind, detail);
  `ledger conflicts resolve <id>` / `dismiss <id>`; `ledger conflicts --rescan`.
- **Bridge:** `GET /conflicts` now returns open, both-sides-live conflicts enriched
  with each memory's provenance + the `detail`; `POST /conflicts/:id/resolve` and
  `/dismiss`. Journal-only → lock-free. Same auth/loopback guard + error mapping as
  every other route.
- **Plugin:** wire the existing Conflicts tab — list conflicts with both sides +
  the contradiction detail + Resolve/Dismiss buttons, via the existing XSS-safe
  render helpers (a new `renderConflict` pure helper, hostile-fixture tested).

---

## 6. The three hardening items (v0.2 backlog)

- **`UNIQUE(commit_sha)` on `transactions`** (partial: where `commit_sha` is not
  null) + `reconcile`/`reindex` transaction inserts use `ON CONFLICT DO NOTHING`,
  so the cross-process empty-journal reindex race converges at the DB level
  (closes the v0.2 §3 accepted-limitation note).
- **Approval-vs-transaction reconcile cross-check:** `reconcile` detects an
  approval still `pending` whose held op already has a matching applied
  transaction (the approve→apply crash gap) and closes the stale approval.
- **`bodyLimit` on the bridge's mutation routes** (`/undo`, `/approvals/:id/*`,
  `/conflicts/:id/*`) — a small explicit cap, defense-in-depth against oversized
  request bodies; oversized → a clean 413, not a hang.

---

## 7. Error handling & invariants

- Detection failure never fails a write (caught + logged; the write stands).
- Canonical memories are never mutated by detection.
- All conflict inserts go through the `UNIQUE(pair_lo,pair_hi,kind)` +
  `ON CONFLICT DO NOTHING` path — no duplicate rows, ever, across all states.
- Conflict surfacing is journal-only and lock-free; the vault lock is untouched.
- `BrokerError` → HTTP mapping and the bridge auth/loopback guard apply unchanged.

---

## 8. Testing

- **Core (the bulk):**
  - `extract`: date/number/string normalization; unparseable → not comparable.
  - `matcher`: same-entity + alias matching; **excludes supersedes-chain pairs**
    (transitive), forgotten/reverted/retired, and scratch; a lineage-linked
    revise produces **no** candidate.
  - `detector`: value-conflict + narrow negation flagged; `Aug 15` vs `2026-08-15`,
    unparseable prose, and type-mismatches **not** flagged (precision guards).
  - `check`: post-commit hook queues a conflict for a true contradiction; a
    revise-that-supersedes queues **nothing**; detection error doesn't fail the
    write; canonical row unchanged.
  - dedup: re-running detection / `--rescan` doesn't duplicate; a **dismissed**
    conflict is not resurrected (all-states key).
  - moot: `list` excludes conflicts whose side was forgotten/undone; undo/forget
    marks referencing conflicts `moot`.
  - hardening: `UNIQUE(commit_sha)` convergence (concurrent reindex → no dup txn
    rows); reconcile closes a stale pending approval; migration is idempotent.
- **Server:** `/conflicts` populated shape; resolve/dismiss; both-sides-live
  filter; `bodyLimit` → 413.
- **Plugin:** `BridgeClient` conflict methods (against a live bridge) + a
  `renderConflict` hostile-fixture XSS test; tab glue manual (SMOKE.md).
- **Gate:** `pnpm build && pnpm lint && pnpm test` stays green; additive.

---

## 9. Deferred

**v0.3b — the Undertow merge (build-prompts Prompt 10.5):**
- `memory_distill(content, sources[], reason, session)` — create with
  `derivation: {kind: distilled, sources}` provenance; validate sources exist +
  not forgotten; a new **`memory_relations`** table `(memory_id, source_id, kind)`.
- `memory_retire(id, reason, superseded_by?)` — status flip to `retired`
  (+ `retired_reason`, optional `superseded_by`); excluded from default recall.
- **Source-linked staleness:** when a source is retired/revised, flag every
  distillation listing it as a source — **reuses the v0.3a lineage model.**
- Optional numeric **confidence** score (stored, never read by a lifecycle gate).
- **Promotion-rule automation** and the **memory-health report / `ledger memory
  audit`** (spec §8).

**v1.1:** embedding/LLM-assisted contradiction + entity matching (drops into the
`ContradictionDetector` / `EntityMatcher` interfaces).

**Carried:** TOCTOU/symlink-race hardening; byte-identical-outside-hunks lint
(v0.1 §12).
