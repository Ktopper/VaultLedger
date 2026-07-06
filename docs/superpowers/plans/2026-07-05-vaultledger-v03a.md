# VaultLedger v0.3a Implementation Plan — contradiction queue + hardening

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add write-time contradiction detection (a deterministic, precision-first, lineage-aware heuristic) that populates a conflicts queue surfaced through CLI → bridge → plugin, plus three v0.2-backlog hardening items.

**Architecture:** A new `core/contradiction/` engine (extract → match → detect → check) runs post-commit inside `MemoryStore.remember`/`revise` (non-blocking, journal-only, lock-free). Conflicts land in the existing `conflicts` table (migrated to add `fact_key`/`detail`/pair-key + a `UNIQUE(pair_lo,pair_hi,kind,fact_key)` dedup index) and are exposed by a `Conflicts` core API, then surfaced by the CLI, the fastify bridge, and the Obsidian plugin. Three hardening items harden the journal/reconcile/bridge.

**Tech Stack:** TypeScript (strict, ESM, project refs), pnpm, vitest, better-sqlite3, the existing `@vaultledger/core`/`server`/`cli`/`obsidian-plugin`.

**Reference:** Spec `docs/superpowers/specs/2026-07-05-vaultledger-v03a-design.md` (read it; §N below refer to it). Builds on shipped v0.2. Branch: `feat/v0.3a-contradiction-queue`.

**Applies throughout:** REQUIRED per task: superpowers:test-driven-development. Explicit-path git staging only (never `git add -A` — repo nests in a shared repo). Do NOT `git push` from task subagents. `.js` import extensions (NodeNext). Inject clock/id in tests (no `Date.now`/`Math.random` in `src`; `Date.parse` is fine for parsing given values). Temp vaults + temp HOME (inject `env`); clean up. Gate after each unit: `pnpm build && pnpm -w lint && pnpm test` stays green.

---

## File Structure

```
packages/core/src/
├── contradiction/
│   ├── extract.ts    # NEW: extract(memoryFileText) -> MemoryFacts {key -> CanonicalValue}
│   ├── detector.ts   # NEW: ContradictionDetector iface + HeuristicDetector (value + negation)
│   ├── matcher.ts    # NEW: EntityMatcher iface + comparisonSet (same-entity, live, non-lineage)
│   └── check.ts      # NEW: checkContradictions(deps, memId): detect + queue (post-commit)
├── conflicts/
│   └── queue.ts      # NEW: Conflicts class (list/get/resolve/dismiss) + ConflictRow type
├── journal/
│   ├── db.ts         # MODIFY: conflicts migration (+cols, +UNIQUE index); UNIQUE(commit_sha)
│   └── journal.ts    # MODIFY: conflict row insert (ON CONFLICT DO NOTHING) + query helpers; markConflictsMoot
├── memory/store.ts   # MODIFY: remember/revise call checkContradictions post-commit
├── broker/undo.ts    # MODIFY: undo compensation marks referencing conflicts moot
├── broker/reconcile.ts # MODIFY: approval cross-check via sound approval_id link; ON CONFLICT DO NOTHING inserts
└── index.ts          # export contradiction + conflicts surface

packages/server/src/app.ts   # MODIFY: GET /conflicts (populated), POST /conflicts/:id/{resolve,dismiss}; bodyLimit
packages/cli/src/commands/conflicts.ts  # NEW: ledger conflicts [resolve|dismiss <id>] [--rescan]
packages/cli/src/index.ts               # MODIFY: register `conflicts`
packages/obsidian-plugin/src/render.ts        # MODIFY: renderConflict pure helper (XSS-safe)
packages/obsidian-plugin/src/bridgeClient.ts  # MODIFY: resolveConflict/dismissConflict methods
packages/obsidian-plugin/src/views/activity.ts # MODIFY: wire the Conflicts tab
```

---

## Phase 1 — Core: value extraction

### Task 1.1: `extract` — normalized facts from a memory

