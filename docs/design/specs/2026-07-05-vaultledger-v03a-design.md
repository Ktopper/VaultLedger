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
- `interface ContradictionDetector { detect(a: { text: string }, b: { text: string }): DetectedConflict[] }`
  — the detector takes each memory's note **text** and owns extraction internally
  (it needs the body text for negation-detection, not just extracted facts); the
  v1.1 embedding checker implements the same `detect(text, text)` seam.
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

1. **Same entity.** Candidates share `M`'s `entity` (the journal `memories.entity`
   column / frontmatter `entity` field, matched **exactly** after
   case/whitespace-fold). v0.3a is **entity-field-exact only** — alias, heading,
   and full-text matching are **deferred** (alias-matching needs an `aliases`
   field on the provenance schema + a `memories` column + reindex extraction,
   which v0.3a does not add; it lands with v0.3b or v1.1). The `EntityMatcher`
   interface is written so those drop in without restructuring `check.ts`.
2. **Live only.** Exclude any candidate whose status is `forgotten`, `reverted`,
   or `retired` — a contradiction with a dead belief isn't actionable. Only
   `canonical` and `working` memories are compared against (scratch is provisional
   and not worth flagging). (`retired` is a v0.3b status; filtering for it now is
   deliberate forward-compat — the journal stores status as free text, so no enum
   change is needed in v0.3a and none should be made.)
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
- **dates** → parsed to ISO (`August 15, 2026`, `2026-08-15`, `2026/08/15` all →
  `2026-08-15`) — but ONLY unambiguous forms: month-name dates with a year, and
  **year-first** `yyyy[-/]mm[-/]dd`. An **ambiguous** `d/d/yyyy` slash-date (M/D vs
  D/M unknown) → **unparseable**, and a date-shaped value with **no year** →
  unparseable. Date parsing is deterministic (a month-name table, never
  `new Date(str)`); a `yyyy-mm-dd` frontmatter scalar that YAML coerces to a
  `Date` is rendered UTC-invariantly.
- **numbers** → canonical numeric after stripping commas and a leading/trailing
  currency symbol (`$€£¥`), so `$1,000` and `$1000.00` compare equal.
- **strings** → `NFC`-normalized, case+whitespace-folded, trailing sentence
  punctuation (`.,;:!?`) stripped, so `Alice.` == `Alice` and NFC/NFD forms of
  the same word compare equal.

**Uncertainty loses to precision:** if a value can't be parsed to a comparable
canonical form (ambiguous slash-date, date with no year, mixed types), it is
marked *unparseable* and **never produces a flag**. A pair is only ever compared
when both sides canonicalize to the **same comparable type**. (Entity matching is
likewise folded — `foldEntity`: case + whitespace — so `Nova`/`nova` are the same
entity.)

### 3.3 The two signals

`detect(a, b)` (both already lineage-filtered and same-entity) emits:
1. **`value-conflict` (primary):** the same key appears in both `a` and `b` with
   canonical values of the same type that **differ** (`deadline: 2026-08-15 vs
   2026-09-01`). Unparseable or type-mismatched values are skipped, never flagged.
2. **`negation-conflict` (secondary, narrow):** one memory asserts
   `<subject> is <X>` and the other `<subject> is not/no longer/isn't <X>`, where
   subject and `X` match after normalization. Kept intentionally narrow (exact
   normalized subject+predicate) to hold the precision line.

Each detected conflict carries a **`fact_key`** identifying the specific
contradicted fact — for a `value-conflict` the normalized attribute key
(`deadline`), for a `negation-conflict` the normalized subject+predicate. This is
what keeps two distinct contradictions on the same memory pair as **two separate,
independently resolvable items** rather than collapsing to one (§4.2). Each also
carries a human-readable `detail` (e.g. `deadline: "2026-08-15" vs "2026-09-01"`).

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
gains `entity`, `detail`, `resolved_at`, **`fact_key`**, and an **order-normalized
pair key** (`pair_lo`, `pair_hi` = the two memory ids sorted) via a lightweight
`openJournal` migration (read `pragma table_info`; `ALTER TABLE ADD COLUMN` for
any missing — safe because the table is empty in every existing journal).
`state ∈ {open, resolved, dismissed}`. (An earlier draft also had `moot`,
proactively set by undo/forget — removed, see §4.3.)

**Dedup is a DB constraint, across ALL states, not an app-level check-then-insert**
(the same medicine as the `UNIQUE(commit_sha)` hardening in §8, and for the same
race class): a **`UNIQUE(pair_lo, pair_hi, kind, fact_key)`** index, with inserts
using `ON CONFLICT DO NOTHING`. Including **`fact_key`** in the key is deliberate:
two memories can contradict on more than one fact (e.g. both `deadline` *and*
`status`), and each must be its **own** resolvable item — a bare
`(pair_lo,pair_hi,kind)` key would keep the first and silently drop the rest,
hiding real contradictions. The key spans every state — so a **dismissed**
conflict (that exact pair+kind+fact) is *not* resurrected by a later re-detection
or `--rescan`; dismissal is permanent per fact. (Re-opening is a deliberate future
action, not an accident.)

