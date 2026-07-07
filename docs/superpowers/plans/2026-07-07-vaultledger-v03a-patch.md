# VaultLedger v0.3a patch backlog — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) tracking. TDD per task.

**Goal:** Clear the v0.3a post-merge review backlog — seven precision/quality fixes plus one governance change (gate `forget` of a canonical belief behind approval).

**Source:** the "v0.3b patch backlog" list in `docs/superpowers/specs/2026-07-05-vaultledger-v03a-design.md` §9 (recorded from the v0.3a final + evasion reviews). This plan pulls them forward into a v0.3a patch.

**Branch:** `fix/v0.3a-patch-backlog` (off `main`). Baseline: 431 passed / 1 skipped, build + lint clean.

**Applies throughout:** TDD (failing test first). Explicit-path git staging (never `git add -A` — nested repo). Do NOT `git push` from task subagents. `.js` imports. No `Date.now`/`Math.random`/`new Date(str)` in `src`. Temp vaults + temp HOME; clean up. Gate after each unit: `pnpm build && pnpm -w lint && pnpm test` stays green.

---

## WU-A — detection precision/tidy (extract.ts + detector.ts)

These affect the precision-first guarantee (false positives / silent misses).

### A1: `FACT_LINE_RE` must not treat arbitrary prose / URLs as facts
`packages/core/src/contradiction/extract.ts`. Today `word: rest` matches any prose line — a bare URL (`See https://example.com`) parses as key `https` value `//example.com`, and two notes with different URLs → a spurious `https` value-conflict.
- Fix: (a) skip a value that begins with `//` (URL remainder after `https:`); (b) skip lines whose "key" is a known URL scheme (`http`, `https`, `ftp`, `mailto`, `file`, etc.) — a small stoplist; (c) OPTIONAL: only accept a fact line when the value is non-empty and the line isn't obviously prose (keep conservative — precision). Keep frontmatter extraction unchanged (structured).
- Tests: `extract` of a body line `See https://example.com for details` → NO `https` fact; a legit `owner: Alice` still extracted; a `url: https://x` frontmatter field — decide: skip URL-valued facts entirely (a differing URL is rarely a "contradiction"); assert two notes with different `https://` body URLs produce NO value-conflict.
Commit: `fix(core): extract skips URLs/schemes so they aren't spurious facts`

### A2: frontmatter datetime with a time component must not UTC-shift the date
`extract.ts` `canonicalize`. A `yyyy-mm-ddThh:mm:ss` (or YAML timestamp with a time) can shift a day across timezones when rendered. Fix: only a **date-only** value (`yyyy-mm-dd`, no time component) canonicalizes to a `date`; a value carrying a time component → `unparseable` (never flagged). For a YAML-coerced `Date`, treat it as date-only ONLY if the source had no time (check the raw string, or detect midnight-UTC vs not) — simplest robust rule: canonicalize a `Date` via its UTC `yyyy-mm-dd` but mark it `unparseable` if the value string included a `T`/time. Keep deterministic (no `new Date(str)`).
- Tests: `2026-08-15` → date; `2026-08-15T09:00:00` (or a datetime frontmatter scalar) → unparseable (not flagged); confirm no day-shift is possible.
Commit: `fix(core): datetime values are unparseable (no day-shift), only bare dates canonicalize`