**Files:** Create `packages/core/src/contradiction/extract.ts`; Test `packages/core/test/contradiction/extract.test.ts`.

Read `packages/core/src/schemas/provenance.ts` (frontmatter shape) and how `gray-matter` is used in `memory/store.ts`/`broker/lint.ts` first.

Types + behavior:
```ts
export type CanonicalValue =
  | { type: "date"; value: string }      // ISO yyyy-mm-dd
  | { type: "number"; value: number }
  | { type: "string"; value: string }    // case+whitespace folded
  | { type: "unparseable"; raw: string }; // never compared
export type MemoryFacts = Map<string, CanonicalValue>; // key (folded) -> value

export function canonicalize(raw: string): CanonicalValue;   // dates/numbers/strings/unparseable
export function extract(noteText: string): MemoryFacts;      // frontmatter (non-ledger) + body key:value lines
```
- `canonicalize`: try date (parse `Aug 15 2026`, `August 15, 2026`, `2026-08-15` → `{date, "2026-08-15"}`; a date with NO determinable year → `unparseable`); else number (`"42"`, `"1,000"`, `"3.5"` → `{number}`; strip a trailing unit only when unambiguous — keep it simple: `parseFloat` after stripping commas, and REQUIRE the whole trimmed string be numeric else not a number); else a plain scalar string → `{string, folded}`. Free prose / mixed → treat as `{string}` but the DETECTOR only flags when keys match, so prose under a differing key won't false-flag; genuinely ambiguous single values with no key aren't facts at all.
- `extract`: parse frontmatter with gray-matter; take every top-level key EXCEPT `ledger`; canonicalize each scalar value (skip arrays/objects for v0.3a). From the body, match lines `^\s*(?:\*\*)?([A-Za-z][\w \-]*?)(?:\*\*)?\s*[:：]\s*(.+?)\s*$` → key/value, canonicalize the value. Fold keys (lowercase, collapse whitespace). On duplicate keys, first wins. Return the map.
- [ ] **Step 1: Failing tests** — `canonicalize("Aug 15, 2026")`, `"August 15, 2026"`, `"2026-08-15"` all → `{type:"date", value:"2026-08-15"}`; `"Aug 15"` (no year) → unparseable; `"1,000"` → `{number,1000}`; `"Shipping"` → `{string,"shipping"}`. `extract` of a note with frontmatter `deadline: 2026-08-15\nstatus: shipping` + body `**owner:** Alice` → facts has `deadline`(date), `status`(string shipping), `owner`(string alice), and NOT `ledger`.
- [ ] **Step 2: FAIL** — `pnpm -C packages/core test contradiction/extract`
- [ ] **Step 3: Implement** extract.ts.
- [ ] **Step 4: PASS.** **Step 5: Commit** `feat(core): contradiction fact extraction + value canonicalization`

---

## Phase 2 — Core: detector

### Task 2.1: `HeuristicDetector` — value-conflict + narrow negation

**Files:** Create `packages/core/src/contradiction/detector.ts`; Test alongside.

