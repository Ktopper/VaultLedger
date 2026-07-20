# VaultLedger — v1 agent-surface completion + freeze (0.4.7)

**Date:** 2026-07-18
**Status:** design (pre-implementation)
**Source:** field finding (live Hermes) — **the final feature cycle. After this, the agent surface freezes.**

## The finding

Hermes was asked to file an Inbox article into the existing **Brandit** client
hub and **could not**: no way to enumerate a directory, no way to search note
content, no way to move a file, no way to delete one. The governed surface could
create and edit notes but couldn't *organize* them — a memory system that can't
tidy itself accretes cruft the agent can't reach.

This cycle completes the CRUD + discovery surface, then **freezes it**. The v1
agent surface after 0.4.7:

> **discovery/read:** `vault_search` · `vault_list` · `vault_read`
> **propose (approval-gated):** `vault_propose_replace` · `vault_propose_create` ·
> `vault_propose_delete` · `vault_propose_move`
> **status:** `ledger_status`
> **memory lifecycle:** `memory_recall`/`remember`/`revise`/`promote`/`retire`/`forget`/`distill`

**15 tools by default** (7 memory + 8 vault/status), with `vault_propose_edit`
demoted behind an opt-in flag (16 with it). §7 declares the freeze in README +
CLAUDE.md: **nothing new lands on the agent surface without something being
removed.**

## The unifying zone principle (read it once, applies to every tool below)

0.4.6 established two behaviors for an excluded path; this cycle makes them a
**principle** across the whole surface:

- **Existence-revealing ops → excluded is INDISTINGUISHABLE from absent.**
  `vault_read`, `vault_list`, `vault_search`, and the **source** of
  `vault_propose_delete` / `vault_propose_move` all either return `NOT_FOUND`
  (read/delete/move-source), silently **omit** the entry (list), or silently
  **skip** the file (search) — an agent can NEVER learn the excluded-glob map by
  probing. (VL-SEC-S7-04 oracle discipline, now surface-wide.)
- **Write-to-a-named-path ops → excluded is `FORBIDDEN_ZONE`.** `vault_propose_create`,
  the **destination** of `vault_propose_move`, and `vault_propose_edit` reject an
  excluded target with `FORBIDDEN_ZONE` — the agent named the path, and there is
  no existing content to hide.

All zone/containment decisions run on the **canonical (realpath-resolved) path**
(the 0.4.6 gate — `..` and symlinks resolved), so neither can evade the split.

---

## WU-1 — `vault_propose_delete` (core + mcp-server)

`{path, expected_hash}` — `expected_hash` **required**: the human approves
deleting *exactly the content they reviewed*; drift → `STALE_HASH`. Structured
tool only. Flow: `vault_read` → `vault_propose_delete`.

### Its own op, NOT a diff

`applyProposeEdit` already **rejects every `+++ /dev/null` deletion diff**
(`patchTargetKind === "delete"` → `SYNTAX_BREAK`, 0.4.4) — the primary reason
deletion can't ride the diff path, at any size. (Secondary, for notes over the
512-byte `PATCH_RATIO_FLOOR_BYTES`: a whole-file deletion is the entire content
as `-` lines, tripping `PATCH_TOO_LARGE`.) So `propose_delete` is a **dedicated
op carrying no patch**: `{op:"propose_delete", path, expected_hash, reason,
session}`. The 0.4.4 deletion-diff rejection **stays** — delete goes through a
different door.

### Propose gate — `applyProposeDelete` (queues; never applies directly)

The source read is exactly a `vault_read`, so it inherits the read oracle:
1. **Read + zone via the read path** — resolve the canonical path; **excluded →
   `NOT_FOUND`** (indistinguishable from missing, per the principle — NOT
   `FORBIDDEN_ZONE`); traversal/symlink escape → `FORBIDDEN_ZONE`. Missing →
   `NOT_FOUND` (`retriable:true` at the call site).
2. **Hash pin** — `assertHashFormat` → read → `hashBytes` compare; mismatch →
   `STALE_HASH`.
3. **Governance mirror (the ONE predicate)** — `governedProvenanceChanged(content,
   "")` → a file carrying governed provenance (a `ledger:` block / top-level
   `entity`) → **`LEDGER_GUARD`** (retriable) steering to *"this is a governed
   memory; memories retire, they don't delete — use `memory_retire` (keeps it
   citable) or `memory_forget` (tombstones it)."*