### 4.3 Zombie conflicts never accumulate — the both-sides-live filter is the SOLE mechanism

A conflict referencing a memory that later dies (undone / forgotten / reverted /
retired) is no longer actionable, and `Conflicts.list("open")` (and `GET
/conflicts`) is solely responsible for keeping it hidden: it returns only
conflicts where **both** referenced memories are still live (status not
`forgotten`/`reverted`/`retired`). This can't miss a code path, so no zombie is
ever *shown* — and a memory dying (forget, or undoing its originating create)
hides its conflicts automatically, with no separate bookkeeping required.

An earlier draft had undo's compensation and `forget` **additionally** mark any
`open` conflict referencing the touched memory `moot` ("close on death,
belt-and-suspenders"). This was removed: `undoTransaction`'s memory_id-keyed
moot call fired for **any** undone transaction on that memory, not just one that
actually killed it — undoing an unrelated revise (memory stays fully live)
mooted a genuinely still-valid conflict anyway. Because moot was folded into
the all-states dedup key, that false-moot was **permanent**: a later re-detect
of the exact same contradiction could never reopen it (the dedup key was
already occupied by the moot row). The both-sides-live filter alone is correct
and total: it hides a conflict exactly when a referenced memory is dead, and
un-hides it again the moment that memory is live again (e.g. undoing the
forget) — no permanent-hide failure mode, and no redundant state to keep in
sync with `Conflicts.list`'s own logic.

**Forgetting a `canonical` belief requires approval.** An unapproved
`memory_forget` on a canonical memory would otherwise be an approval-free way
to make it disappear (and drop out of the contradiction matcher's comparison
set) — the same evasion class already closed for `supersedes` (§3.1). So
`MemoryStore.forget` gates exactly like `promote`'s working→canonical
transition: a forget on a `canonical` memory enqueues a `held_operation:
{op:"forget", id, reason, session}` approval (zone `canonical-forget`) and
returns `{queued:true, approvalId}` **without** touching the file or the
journal row — the belief stays canonical and live until a human approves.
`Approvals.approve` dispatches a held `forget` via
`MemoryStore.forget(input, {approved:true})`, which bypasses the gate and runs
the normal tombstone (frontmatter flip + archive move + journal update).
Rejecting simply leaves the belief canonical and un-archived. Scratch/working
forgets (and the TTL sweep, which only ever targets `scratch`) are unaffected
and still apply immediately.

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
  - `matcher`: same-entity (exact) matching; **excludes supersedes-chain pairs**
    (transitive, both directions), forgotten/reverted/retired, and scratch; a
    lineage-linked revise produces **no** candidate.
  - `detector`: value-conflict + narrow negation flagged; `Aug 15` vs `2026-08-15`,
    unparseable prose, and type-mismatches **not** flagged (precision guards).
  - `check`: post-commit hook queues a conflict for a true contradiction; a
    revise-that-supersedes queues **nothing**; detection error doesn't fail the
    write; canonical row unchanged. **Explicit `scratch`-vs-`canonical` fixture:**
    a `remember` (lands at scratch) that contradicts an existing canonical memory
    IS flagged — that's the core "new claim vs existing belief" case.
  - **multi-fact fixture:** one memory pair contradicting on **two** keys
    (`deadline` + `status`) produces **two** separate conflict rows (distinct
    `fact_key`), both surfaced and independently resolvable.
  - dedup: re-running detection / `--rescan` doesn't duplicate; a **dismissed**
    conflict is not resurrected (all-states key, per fact).
  - both-sides-live filter: `list` excludes conflicts whose side was
    forgotten/undone; an undo of an UNRELATED transaction on an otherwise-live
    memory does NOT hide its still-open conflicts; a conflict hidden by
    forget reappears in `list("open")` once the forget is undone (no
    permanent hide).
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

**v0.3b patch backlog (post-v0.3a-merge review — none blocking, low severity):**
- ~~**Governance: gate/approve `forget` of a live `canonical` belief.**~~ SHIPPED
  (see §4.3): `MemoryStore.forget` now queues an approval instead of applying
  when the target is `canonical`, mirroring the working→canonical promotion
  gate exactly.
- ~~**`extract` fact-line precision:** `FACT_LINE_RE` treats any `word: rest` prose
  line as a fact — a bare URL (`https: //…`) parses as key `https` → spurious
  conflicts.~~ SHIPPED: URL-scheme stoplist + skip `//`-leading values in `extract`.
- ~~**Frontmatter timestamps with a time component UTC-shift the date.**~~ SHIPPED:
  a datetime (not a bare `yyyy-mm-dd`) is now `unparseable` (never day-shifted);
  YAML-coerced `Date`s use a non-midnight-UTC proxy to detect a time component.
- ~~**No calendar-validity check** on parsed dates (`2026-02-31` canonicalizes).~~
  SHIPPED: fixed month-length table + leap rule; invalid dates → `unparseable`.
- ~~**The `isn't` negation branch is effectively unreachable.**~~ SHIPPED: the
  negation regex now matches `X isn't Y` as its own alternative (adds a real
  detection; precision unchanged).
- ~~**`resolve` of an already-`dismissed` conflict silently overwrites state.**~~
  SHIPPED: `Conflicts.resolve`/`dismiss` only transition from `open`; a closed
  conflict throws `ALREADY_CLOSED` → the bridge maps it to `409`.
- ~~**`journal.ts` `getAppliedTransactionsByApprovalId` claims an "indexed lookup"
  but there is no index on `approval_id`.**~~ SHIPPED: partial index
  `ix_transactions_approval ON transactions(approval_id) WHERE approval_id IS NOT NULL`.
- ~~**`--rescan` silent 100k truncation.**~~ SHIPPED: named `RESCAN_MEMORY_CAP`,
  a `--limit` override, and a warning when the cap is hit. (The O(n²)-per-entity
  scan itself is left as-is — fine for personal vaults; batching still deferred.)
- ~~**Durable-status tamper residual (status/entity/supersedes rewritable via an
  unapproved `revise` of the `ledger:` block).**~~ SHIPPED (branch
  `fix/v0.3a-ledger-guard`): `Broker.applyRevise` now rejects an UNAPPROVED revise
  whose diff changes the parsed `ledger:` block with `LEDGER_GUARD` (→ bridge 403)
  — closing the whole class (status self-promote, entity rewrite that drops a
  memory from every comparison set, faked supersedes). The only legitimate
  ledger-block writers pass `approved:true` (`flipFrontmatterStatus`, and the
  approval-queue's `dispatchApply` of a human-approved held op). Belt-and-braces:
  `reindex` now FLAGS (never refuses — rebuildability invariant) an out-of-broker
  canonical elevation via `ReindexResult.elevatedToCanonical` + a loud CLI warning.
  Two-step file-tamper→reindex evasion is closed at the write channel. (Review
  follow-up: the guard was extended to cover the TOP-LEVEL `entity` field — it is
  a governed sibling of `ledger:`, not inside it — and renamed
  `governedProvenanceChanged`; `tags` stays excluded as metadata.)

**v0.3b backlog (post-ledger-guard review — two MEDIUMs + LOW nits):**
- **MEDIUM — content-revise of a canonical belief is ungated.** The ledger-guard
  protects the `ledger:` block, but the BODY of a canonical belief can still be
  inverted across 2–3 unapproved revises (the ~50% patch-size cap is iterable).
  Same family, distinct hole. Fix: route a `revise` whose target is `canonical`
  through the approval queue, mirroring the promote/forget gates.
- **MEDIUM — dismiss-once, contradict-forever.** The conflict dedup key
  (`UNIQUE(pair_lo,pair_hi,kind,fact_key)`) omits the conflicting VALUES, so one
  dismissed conflict on a pair+fact permanently swallows every FUTURE
  different-valued contradiction on that same pair+fact (`ON CONFLICT DO NOTHING`
  never re-opens it). Nastier now that the canonical-exception trains users to
  dismiss benign rows. Fix: fold a value-hash into `fact_key` (or the unique key),
  OR re-open a dismissed row when the new `detail` differs.
- **MEDIUM — `entity` is not persisted to the note file (journal-only), so a
  plain `reindex` nulls it for agent-created memories.** `remember`'s
  `matter.stringify` writes only `{ledger:{…}}`; `entity` is passed to the journal
  row but never into the file's top-level frontmatter, yet `reindex` recovers
  entity FROM the file (`parseMemoryNote` reads top-level `entity`). So after any
  journal rebuild, agent-created beliefs lose their entity → drop from every
  same-entity comparison set — no attacker required. (Surfaced by the ledger-guard
  review; independent of the guard, which now correctly protects a file-resident
  entity.) Fix: `remember` should write `entity` into the note's top-level
  frontmatter so it survives reindex, mirroring status/supersedes in `ledger:`.
- **LOW nits:** (a) URL stoplist drops legit `file:`/`tel:` body-fact keys by key
  NAME alone — shape-check the value (`scheme://…`) instead. (b) slash-style
  datetimes aren't covered by the datetime→unparseable guard. (c) matcher
  asymmetry in the canonical-exception (audit both directions of a transitive
  chain). (d) the `isn't` negation misses a curly apostrophe (`isn't`).

**v1.1:** embedding/LLM-assisted contradiction + entity matching (drops into the
`ContradictionDetector` / `EntityMatcher` interfaces).

**Carried:** TOCTOU/symlink-race hardening; byte-identical-outside-hunks lint
(v0.1 §12).