```ts
export type ConflictKind = "value-conflict" | "negation-conflict";
export interface DetectedConflict { kind: ConflictKind; factKey: string; detail: string; }
export interface ContradictionDetector {
  detect(a: { text: string }, b: { text: string }): DetectedConflict[];
}
export class HeuristicDetector implements ContradictionDetector { /* ... */ }
```
- value-conflict: `extract` both; for each key present in both with `type !== "unparseable"` AND same `type` AND differing `value` → a conflict `{kind:"value-conflict", factKey:key, detail:`${key}: "${aVal}" vs "${bVal}"`}`. Skip unparseable or type-mismatched.
- negation-conflict: a narrow, deterministic check over body sentences. Normalize each memory's body into simple `subject|predicate|object` statements matching `^(.+?)\s+is\s+(not\s+|no longer\s+|isn't\s+)?(.+)$` (folded). If A has `(subj, ∅, X)` and B has `(subj, negated, X)` (same folded subj + X) → `{kind:"negation-conflict", factKey:`${subj}::${X}`, detail:`"${subj} is ${X}" vs negated`}`. Keep it to exact normalized subject+object; do NOT try fuzzy matching (precision).
- [ ] **Step 1: Failing tests (fixtures):**
  - value: A `deadline: 2026-08-15`, B `deadline: 2026-09-01` → one value-conflict, factKey `deadline`.
  - **near-miss NOT flagged:** A `deadline: Aug 15, 2026`, B `deadline: 2026-08-15` → **no** conflict (both canonicalize equal).
  - unparseable NOT flagged: A `note: some prose`, B `note: other prose` → no conflict (strings differ but... actually these ARE both strings and differ → they'd flag; so use a case where value is unparseable, e.g. A `when: soon`, B `when: later` are strings and differ → THAT would flag. To test "unparseable never flags", use a value that canonicalizes unparseable, e.g. a date with no year: A `due: Aug 15`, B `due: Sep 1` → both unparseable → NO flag). Assert no conflict.
  - type-mismatch NOT flagged: A `size: 10`, B `size: large` → number vs string → no flag.
  - **multi-fact:** A `deadline: 2026-08-15\nstatus: shipping`, B `deadline: 2026-09-01\nstatus: blocked` → **two** conflicts, factKeys `deadline` and `status`.
  - negation: A body `The project is active`, B body `The project is not active` → one negation-conflict; A `is active` / B `is delayed` (different object) → NO negation-conflict.
- [ ] **Steps 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(core): heuristic contradiction detector (value + negation)`

---

## Phase 3 — Core: matcher (lineage-aware, live-only)

### Task 3.1: `comparisonSet` — same-entity, live, non-lineage

**Files:** Create `packages/core/src/contradiction/matcher.ts`; Test alongside.

Read `journal/journal.ts` (`queryMemories`, `getMemory`, `MemoryRow` — has `entity`, `status`, `supersedes`, `path`) first.

```ts
export interface EntityMatcher { comparisonSet(mem: MemoryRow, journal: Journal): MemoryRow[]; }
export class DefaultEntityMatcher implements EntityMatcher { /* ... */ }
```
- Same entity: `journal.queryMemories({ entity: mem.entity, limit: <high, e.g. 10000> })` (exact; pass an explicit high limit — the default limit is 100, and the lineage walk must see ALL same-entity memories or it could miss a superseding row and re-open a false positive) — if `mem.entity` is null/empty, return `[]` (no entity → no matching). Fold-compare defensively.
- Live only: keep status in {`canonical`,`working`} — drop `scratch`/`forgotten`/`reverted`/`retired` and `mem` itself.
- Non-lineage: build the supersedes chain of `mem` (walk `supersedes` up, and find all memories whose `supersedes` transitively reaches `mem` — i.e. both directions), collect their ids into an exclusion set, drop any candidate in it. Provide the exclusion as a helper `lineageIds(mem, journal): Set<string>` so v0.3b can union derivation ids in.
- [ ] **Step 1: Failing tests:** seed a journal (in-memory) with memories sharing an entity at various statuses + a supersedes chain.
  - returns canonical/working same-entity peers; excludes scratch/forgotten/reverted and `mem` itself.
  - **a memory and the one it supersedes are NOT in each other's set** (the key false-positive guard); test transitive (A←B←C: none pair up).
  - a different-entity memory is excluded; null-entity `mem` → `[]`.