4. **Enqueue** `{op:"propose_delete", path:<canonical>, expected_hash}` (§6 fold).

### Apply — on approve (dual-mode on ONE op string)

There is no `revise`-shaped op to reshape a delete into (no patch), so
`propose_delete` is the held op for BOTH propose and apply; the broker's
`case "propose_delete"` **branches on `opts.approved`** (mirroring
`case "revise" → applyRevise(op, approved)`): `false` → `applyProposeDelete`
(queue); `true` → `applyDelete`. Two REQUIRED wiring points:
1. **`Approvals.approve()`'s `switch (op.op)`** (queue.ts) ends in
   `default → INVALID_TRANSITION`; add `case "propose_delete": return
   this.dispatchApply(id, op);` (mirror `create`/`revise`) — `dispatchApply`
   re-runs the held op with `{approved:true, approvalId:id}`, stamping the txn's
   `approval_id` for reconcile.
2. **`broker.apply()` dispatch switch** gets `case "propose_delete"` (dual-mode).

`applyDelete`: under `withVaultLock`, re-resolve + re-check existence (gone →
clean `NOT_FOUND`/`STALE_HASH`) + re-compare hash (drift → `STALE_HASH`).
**Baseline-commit an untracked source FIRST (spec-review blocker B1):** if
`git.fileAtHead(path) === null` — the note was dropped by a human / Obsidian sync
and never committed, the *likely field shape* — `git.commitFile(path, "VaultLedger
baseline: …")` BEFORE the destructive step, mirroring `applyRevise` (broker.ts
~:443). Otherwise `commitPaths`'s `git add` fails on an already-`unlink`ed
untracked path (git exit 128, a RAW non-`BrokerError`) → file gone, no commit, no
journal row, undo dead. THEN `unlinkSync` + `git.commitPaths([path],
formatMessage({op:"delete",…}))` (the `doArchive` git mechanics, NOT a call to
`doArchive`); journal a **`delete`** txn (`hash_before` = content hash,
`hash_after: null`, `approval_id`, `commit_sha`).

### Recoverability is the argument FOR deletion

Every delete is a **git-committed removal**, so **`ledger undo` = `git revert`
restores the file byte-for-byte** — the justification for supporting deletion at
all. `undoTransaction`/`undoSession` are `commit_sha`-driven and a `delete` txn
has `memory_id:null` (skips the memory-status block), so undo restores with **no
new-op special-casing** (verified at spec-review). §8 pins the byte-identity with
a hash equality.

---

## WU-2 — `vault_propose_move` (core + mcp-server)

`{from, to, expected_hash}` — **source** `expected_hash` required. A **rename** is
just a different basename in `to`. **Carries no content** → it operates **above
the read/propose byte caps** (you can move a 10 MB attachment; the op is
path-only). State that as a design point: move is the one propose op whose cost is
independent of file size.

### Source inherits ALL delete rules; destination inherits ALL create rules

- **Source** = the `applyProposeDelete` gate: canonical path; **excluded ≡ missing
  `NOT_FOUND`** (oracle); missing → `NOT_FOUND` (retriable); hash pin →
  `STALE_HASH`; **governed → rejected** (see the gate decision below).
- **Destination** = the `applyProposeCreate` → `applyProposeEdit` create-branch
  gate. Checks run in THIS ORDER (S1 — the order is load-bearing for
  non-disclosure): **(1) canonical zone: excluded → `FORBIDDEN_ZONE`** — a
  **trusted** destination is ALLOWED (queued for approval); (2) **occupied →
  `DESTINATION_EXISTS`** (NEW code, §5, `retriable:true`: pick a different `to` or
  delete the occupant first — distinct from create's non-retriable `TARGET_EXISTS`
  "use edit"). **Excluded MUST be checked before occupancy (S1 oracle):** if
  occupancy fired first, `move(to=<excluded path>)` returning `DESTINATION_EXISTS`
  vs `FORBIDDEN_ZONE` would leak whether a file exists at an excluded path
  (`Private/salary.md`, `.git/config`); zone-before-existence (which `applyCreate`
  already does) collapses both to `FORBIDDEN_ZONE`. No `to` hash — the destination
  must be empty, nothing to pin.
