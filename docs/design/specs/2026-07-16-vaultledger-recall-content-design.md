# VaultLedger — `memory_recall` must return note content (0.4.2)

**Date:** 2026-07-16
**Status:** design (pre-implementation)
**Severity:** core-loop gap — jumps the queue ahead of the security fast-follows.

**Found by:** a live Hermes agent doing disciplined end-to-end testing, confirmed
against source. An agent following the memory skill's rule 6 ("never edit vault
files directly — every write goes through the tools") can *locate* a belief via
`memory_recall` but **cannot learn what it says** — recall returns the receipt
(id/path/provenance), never the belief. Claude Code masked this for every prior
demo because it reads the returned `path` with its own file tools; a locked-down
Hermes profile can't. spec.md §8's v0.1 milestone ("next session recalls with
provenance") was always half-satisfied: recall returned the provenance, not the
content.

---

## 1. The bug (grounded in source)

`RecallResult` (`packages/core/src/recall/recall.ts:8-20`) is built entirely from
journal columns + tags:

```ts
export interface RecallResult {
  id; path; entity; status; confidence; created; source; reason?;
  supersedes; expires; tags;
}
```

`recall()` (`:50-92`, loop body `:76-90`) loops the filtered rows,
`touchMemory`s each, and pushes that shape — **the note file is never opened**. `memory_recall`
(`packages/mcp-server/src/tools.ts:225-228`) returns it verbatim
(`return { memories }`).

**Repro (from the Hermes report):** `memory_remember` a note containing a
distinctive marker value → fresh session → `memory_recall` by entity → the agent
receives the id/path/tags but **cannot state the marker value**. The underlying
note contains it.

---

## 2. The fix

`recall()` reads each returned memory's note body from the vault and attaches it
as a bounded `content` field.

### 2.1 How the body is read — through the existing gate, not a new path

- **Zone-gated read:** use `assertContainedAndReadable(vaultRoot, manifest,
  relPath)` (`packages/core/src/broker/containment.ts:63`) — the same
  security-skim gate every other vault read already goes through. It returns the
  verified absolute path (containment + excluded-zone re-checks come for free),
  and `recall` already filters excluded rows *before* the read loop, so this is
  defense-in-depth, not the primary gate.
- **Frontmatter-stripped body:** `matter(raw).content` (gray-matter, already a
  core dependency — used by `reindex`/`store`/`backfillEntity`), then `.trim()`.
  The provenance (status/confidence/entity/supersedes/…) is *already structured*
  in the response, so returning the raw frontmatter would be redundant noise;
  the agent wants the belief text.

### 2.2 Opt-in by `vaultRoot` (the one judgment call — decided)

`recall()` is shared by two production callers:
- `memory_recall` (MCP, `tools.ts:227`) — **where the bug lives**; agents need
  content.
- `GET /memories` (`packages/server/src/app.ts:231`) — the bridge, consumed by
  the Obsidian plugin's memory-list view.

Content-reading is **opt-in via a new optional `vaultRoot` in `recall`'s opts**:

```ts
recall(journal, filters, now, manifest, opts?: {
  vaultRoot?: string;      // present → read + attach content; absent → metadata-only
  contentCap?: number;     // per-memory byte cap (default CONTENT_MAX_BYTES)
  contentBudget?: number;  // total-response byte budget (default CONTENT_TOTAL_BUDGET_BYTES)
})
```

- `memory_recall` passes `{ vaultRoot: ctx.vaultRoot }` (confirmed available —
  `ServerContext.vaultRoot`, `context.ts:26`).
- **`GET /memories` deliberately does NOT** — and this is correct, not a gap.
  The whole bug is that a *locked-down agent* can't read the file itself. The
  Obsidian plugin runs **inside Obsidian with full vault read access** — it
  never had the problem and opens the note directly. Metadata-only there also
  keeps the plugin's list from re-reading every file on every refresh. No change
  to `app.ts`.
- `contentCap`/`contentBudget` are injectable so the truncation/budget behavior
  is unit-testable with small values instead of multi-KiB fixtures.

**Backward-compatibility:** the new `content`/`contentState` fields are
**optional and only populated when `vaultRoot` is passed**. Every existing
`recall(journal, filters, now, manifest)` call (5 test files + `GET /memories`)
stays valid and unchanged — `toEqual` on the old shape still matches, because an
absent optional field and `undefined` compare equal.

### 2.3 The result shape — one enum, not a pile of booleans

`RecallResult` gains two optional fields (present only on a content-reading
recall):

```ts
content?: string | null;
contentState?: "full" | "truncated" | "missing" | "omitted";
```

| `contentState` | `content` | meaning | what the agent should do |
|---|---|---|---|
| `"full"` | the body | read whole, under the per-memory cap | use it |
| `"truncated"` | body prefix | body exceeded the per-memory cap | open the note (`path`) for the rest |
| `"missing"` | `null` | file gone/unreadable (journal↔file drift) | the belief's text is unrecoverable from here |
| `"omitted"` | `null` | withheld — total-response budget exhausted | narrow the recall (tighter `entity`/`status`/`limit`) |

A single enum keeps the three not-full states legible and distinct — they imply
*different* agent actions, so collapsing them would lose information.

### 2.4 Bounding — the output mirror of the input discipline

Input caps every text field at `TEXT_MAX_BYTES = 16 KiB` via
`Buffer.byteLength(s, "utf8")` (`tools.ts:50`). Recall can return many memories,
so unbounded content would flood agent context. This is the output-side mirror:

- **Per-memory cap — `CONTENT_MAX_BYTES = 4096` (4 KiB).** A belief that needs
  more than 4 KiB is a document, not a belief; it's truncated with
  `contentState:"truncated"` and the agent can open the note. Comfortably under
  the 16 KiB input cap.
- **Total-response budget — `CONTENT_TOTAL_BUDGET_BYTES = 32768` (32 KiB).**
  ~8 full-size memories' worth. When the budget is exhausted, *something* must
  be denied its content — and **what gets denied is a design choice this product
  cannot leave to insertion order.** Recall returns rows `ORDER BY created DESC`
  (`journal.ts:334`) — newest-first, **no relevance/authority ranking** — so
  filling content in return order would shed the *oldest* content first, which
  can be a long-standing **canonical** belief starved by a burst of recent
  scratch. That is backwards for a broker whose whole thesis is that canonical
  is the belief the system defends.
  - **Fill content by authority, not by position.** Compute the content-inclusion
    decision over the memories ordered by **(status priority, then `created`
    DESC, then `id`)** — `canonical` > `working` > everything else
    (scratch/retired/…). Walk that authority order accumulating included bytes;
    the first memory whose (already per-memory-capped) content would exceed the
    budget — and every lower-priority memory after it in that order — gets
    `contentState:"omitted"`, `content:null`. So the budget sheds the
    **least-authoritative** content first, and the "omitted" signal tells the
    agent to narrow rather than silently dropping a belief.
  - **The return array order is UNCHANGED** — still `created DESC` (recall's
    existing contract; all callers depend on it). Only the *content-inclusion
    decision* uses authority order. Each returned memory carries its own
    `contentState`, so a newer scratch memory reading `omitted` sitting above an
    older canonical reading `full` is legible, not confusing.
  - **Determinism:** the `id` tiebreak (and adding `, m.id` as a secondary sort
    key to `queryMemories`, since `created DESC` alone is
    SQLite-unspecified on ties) makes both the return order and the
    content-inclusion decision fully deterministic.
  - **Budget is checked BEFORE the read.** Precedence is explicit: for each
    memory in authority order, if the running budget is already exhausted →
    `omitted`, and **do not read the file**. Otherwise read →
    `full`/`truncated`/`missing`. So a past-budget memory with a deleted file is
    `omitted` (never read), not `missing` — budget wins, no wasted I/O.
  - **First-overflow-stops, NOT best-fit packing (invariant — do not
    "optimize").** Once a memory overflows the budget, every lower-authority
    memory after it is `omitted` **even if its (smaller) content would have
    fit**. This is deliberate: best-fit packing would let a small `scratch`
    memory get content while a larger, higher-authority `working` one is denied,
    breaking the invariant the whole rationale rests on — **if a memory has
    content, everything more authoritative than it does too**. A future
    "let the small one through" refactor silently violates that; §3 pins it.
- **Byte-safe truncation:** the cap is measured in **bytes** (`Buffer.byteLength`,
  consistent with the input side), but the cut lands on a UTF-8 char boundary at
  or below the byte cap — it never splits a multibyte character (no U+FFFD
  artifacts). **Algorithm (name it so nobody ships the naive slice):** a naive
  `Buffer.from(s).subarray(0, cap).toString("utf8")` produces the forbidden
  U+FFFD. Instead slice at the byte cap, then walk *back* off any trailing UTF-8
  continuation bytes (`0x80–0xBF`) until the byte before the cut is not a
  continuation byte — landing on a char boundary at or below `cap`.

### 2.5 Failure = degrade, never throw

The journal is a **disposable index** (rebuilt from the vault + git); a row can
outlive its file. The **read + parse** is wrapped per-memory in try/catch, so
ALL of these yield `contentState:"missing"`, `content:null` for *that one
memory* while the recall as a whole succeeds:
- an absent/unreadable note file (`readFileSync` → `ENOENT`);
- an `assertContainedAndReadable` throw from a concurrent change;
- **invalid-YAML frontmatter that makes `matter()` throw** — a parse failure is
  a per-memory degrade, not a recall-killing exception.

Missing is distinct from truncated and from omitted (§2.3), so drift is legible
rather than looking like a size limit.

---

## 3. The load-bearing test — the assertion v0.1's e2e never made

An e2e/integration test that proves the **core loop**, not just the plumbing:

1. `memory_remember` (or store) a note whose body contains a distinctive marker
   (e.g. `MARKER-7ce14142`).
2. Recall it **from fresh context** (new recall call / new session) by entity.
3. **Assert the returned `content` CONTAINS the marker** — not merely that an id
   or path came back. This is the assertion that would have caught the bug, and
   its absence is why the bug shipped through v0.1→v0.4.1.

Compose case (the 0.4.1 enum fix and this stack): `memory_recall({status:
"retired"})` returns content too — a retired belief is still readable, which is
the whole point of retire-don't-forget.

Plus unit coverage on `recall` with injected small caps:
- body under cap → `full`, content equals the trimmed body.
- body over per-memory cap → `truncated`, content is the byte-safe prefix, and a
  multibyte char straddling the cap is not split.
- deleted note file → `missing`, content `null`, recall still returns the row.
- **authority-first budget:** with content exceeding the total budget across a
  mix of statuses, the **`canonical`** memory retains its content (`full`/
  `truncated`) while a lower-priority `scratch` one is `omitted` — even when the
  scratch memory is *newer* (higher in the returned array). This is the test
  that pins the "sheds least-authoritative first" rule against a naive
  fill-in-return-order regression.
- **monotonicity — first-overflow-stops, not best-fit** (comment the test:
  *non-packing is intentional*): after a memory overflows the budget, a smaller
  lower-authority memory further down is `omitted` **even though its content
  would have fit**. Pins the invariant (if X has content, everything more
  authoritative has content) against a "let the small one through" refactor.
- **budget-beats-missing precedence:** a memory that is BOTH past-budget AND has
  a deleted file reads `omitted`, not `missing` — the file is never read
  (§2.4). Pins the precedence a refactor could silently flip.
- **malformed frontmatter degrades, doesn't throw:** a note whose frontmatter is
  invalid YAML (so `matter()` throws) yields `contentState:"missing"` for *that
  one memory* while the recall as a whole succeeds — proving the §2.5 per-memory
  try/catch covers parse failures, not just absent files.
- frontmatter is stripped (a note with a `ledger:` block → content has no `---`).

---

## 4. Non-goals

- **No free-text/full-body search.** recall stays journal-indexed exact-match
  filtering; content is *returned*, not *searched*.
- **No change to `GET /memories`** (§2.2) — metadata-only is correct there.
- **No new provenance in `content`** — provenance stays in the structured fields;
  content is the frontmatter-stripped body only.
- **No unbounded content** — the caps are the point; do not add an "uncapped"
  escape hatch.

---

## 5. Versioning & publish (0.4.2)

- **`core` and `mcp-server` bump to `0.4.2`.** The `RecallResult`/`recall` change
  is core; the `memory_recall` opt-in is mcp-server.
- **`cli` stays `0.4.1`.** Its exact-pinned `workspace:*` deps rewrite to the
  siblings' local versions (`core@0.4.2`, `mcp-server@0.4.2`) at publish and
  resolve fine; the MCP config `setup` emits is the **unpinned** npx form, so
  real users spawn the fixed `@vault-ledger/mcp-server` automatically; doctor's
  `major.minor` check stays quiet (all within `0.4`).
- **`server` stays `0.4.0`** (unchanged — `GET /memories` untouched).
- **Publish order: `core` FIRST, then `mcp-server`** (mcp-server depends on
  core; the dependency publishes first). Two ordered commands, not the
  four-package ritual.
- `verify-publish.mjs` already reads each sibling's actual local version (the
  0.4.1 fix), so a core@0.4.2 + mcp-server@0.4.2 + cli-still-0.4.1 graph passes
  without further script change — **verify this holds, don't assume** (cli's
  packed dep on both bumped siblings must read `0.4.2`).

---

## 6. File structure

**Modify:**
- `packages/core/src/recall/recall.ts` — the opts param, the content read
  (gated + frontmatter-stripped + capped/budgeted/byte-safe), the two new
  `RecallResult` fields, the module-level cap constants.
- `packages/mcp-server/src/tools.ts` — `memory_recall` passes
  `{ vaultRoot: ctx.vaultRoot }`; update the tool description to mention content
  is returned (bounded).
- `packages/core/package.json`, `packages/mcp-server/package.json` — → `0.4.2`;
  `packages/mcp-server/src/index.ts:18` `SERVER_VERSION` → `0.4.2` (no test
  asserts it — confirmed at spec review — so just the one line);
  `packages/cli/src/index.ts` **stays `0.4.1`**.
- Tests: `packages/core/test/recall/recall.test.ts` (unit: the five §3 cases),
  `packages/mcp-server/test/` (the load-bearing marker e2e + retired compose).

**Unchanged (deliberately):** `packages/server/src/app.ts` (`GET /memories`
stays metadata-only).