- [ ] **Steps 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(core): lineage-aware entity matcher`

---

## Phase 4 — Core: conflicts store + schema migration

### Task 4.1: conflicts schema migration + journal helpers

**Files:** Modify `packages/core/src/journal/db.ts`, `packages/core/src/journal/journal.ts`; Tests alongside.

- `db.ts`: after the existing `CREATE TABLE IF NOT EXISTS conflicts (...)`, run a migration: read `pragma table_info(conflicts)`; for each missing column of {`entity TEXT`, `detail TEXT`, `fact_key TEXT`, `pair_lo TEXT`, `pair_hi TEXT`, `resolved_at TEXT`} run `ALTER TABLE conflicts ADD COLUMN ...`. Then `CREATE UNIQUE INDEX IF NOT EXISTS ux_conflicts_pair_kind_fact ON conflicts(pair_lo, pair_hi, kind, fact_key)`. (Safe: the table is empty in every existing journal.) Idempotent — re-open twice, no error.
- `journal.ts`: add typed methods:
  - `insertConflict(row): boolean` — computes nothing (caller passes pair_lo/pair_hi normalized); `INSERT ... ON CONFLICT(pair_lo,pair_hi,kind,fact_key) DO NOTHING`; returns whether a row was inserted (changes>0).
  - `listConflicts(state?)`, `getConflict(id)`, `setConflictState(id, state, resolvedAtIso?)`.
  - `markConflictsMoot(memId, nowIso)` — set state 'moot' for `open` conflicts where `memory_a=memId OR memory_b=memId`.
  - `ConflictRow` interface exported.
- [ ] **Step 1: Failing tests:** open (file-backed) → conflicts has the new columns + the unique index (`pragma index_list`); migration idempotent (open twice). insertConflict twice with same pair/kind/fact → second returns false, one row. **dismissed-not-resurrected:** insert a conflict, `setConflictState(id,"dismissed")`, then insertConflict again with the SAME pair/kind/fact → returns false (the unique key spans all states), and the row stays `dismissed` (not re-opened). listConflicts by state; setConflictState; markConflictsMoot flips only open rows referencing the id.
- [ ] **Steps 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(core): conflicts schema migration + journal helpers`

### Task 4.2: `Conflicts` API (both-sides-live filter)

**Files:** Create `packages/core/src/conflicts/queue.ts`; Test alongside.

```ts
export class Conflicts {
  constructor(private journal: Journal) {}
  list(state = "open"): EnrichedConflict[]; // filters to BOTH memories live; attaches both MemoryRows
  get(id): EnrichedConflict | null;
  resolve(id, nowIso): void;  // setConflictState(id,"resolved",now)
  dismiss(id, nowIso): void;  // setConflictState(id,"dismissed",now)
}
```
- `list`: `journal.listConflicts(state)`, then DROP any where either `memory_a`/`memory_b` is missing or its status ∈ {forgotten,reverted,retired} (both-sides-live guarantee, §4.3). Enrich each with both memory rows + provenance for display.
- [ ] **Step 1: Failing tests:** seed conflicts + memories; list returns enriched open conflicts; a conflict whose one side is forgotten is EXCLUDED from list (zombie guard) even if still `open`; resolve/dismiss stamp resolved_at and drop from open list.
- [ ] **Steps 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(core): Conflicts API with both-sides-live filter`

---

## Phase 5 — Core: the check hook + wiring

### Task 5.1: `checkContradictions` — detect + queue, post-commit

**Files:** Create `packages/core/src/contradiction/check.ts`; Test alongside.

```ts
export function checkContradictions(deps: {
  journal: Journal; vaultRoot: string; now: () => string; genId: (p: string) => string;
  matcher?: EntityMatcher; detector?: ContradictionDetector;
}, memId: string): void; // synchronous; reads files + journal, inserts conflict rows
```
- Load `mem = journal.getMemory(memId)` (the NEW/changed memory — it can be scratch/working/canonical; we check IT against its live canonical/working peers). Compute `peers = matcher.comparisonSet(mem, journal)`. Read `mem`'s file text `memText = readFileSync(join(vaultRoot, mem.path), "utf8")`; for each peer read `peerText`, then call **`detector.detect({ text: memText }, { text: peerText })`** — the detector takes TEXT (it owns extraction internally; it needs the body text for negation-detection, not just extracted facts). For each DetectedConflict, normalize the pair `[lo,hi] = [mem.id, peer.id].sort()` and `journal.insertConflict({ id: genId("cf"), memory_a: lo, memory_b: hi, pair_lo: lo, pair_hi: hi, kind, fact_key, entity: mem.entity, detail, created_at: now(), state: "open", resolved_at: null })`.
- WRAP the whole body in try/catch that logs (console.error) and swallows — detection must never throw into the caller (non-blocking, §4.1). File-read of a missing peer/self → skip that pair, don't abort.
- [ ] **Step 1: Failing tests (real journal + temp vault files):**
  - remember-style: create memory A (canonical, entity "nova", `deadline: 2026-08-15` in file) + memory B (scratch, entity "nova", `deadline: 2026-09-01`); `checkContradictions(deps, B.id)` → one open conflict (A,B, value-conflict, deadline). **scratch-vs-canonical explicitly covered here.**
  - a revise-that-supersedes: B.supersedes = A → comparisonSet excludes A → **no** conflict queued.
  - multi-fact: A/B differ on deadline+status → two conflict rows.
  - detection error (e.g. mem.path points nowhere) → no throw, no conflict, write-path unaffected.
- [ ] **Steps 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(core): checkContradictions post-commit hook`