- **CRITICAL (blocker B2): the destination gate is `applyProposeEdit`'s create
  branch (excluded → `FORBIDDEN_ZONE`, TRUSTED allowed-with-approval), NOT
  `applyCreate`/`createFile`** — the latter hardcodes an **agent/scratch-only**
  zone (broker.ts ~:243), which would reject every `Clients/Brandit/…` move and
  make the acceptance capstone impossible. The field task files into a **trusted**
  client hub; trusted-with-approval is the whole point.

### Apply — a single `git mv` commit

`applyMove` (approved branch, dual-mode + approve-switch arm exactly like delete):
re-verify source hash + destination-empty under the lock. **Baseline-commit an
untracked source FIRST (blocker B1, same as delete):** `if (git.fileAtHead(from)
=== null) git.commitFile(from, "VaultLedger baseline: …")` before the destructive
step — an Inbox article dropped by Obsidian is untracked until committed, and
`commitPaths` would otherwise fail (git exit 128) leaving the source unlinked and
the dest orphaned/unjournaled. THEN **create intermediate destination directories
implicitly** (`mkdirSync(dirname(toAbs), {recursive:true})`); write the source
bytes to the destination via `writeContainedFile` (S1-02 temp+rename, re-verifying
containment on the destination), `unlinkSync` the source, then
`git.commitPaths([from, to], formatMessage({op:"move",…}))`. Journal a **`move`**
txn: `path` = from; a `to` field on the row (or the message records the pair — the
plan picks one); `hash_before` = source hash, `hash_after` = same hash (content
unchanged); **`approval_id` from the held approval (S3 — reconcile closes a stale
move approval ONLY by `approval_id` match, so the row must carry it, like the
delete txn)**; `commit_sha`. Undo = `git revert` → moves it back.

> **CRITICAL (spec-review ground-check): reuse `doArchive`'s git MECHANICS, NOT
> `doArchive` itself.** `doArchive` (broker.ts) is the memory-*forget* archive
> path and **hardcodes an agent/scratch-zone-only gate** (`fromZone/toZone !==
> "agent" && !== "scratch" → FORBIDDEN_ZONE`) — calling it for a **trusted**
> `Inbox → Clients/Brandit` move would reject the exact field task. `applyMove`
> is a **separate method** that reuses only the read→write-contained→unlink→
> `commitPaths([from,to])`→journal pattern; its zone rules are the ones specced
> here (source = delete rules, destination = create rules), applied at the
> propose gate — never `doArchive`'s agent/scratch restriction. Same caveat for
> `applyDelete` (WU-1): it reuses the `unlink`+`commitPaths`+journal mechanics,
> NOT a call to `doArchive`.

### Directories are NOT first-class (state the rule)

There are **no directory create/delete/list-as-mutation ops**. Filing into a *new*
client subfolder works because **`applyMove` creates intermediate destination
directories implicitly on apply** — that is the ONLY way a directory comes into
being through the API, and it's a side effect of moving a file into it. (Empty
directories are never created, never deleted, never enumerated as first-class
objects.) This rule is load-bearing for the field task (filing into
`Clients/Brandit/…` where `Brandit/` may not exist yet).

### THE gate question: governed-memory moves → RESTRICTED to plain docs (decided, grounded)