### A3: reject calendar-invalid dates
`extract.ts` `tryDate`/date parsing. `2026-02-31`, `2026-13-01`, `2026-00-10` currently canonicalize as a "date". Fix: after building the ISO candidate, validate the calendar (month 1–12; day within that month's length incl. leap-year Feb) — invalid → `unparseable`.
- Tests: `2026-02-31` → unparseable; `2026-13-01` → unparseable; `2024-02-29` (leap) → date; `2026-02-28` → date.
Commit: `fix(core): reject calendar-invalid dates (unparseable)`

### A4: tidy the unreachable `isn't` negation branch
`detector.ts` negation regex. The `isn't` alternative is effectively unreachable given the `is\s+(not|no longer|isn't)` structure (`isn't` never follows `is `). It only affects recall (missed detections), not precision. Fix: correct the regex so `X isn't Y` is actually matched as a negation (e.g. `\b(?:is\s+(?:not|no longer)|isn't)\b`), OR remove the dead alternative and document the narrowing. Prefer making `isn't` reachable (adds a real detection) with a test.
- Tests: `The build isn't green` vs `The build is green` → one negation-conflict (currently missed); keep the existing narrow negation tests green.
Commit: `fix(core): make the isn't negation branch reachable`

---

## WU-B — journal + surfacing nits

### B1: add the `approval_id` index (the comment claims an indexed lookup)
`packages/core/src/journal/db.ts` + `journal.ts`. `getAppliedTransactionsByApprovalId` comments an "indexed lookup" but there's no index on `transactions.approval_id`. Fix: `CREATE INDEX IF NOT EXISTS ix_transactions_approval ON transactions(approval_id) WHERE approval_id IS NOT NULL` (partial — most rows are null). Idempotent. (Non-unique — an approval could in principle link multiple rows.)
- Tests: index exists after open (`pragma index_list`); idempotent; the existing reconcile approval cross-check tests still pass.
Commit: `fix(core): index transactions.approval_id (matches the documented lookup)`

### B2: `resolve`/`dismiss` of an already-resolved/dismissed conflict shouldn't silently overwrite
`packages/core/src/conflicts/queue.ts` + `packages/server/src/app.ts`. Today `resolve(id)` on an already-`dismissed` row silently flips it to `resolved`. Fix: `Conflicts.resolve`/`dismiss` should be a no-op-or-signal on an already-closed conflict — return whether it changed (or throw a typed conflict). Bridge route: on an already-resolved/dismissed conflict, return a `409` (via a BrokerError-style mapping) rather than silently re-closing. Keep it simple: `setConflictState` only transitions from `open`; `resolve`/`dismiss` on a non-open conflict → a clear result the route maps to 409. CLI: report "already <state>" without error-exit, or a clear message.
- Tests: dismiss then resolve the same id → the second is rejected/no-op (state stays `dismissed`); bridge returns 409; an open conflict resolves fine.
Commit: `fix(core,server): resolving an already-closed conflict is a 409, not a silent overwrite`

### B3: `--rescan` cap + note
`packages/cli/src/commands/conflicts.ts`. `--rescan` iterates `queryMemories({limit:100000})` — a silent truncation, and O(n²) per entity. Fix (low-risk): make the limit explicit/named and log a clear warning if the memory count hits the cap (so truncation isn't silent). A full batching rewrite is out of scope; a `log`/`out` note is enough. Optionally accept `--limit`.
- Tests: rescan on a small vault still works + is idempotent; if easy, assert the cap warning fires when the count would exceed a small injected cap.
Commit: `fix(cli): --rescan surfaces its scan cap instead of silently truncating`

---

## WU-C — governance: gate `forget` of a canonical belief behind approval

The final review found `forget()` has no approval gate: an agent can silently `memory_forget` a canonical belief (no `supersedes` needed) to drop it from comparison — the same evasion class as the supersedes hole. Forgetting canonical should require human approval, mirroring the working→canonical promotion gate.

### C1: `MemoryStore.forget` gates canonical
`packages/core/src/memory/store.ts`. Add `opts?: { approved?: boolean }` to `forget`. If `mem.status === "canonical"` AND NOT `opts.approved` → enqueue an approval (held_operation `{op:"forget", id, reason, session}`, zone e.g. `"canonical-forget"`, state `pending`) via `journal.insertApproval` and RETURN `{ queued: true, approvalId }` WITHOUT archiving. Otherwise (scratch/working, or `approved:true`) → apply the tombstone as today and return `{ forgotten: true }`. (Return type becomes a union.)
- Tests: forget a WORKING memory → applies immediately (`forgotten:true`, file archived); forget a CANONICAL memory → `{queued, approvalId}`, the memory is STILL canonical + file NOT archived + a pending approval exists; forget with `{approved:true}` on canonical → applies.

### C2: `Approvals.approve` dispatches a held `forget`
`packages/core/src/approvals/queue.ts`. Add a `case "forget"` to the approve() dispatch: parse `{id, reason, session}`, call `await this.store.forget({ id, reason, session }, { approved: true })` (bypasses the gate → applies), mark the approval `approved`. (Mirror the `promote` case.)
- Tests: enqueue a canonical-forget approval, `approve(id)` → the memory is now forgotten/archived + approval `approved`; `reject(id)` → memory stays canonical, nothing archived.

### C3: MCP `memory_forget` relays the queued/applied result
`packages/mcp-server/src/tools.ts`. `memory_forget` returns `{ queued: true, approvalId }` when the forget was queued (canonical) or `{ forgotten: true, id }` when applied. Structured, no throw.
- Test: memory_forget on a canonical memory returns the queued result; on a working memory returns forgotten.

Commit WU-C as it lands (one commit per C-task or a coherent batch): `feat(core,mcp): gate forget of a canonical belief behind approval`

Also update the design doc: `docs/superpowers/specs/2026-07-05-vaultledger-v03a-design.md` §6 — `forget` of a canonical belief requires approval (mirrors promotion); move that item out of the §9 backlog into shipped. And the README lifecycle note if it claims forget is always direct.

---

## Gate
`pnpm build && pnpm -w lint && pnpm test` green; each fix additive. Remove the addressed items from the §9 backlog as they land.