### Task 5.2: wire into MemoryStore.remember/revise

**Files:** Modify `packages/core/src/memory/store.ts`; Tests alongside.

- After `remember`'s broker create + journal insert succeeds, call `checkContradictions({journal, vaultRoot, now, genId}, id)`. Same after `revise` succeeds (the revised memory re-checked). Pass the store's existing now/genId/vaultRoot. Non-blocking (checkContradictions already swallows).
- [ ] **Step 1: Failing test:** through the REAL MemoryStore: remember A (canonical via promote) then remember B contradicting → a conflict is queued (query journal.listConflicts); a normal non-contradicting remember → none; a revise that supersedes → none.
- [ ] **Steps 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(core): remember/revise run contradiction check`

### Task 5.3: undo/forget mark conflicts moot

**Files:** Modify `packages/core/src/broker/undo.ts` and `packages/core/src/memory/store.ts` (forget); Tests alongside.

- In undo compensation (where a memory is marked reverted) and in `MemoryStore.forget` (where status→forgotten), also call `journal.markConflictsMoot(memId, now())`.
- [ ] **Step 1: Failing test:** queue a conflict between A and B; forget A → the conflict is now 'moot' and drops from Conflicts.list("open"); undo of a create that had a conflict → moot.
- [ ] **Steps 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(core): moot conflicts on undo/forget`

### Task 5.4: export + core barrel

- [ ] Export `Conflicts`, `checkContradictions`, `HeuristicDetector`, `DefaultEntityMatcher`, `extract`, types from `core/src/index.ts`. Build + full core suite green. Commit `feat(core): export contradiction + conflicts surface`.

---

## Phase 6 — Hardening (v0.2 backlog)

### Task 6.1: `UNIQUE(commit_sha)` + ON CONFLICT DO NOTHING

**Files:** Modify `packages/core/src/journal/db.ts`, `journal.ts` (recordTransaction), `broker/reconcile.ts`, `memory/reindex.ts`; Tests alongside.

- db.ts: `CREATE UNIQUE INDEX IF NOT EXISTS ux_transactions_commit ON transactions(commit_sha) WHERE commit_sha IS NOT NULL`.
- reconcile/reindex transaction inserts: use `INSERT ... ON CONFLICT(commit_sha) DO NOTHING` (or catch the constraint). Keep normal `recordTransaction` as-is for the broker path (each broker commit has a fresh unique sha).
- [ ] **Step 1: Failing test:** two concurrent reindex/reconcile over the same vault (or insert the same commit_sha twice) → exactly one transaction row, no throw (converges). Migration idempotent.
- [ ] **Steps 2–4:** FAIL → implement → PASS. **Step 5: Commit** `fix(core): UNIQUE(commit_sha) so concurrent reindex converges`

### Task 6.2: reconcile approval-vs-transaction cross-check (SOUND approval_id link)

**Files:** Modify `packages/core/src/journal/db.ts` (+ migration), `packages/core/src/journal/journal.ts`, `packages/core/src/broker/broker.ts`, `packages/core/src/approvals/queue.ts`, `packages/core/src/broker/reconcile.ts`; Tests alongside.