**Grounded in the code:** the `memories` table stores `path TEXT NOT NULL`
(`journal/db.ts:22`), and **every** memory operation resolves its file through
`mem.path` — recall reads the body at `row.path` (`recall.ts:120,155`), and
revise/retire/forget/hash all `join(vaultRoot, mem.path)` (`store.ts:532`).
Memory files are created at a **managed** `${agentDir}/${id}.md` path by design.
A file `git mv` that did not atomically update `memories.path` would **break
recall** (integrity-violation filter drops the now-mislocated memory) **and every
lifecycle op** (can't find the file).

**Decision: v1 `vault_propose_move` supports PLAIN DOCS only.** A source carrying
governed provenance → **`LEDGER_GUARD`** (retriable) with a steering message:
*"this is a governed memory; its file location is managed by the memory tools, not
an agent-movable path — memory content changes via `memory_revise`; a belief's
lifecycle is `memory_retire`/`memory_forget`, not a file move."* Detected with the
**same `governedProvenanceChanged("", sourceContent)`** predicate (the
create-direction call detects "carries governed provenance") — the fourth call
site of the one predicate, consistent with create/delete.

**Justification for the restriction (vs atomic reference updates):** supporting
memory moves would require updating `memories.path` in the same transaction as the
git mv (and any denormalized path in `memory_relations`/conflicts), i.e. a
multi-store atomic write — real bug surface, immediately before freeze, for a
capability with **no field use case** (the incident is filing a *plain* Inbox
article; memories live at their managed path and no agent needs to relocate the
file). If a real need appears post-freeze, it's an explicit un-freeze decision.

---

## WU-3 — `vault_list` (core + mcp-server)

`{path} → {path, entries: [{name, kind, size?}]}` where `kind` ∈
`"file"|"dir"`; `size` present for files. **Non-recursive, read-only, no journal,
MCP-only** (standalone core `listVaultDir`, wired like `readVaultFile` — not a
broker op).

- **Containment identical to `vault_read`:** canonical-path gate; traversal/symlink
  → `FORBIDDEN_ZONE`; an **excluded directory → the same `NOT_FOUND`** as a
  missing directory (oracle).
- **Excluded entries are silently OMITTED, never marked** — an entry whose
  canonical path resolves to the excluded zone (e.g. `.obsidian/`, `.ledger/`,
  `.git/`, a manifest-excluded `Private/`) is dropped from `entries` with no flag,
  no count hint — omission must be indistinguishable from "not there" (oracle;
  §8 pins payload identity).
- **Root listing:** `path: "."` lists the vault root; **`""` is rejected** by the
  `.min(1)` path schema (consistent with `vault_read`) — pick `"."`, reject the
  empty string, so there's exactly one root token.
- **Entry cap:** at most **`LIST_MAX_ENTRIES = 1000`** entries, then
  `truncated: true`. **Invariant (S2 oracle): the excluded-entry filter runs
  BEFORE the cap** — cap the *post-omission* list, never the raw `readdir`.
  Otherwise a dir of 1000 normal + 1 excluded entry would show `truncated:true`/
  ~999 while a plain 1000-entry dir shows `truncated:false`/1000, revealing the
  excluded entry at the boundary. §8 pins this: `LIST_MAX_ENTRIES` visible + 1
  excluded is byte-identical (count AND `truncated`) to `LIST_MAX_ENTRIES` visible
  + 0 excluded. Justified: a single vault folder over 1000 *visible* entries is
  pathological; `truncated` tells the agent to narrow. Missing path / a file path
  (not a dir) → `NOT_FOUND` (a file isn't a listable dir; same indistinguishable
  code).

---

## WU-4 — `vault_search` (core + mcp-server)

`{query} → { matches: [{path, snippet, line}], truncated }`. **Read-only, no
journal, MCP-only, NO index** — a plain bounded scan over readable notes (KISS;
an index is a §9 non-goal). Standalone core `searchVault`, wired like
`readVaultFile`.

- **Case-insensitive LITERAL match** for v1. **Regex is a non-goal** (§9) — say
  so in the tool description so agents don't pass patterns expecting regex.
- **Zone discipline (oracle):** excluded files are **never scanned and never
  appear**. Files **over the 64 KiB read cap** and **non-UTF-8** files are
  **skipped silently** — and a spec-pinned invariant: **skipping must be
  indistinguishable from no-match** (a hit inside a skipped/oversized/excluded
  file and a genuine no-match produce the same empty result; §8 asserts a query
  matching excluded content verbatim returns nothing, with no "N files skipped"
  signal).
- **Bounded:** at most **`SEARCH_MAX_MATCHES = 50`** matches total (across files),
  **`SEARCH_SNIPPET_MAX = 200`** chars per snippet (centered on the match), and
  the scan visits files under the containment gate only. `truncated: true` when
  the match cap is hit. **Invariant (S2, mirrors list): excluded/oversized/
  non-UTF-8 files are filtered/skipped BEFORE anything counts toward
  `SEARCH_MAX_MATCHES` or `truncated`** — a skipped file must never nudge the cap
  or the truncated flag, or its existence leaks at the boundary. Justified: 50 matches is enough to locate a file
  (search's job is "which file says X", not "read everything"); the snippet bound
  keeps the response small; no per-file or total-bytes index means cost is
  O(readable notes) — acceptable for a personal vault, and the caps stop a
  pathological vault from producing an unbounded response.
- **Tool description distinguishes it from `memory_recall`:** *recall* queries
  **governed memories** with authority ranking (canonical > working > …) —
  "what do I know about X"; *search* greps **raw note content** — "which file
  mentions X". The description says this explicitly so an agent picks recall for
  beliefs, search for text.

---

## WU-5 — `vault_propose_edit` demotion to an expert opt-in

Removed from **default** registration; the structured tools are the only agent
path. A diff-holding expert client opts back in.

### Mechanism: a CLI flag `--allow-raw-diff` (decided; justified over env var)

`vaultledger-mcp --allow-raw-diff` — parsed like the existing `--no-sweep`
(`parseNoSweep`; add `parseAllowRawDiff`). Chosen over an env var because: (1) it
lives **visibly next to `--vault`** in the harness's MCP config block, so a
reader sees the raw-diff surface is on and why — an env var is invisible there;
(2) per-invocation, not per-shell; (3) matches the codebase's arg-flag precedent
(`--no-sweep`/`--vault`), introducing no env-var pattern that exists nowhere else.
**Threading:** `main` parses it into `LoadServerContextDeps` (a new field,
parallel to `skipSweep`); `loadServerContext` sets `allowRawDiff` on the
**`ServerContext`**; `buildTools(ctx)` reads `ctx.allowRawDiff` and registers the
`vault_propose_edit` `ToolDef` **iff** set. Carrying it on `ctx` (not a
`createServer`/`buildTools` param) keeps every existing call site — all tests —
compiling untouched.

### Catalog count is conditional

- **Default: 15** — 7 memory + `vault_search`/`vault_list`/`vault_read`/
  `vault_propose_replace`/`vault_propose_create`/`vault_propose_delete`/
  `vault_propose_move`/`ledger_status`.
- **With `--allow-raw-diff`: 16** — `+vault_propose_edit`.

**`listToolNames(allowRawDiff = false)`** — a defaulted arg so bare callers keep
compiling; returns 15 or 16. **Every exhaustive table updates:** the name array +
a new flag-on 16 case in `tools.test.ts`; the numeric asserts in
`placeholder.test.ts` / `stdio.smoke.test.ts` / `bin.launcher.smoke.test.ts`
change **12 → 15**; the **behavioral `propose_edit` tests migrate to a flag-on
ctx** — `tools.test.ts` (the `tools.get("vault_propose_edit")` sites),
`inputBounds.test.ts` (the propose_edit byte-bound test), and
`v01-gate.e2e.test.ts`'s **TWO** contexts (`ctxA` happy-path + `ctxC` excluded-path
`FORBIDDEN_ZONE`) both set `allowRawDiff:true`. `vault_propose_edit` stays fully
implemented in core; only default *registration* moves.

---

## WU-6 — plugin: deletions and moves render unmistakably

- **Delete** renders as a **`DELETE <path>` header + the FULL content removed**
  (`-` lines). The held op carries no content and `renderApprovalDiff`
  (`server/src/render.ts`) is pure with no fs — so the **`/approvals` handler**
  (`server/src/app.ts`, which holds `ctx.vaultRoot`/`manifest`) reads the current
  file (bounded to the 64 KiB read ceiling — `/approvals` renders every pending
  row per call) and passes `deleteContent` into a widened `renderApprovalDiff`. A
  read failure of ANY kind (already absent, or defensively over-cap / non-text)
  renders a `— <path> unavailable` marker rather than throwing (N1 — one bad row
  must never 500 the whole `/approvals` render loop). **The CLI
  `ledger approve` renderer (`cli/src/commands/approve.ts` `renderHeldOperation`,
  also pure `(op)=>string`) needs the SAME vault-handle content-read** — else the
  terminal shows `"(no diff available)"` for the highest-consequence click.
- **Move** renders as **`MOVE <from> → <to>`, content unchanged** (no diff body —
  the bytes don't change; the reviewer approves the *relocation*).
- **`vault_list` / `vault_search` / `vault_read` need NO plugin work** — they
  don't queue approvals.
- **Plugin bumps on its own train** (manifest + esbuild rebuild + store/releases/
  `--install-plugin`), NOT npm.

---

## 5. Rejection codes

- **NEW: `DESTINATION_EXISTS`** (`retriable:true`; server map **409**, the
  `TARGET_EXISTS` family) — a `vault_propose_move` destination is occupied.
  Distinct from `TARGET_EXISTS` (create-onto-existing, non-retriable, "use edit")
  because the move remediation differs and IS retriable (pick another `to`, or
  delete the occupant). Added to `RejectionCode` + `RETRIABLE` + the server
  `Record<RejectionCode, number>`.
- **Reused:** `NOT_FOUND` (retriable at call sites — delete/move-source missing OR
  excluded, list/search on missing dir/file), `STALE_HASH` (drift), `LEDGER_GUARD`
  (governed delete/move), `FORBIDDEN_ZONE` (traversal/symlink, create/move-dest
  excluded).
- **New journal txn-op strings** `delete`, `move` (plain strings — `TransactionRow.op`
  is `string`, no enum change).

### Exhaustive tables that grow (name them all so the build stays green)

the op union at **`schemas/operation.ts` `ProposedOperation` discriminatedUnion**
(add `ProposeDeleteOp`, `ProposeMoveOp` — this is what makes the broker's
`const exhaustive: never` compile, N2); the broker `apply()` `switch`; the
`Approvals.approve()` `switch` (`case propose_delete`, `case propose_move`); the
catalog-count tables (§WU-5); the server `Record<RejectionCode,number>`
(`DESTINATION_EXISTS`). `vault_list`/`vault_search` are **standalone functions,
NOT ops** — they touch none of these.
- **`DESTINATION_EXISTS` is NOT stale-eligible (N3):** it's absent from
  reconcile's `STALE_ELIGIBLE_CODES`, so a move whose destination fills during the
  queue wait throws at approve and leaves the approval `pending` for the human to
  re-act — consistent with how `NOT_FOUND` at approve is handled; noted so it's a
  decision, not a surprise.

---

## 6. Path canonicalization — folded for ALL propose ops

Store the **canonical path** (the 0.4.6 `assertContained` `zonePath` — `..`/symlink
resolved, root-relative) in the queued op for edit/replace/create/delete/move,
instead of the raw `op.path`, so the approval queue always displays the real
target (highest-consequence for delete/move). Low regression risk (normal path:
`canonical === raw`; only `..`/symlink inputs change, to the truthful value).
Cosmetic caveat: replace/edit patch headers are generated from the raw path, so
the stored path and the header path can differ for a `..`/symlink input —
harmless (jsdiff ignores header paths; `patchTargetKind` only checks `/dev/null`)
— note it at the divergence. Retires the 0.4.6 display-path backlog item.

---

## 7. Freeze declaration (after merge + publish)

README + CLAUDE.md gain a **frozen-surface** statement: the v1 agent surface is
the 15 default tools above (`+vault_propose_edit` only via `--allow-raw-diff`);
**nothing new lands on the agent surface without something being removed**; only
bug fixes ship until an explicit un-freeze. Written so future sessions inherit the
freeze as a standing constraint (a new tool is now a deliberate un-freeze, not a
default).

---

## 8. Tests (fixtures from real observed data)

- **delete + undo byte-identical:** propose_delete a seeded note → approve → gone
  from disk + git → `undo` → restored, and the bytes **hash to the pre-delete
  digest** (the recoverability invariant; hash equality, not just "exists").
  **Run this BOTH with a git-tracked source AND an UNTRACKED source (B1 — the real
  Inbox shape):** the untracked case must baseline-commit then delete then
  undo-restore byte-identical; a test that only seeds a pre-committed source would
  mask the B1 data-loss bug.
- **move + undo round-trip:** propose_move `A → B` (incl. a rename and a
  file-into-new-subdir case) → approve → `A` gone, `B` present with identical
  bytes/hash, intermediate dir created → `undo` → back at `A`. **Also with an
  UNTRACKED source (B1)** — the untracked Inbox article must move + undo cleanly,
  not orphan the destination.
- **stale hashes** on both (delete + move-source) → `STALE_HASH`.
- **destination collision:** move onto an occupied `to` → `DESTINATION_EXISTS`
  (retriable).
- **cross-zone matrix, both directions:** move trusted→trusted (ok), trusted→
  excluded (`FORBIDDEN_ZONE` dest), excluded-source (`NOT_FOUND`, oracle);
  create/delete/read/list/search each on excluded (the principle table).
- **governed-memory:** delete of a governed note → `LEDGER_GUARD` + steering; move
  of a governed note → `LEDGER_GUARD` + steering (the WU-2 decision).
- **list omission oracle:** a dir containing a `Private/`-excluded entry + a normal
  entry → only the normal entry; **payload-identity check** — listing a dir whose
  only real entry is excluded is byte-identical to listing an empty dir; **empty
  dir vs missing dir** distinguished correctly (empty → `entries:[]`; missing →
  `NOT_FOUND`). **BOUNDARY test (S2):** `LIST_MAX_ENTRIES` visible entries + 1
  excluded produces a byte-identical payload (count AND `truncated`) to
  `LIST_MAX_ENTRIES` visible + 0 excluded — proving the filter precedes the cap.
- **move-dest occupancy-vs-zone precedence (S1):** move onto an *occupied
  excluded* destination → `FORBIDDEN_ZONE`, NEVER `DESTINATION_EXISTS` (zone
  before existence, so occupancy at an excluded path can't leak).
- **search never surfaces excluded content:** seed an excluded file containing the
  query verbatim + a trusted file that does NOT match → search returns **nothing**
  (no leak, no "skipped" signal); over-cap and non-UTF-8 files with the query →
  also nothing, indistinguishable from no-match.
- **NAMED capstone integration test — the field task:** seed the incident shape —
  an `Inbox/` article + an existing `Clients/Brandit/` hub — then drive the full
  loop with the real tools: **`vault_list` the Inbox → `vault_search`/`vault_read`
  to identify the article → `vault_propose_move` it into the discovered
  `Clients/Brandit/…` destination (creating the subfolder implicitly) → approve →
  assert `Inbox/` is left clean, the article is in the hub, and `recall`/`undo`
  still work.** This is the exact task Hermes couldn't do; it passing is the
  cycle's acceptance gate.

### Fixtures

Reuse the real Testing-note fixture (`test/fixtures/testingNote.ts`, 150 B, sha256
`55bf4472…`) for the delete e2e (deleting a "disposable test proposal" *is* its
cleanup; undo asserts the restored hash equals `TESTING_NOTE_SHA256`). Model the
capstone fixture on the real Inbox→Brandit incident shape (an article note + a
`Clients/Brandit/` hub folder), derived from the observed field scenario.

---

## 9. Non-goals (named explicitly for the freeze)

- **Batch operations** — one op = one approval = one legible audit line; no
  multi-file delete/move/create in a single call.
- **Regex search** — `vault_search` is case-insensitive literal only.
- **Recursive `vault_list`** — one directory level per call.
- **A search index** — plain bounded scan; no persisted index to build/invalidate.
- **Directory operations as first-class ops** — no dir create/delete/rename;
  directories exist only as an implicit side effect of moving a file into them.
- **Governed-memory moves** — plain docs only (WU-2 decision); memories relocate
  (if ever) through the lifecycle tools, not file moves.
- **A `to` hash on move** — the destination must be empty; nothing to pin.

---

## 10. Versioning & publish

- **core + mcp-server + server → their bumps.** core 0.4.7 (`propose_delete` +
  `propose_move` ops + `applyDelete`/`applyMove` + `listVaultDir` + `searchVault`
  + `DESTINATION_EXISTS` + the canonicalization fold). mcp-server 0.4.7 (the four
  new tools + `--allow-raw-diff` + catalog). **server → 0.4.1** (its first bump
  since 0.4.0 — the delete render + `/approvals` content-read live in
  `server/src/render.ts` + `app.ts`). cli **→ 0.4.2** (the `approve` delete/move
  render + content-read). plugin **own train** (delete/move render).
- Ordered publish **core → mcp-server** (+ server, + cli), same runbook. plugin
  separate.

## 11. Reviewer standing watch items (addressed)

- **Display-path canonicalization** — folded (§6).
- **Pending-approval interaction** — no pre-check; each queued op re-verifies at
  ITS OWN approve time. So: approving a delete/move of a file that another pending
  edit targets → that edit fails cleanly at its approve (`STALE_HASH`/`NOT_FOUND`);
  two pending deletes/moves of the same source → the second fails (`NOT_FOUND`,
  already gone/moved). Documented; §8 covers a delete-then-stale-edit case.