- **Do NOT use a path+time heuristic.** "Same path + a commit after the approval's created_at" is UNSOUND: a same-path DIFFERENT op applied after the approval (e.g. an unrelated direct revise on a note that also has a queued propose_edit) would false-close the approval — marking it `approved` though its OWN patch never applied, corrupting the "every mutation is attributable" audit invariant. hash_before doesn't fix it either (two ops can start from the same state). A false-close is strictly worse than a miss.
- **Sound mechanism — explicit `approval_id` link:** add an `approval_id TEXT` column to `transactions` (both `SCHEMA_SQL` for fresh journals AND a pragma-table_info + ALTER migration for existing ones, mirroring the conflicts-column migration; idempotent). Add `approval_id: string | null` to `TransactionRow` and both inserts (`recordTransaction`, `recordTransactionIfNew`). `Broker.apply(op, opts?)` gains `opts.approvalId?: string`, stamped onto the transaction row it records (create/revise apply paths); unset → null for all direct writes. `Approvals.approve`'s `dispatchApply` passes `{ approved: true, approvalId: approval.id }`, so the transaction produced by applying a held op carries that approval's id.
- **reconcile.closeStaleApprovals:** for each `pending` approval, close it to `approved` (resolved_at now) IFF the journal has an APPLIED transaction whose `approval_id === approval.id` (query via `journal.getAppliedTransactionsByApprovalId(id)` — indexed lookup, not a per-approval full-table scan). No path/created_at heuristic, no held_operation JSON parsing. A false-close is now impossible (a different op has a different/null approval_id). The `promote`→canonical approval applies via `store.setStatus` (no approval_id-tagged transaction), so a crash there just leaves it `pending` — safe, no false-close.
- [x] **Step 1: Failing test:** the no-false-close case (a pending approval on path P + an unrelated applied transaction on the SAME path P with a different/null approval_id → stays `pending`, approvalsClosed 0) FAILS against the path-heuristic and PASSES with the id-link. Plus: an applied txn tagged with the approval's id closes it; an untagged/reverted txn does not.
- [x] **Steps 2–4:** FAIL → implement → PASS. **Step 5: Commit** `fix(core): reconcile closes stale approvals via sound approval_id link (no false-close)`

### Task 6.3: bridge bodyLimit

**Files:** Modify `packages/server/src/app.ts`; Test `packages/server/test/bodyLimit.test.ts`.

- Set an **app-level** `bodyLimit` on the fastify instance (a small cap, e.g. 16 KiB) so it covers ALL routes including the `/conflicts/:id/*` routes added later in Task 7.1 — do NOT wire per-route limits on routes that don't exist yet in Phase 6. Oversized body → 413 (fastify default) mapped to a clean error body.
- [ ] **Step 1: Failing test:** POST /undo with a >16KiB body (authed, loopback) → 413 (not a hang/500). A normal small body still works.
- [ ] **Steps 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(server): bodyLimit on mutation routes`

---

## Phase 7 — Surfacing: CLI, bridge, plugin

### Task 7.1: bridge `/conflicts` routes

**Files:** Modify `packages/server/src/app.ts`; Test `packages/server/test/conflicts.test.ts`.

- Replace `GET /conflicts` (currently `[]`) with `new Conflicts(ctx.journal).list("open")` (enriched, both-sides-live). Add `POST /conflicts/:id/resolve` → `conflicts.resolve(id, ctx.now())` → `{resolved:true}`; `POST /conflicts/:id/dismiss` → `{dismissed:true}`. Journal-only, lock-free. Unknown id → 404 via the error handler.
- [ ] **Step 1: Failing tests:** seed a contradiction (via openVault+store), `GET /conflicts` returns 1 enriched item; resolve → it drops from the list; dismiss on another → drops; a forgotten-side conflict never appears. All behind auth (401 without token).
- [ ] **Steps 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(server): populated /conflicts + resolve/dismiss`

### Task 7.2: `ledger conflicts` CLI

**Files:** Create `packages/cli/src/commands/conflicts.ts`; Modify `packages/cli/src/index.ts`; Test alongside.

- `conflictsCommand(vaultDir, { action?: "resolve"|"dismiss", id?, rescan?, now?, genId?, env? })`:
  - default: loadContext, print `Conflicts.list("open")` (id, entity, kind, detail, both memory ids/paths). Return the list.
  - `resolve`/`dismiss <id>`: call the API.
  - `--rescan`: walk agent-zone memories and run `checkContradictions` for each (respecting dedup) then print.
  - commander: `program.command("conflicts [action] [id]").option("--rescan").action(...)`; thin wrapper; loadContext already exists.
- [ ] **Step 1: Failing tests:** after seeding a contradiction, `conflictsCommand(dir,{env})` lists 1; `resolve` closes it; `--rescan` re-detects idempotently (no dup).
- [ ] **Steps 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(cli): ledger conflicts (list/resolve/dismiss/--rescan)`

### Task 7.3: plugin — renderConflict + client + tab

**Files:** Modify `packages/obsidian-plugin/src/render.ts`, `src/bridgeClient.ts`, `src/views/activity.ts`; Tests for render + client.

- `render.ts`: `renderConflict(c): HTMLElement` — pure, textContent-only DOM: entity, kind, detail, both memory ids/paths. Hostile-fixture XSS test (detail/paths with `<img onerror>` → inert text).
- `bridgeClient.ts`: add `resolveConflict(id)` / `dismissConflict(id)` (POST); `conflicts()` already exists (returns the enriched list now). Timeout/typed-error handling as existing methods.
- `activity.ts`: wire the Conflicts tab — fetch `conflicts()`, render each via `renderConflict` with Resolve/Dismiss buttons that call the client then refresh. Thin glue (manual per SMOKE.md); update SMOKE.md with a conflicts walkthrough.
- [ ] **Step 1: Failing tests (jsdom for render; live bridge for client):** `renderConflict` builds inert DOM for a hostile fixture (no `img`/`script` nodes; text preserved); `resolveConflict`/`dismissConflict` hit the bridge and return typed results; `conflicts()` returns the enriched list.
- [ ] **Steps 2–4:** FAIL → implement → PASS (bundle-purity test still green). **Step 5: Commit** `feat(plugin): conflicts tab (renderConflict + client + wiring)`

---

## Phase 8 — Docs & gate

### Task 8.1: README + v0.3a gate

- [ ] Add a short README note on contradiction detection + `ledger conflicts` + the plugin Conflicts tab. Note the precision-first stance (only high-confidence contradictions flagged) and that dismissal is permanent.
- [ ] REQUIRED SUB-SKILL: superpowers:verification-before-completion. Run `pnpm build`, `pnpm -w lint`, `pnpm test` from root; paste real output; all green (additive; new contradiction/conflicts/hardening tests passing incl. the multi-fact and scratch-vs-canonical fixtures).
- [ ] Commit `docs: v0.3a contradiction/conflicts walkthrough; test: full green gate`.

---

## Sequencing & notes

- Strict order within core: extract (1) → detector (2) → matcher (3) → conflicts store/migration (4) → check hook + wiring (5). Hardening (6) is independent of the contradiction engine and can interleave, but do it before surfacing so the bridge bodyLimit + conflicts routes land together. Surfacing (7) needs core (5) + bridge hardening (6.3).
- The check hook is journal-only + file-read — **no vault lock** (spec §4.1). Do NOT wrap it in withVaultLock.
- Dedup + moot are enforced at the journal/DB layer — surfacing layers just read `Conflicts.list` (both-sides-live) and never re-implement the filter.
- Every conflict insert goes through `insertConflict` (ON CONFLICT DO NOTHING) — no other insert path.
- Determinism: inject now/genId everywhere a conflict row is stamped; no `Date.now`/`Math.random` in src.
- Commit after each green test. Never `git add -A`; never `git push` from a task.
