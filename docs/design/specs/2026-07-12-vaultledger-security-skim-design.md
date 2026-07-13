# VaultLedger pre-public security skim — audit-plan design

**Date:** 2026-07-12
**Status:** Approved (brainstorm)
**Context:** First track of v1.0, run **before** npm/store publishing (not after): the
moment strangers can `npx` the tool, the carried v0.1 §12 deferrals (TOCTOU
check→write, symlink races, patch-bomb/size ceilings, the byte-identical-
outside-hunks lint) come due, and the agent-facing MCP surface becomes a real
attack path. This spec is the **audit plan**, not a feature design: it defines
scope, method, severity rubric, the disposition gate, and the deliverable. The
skim's output is a severity-ranked **findings doc** that becomes a durable record
for the publishing track ("reviewed X, fixed Y, accepted Z with rationale").

Baseline: `main` @ `f9376e1` (v0.4 shipped + exit-gated; 674 tests across 5
packages). §12 deferrals are documented at
`docs/design/specs/2026-07-02-vaultledger-v01-design.md:250-251, 480-487`.

**Process shape (deliberate bend of brainstorm→plan):** this spec IS the plan for
the *investigation*. The investigation is an execution phase that produces the
findings doc. After the human disposition gate, a SEPARATE `writing-plans` cycle
covers the **fix batch** for the items chosen to fix. Findings come **before**
fixes — nothing is fixed inline during the skim.

---

## Scope — 8 work units, ordered by worry

Each WU is a focused investigation mapped to a real surface. Investigators record
**every** finding (down to Info); severity/disposition handled per the rubric below.

### S1 — Concurrency & filesystem races (§12; **PoC-demonstrated, with negative controls**)
- **TOCTOU** check→write: `assertContainedAndReadable` is delegated via
  `resolveAbs` (`packages/core/src/broker/broker.ts:221-222`) and runs before fs
  mutation. The on-point anchor is the explicit `// v0.1 TOCTOU gap` comment in
  `applyRevise` (`broker.ts:307-309`): determine whether the hash-check
  (`expected_hash`) → write is inside the **same** `vault.lock` hold, and whether
  the lock makes check+write **atomic across all three writers** (broker apply,
  `undo`, the bridge) or merely narrows the window.
- **Symlink race**: realpath containment then write — a swap between check and
  write is the classic bypass. Evaluate `O_NOFOLLOW`-style open flags and/or
  re-check-under-lock.
- **Method — PoC with negative controls (the S1 analogue of red-before-green):**
  for each race, the harness must (a) reproduce corruption with the guard
  **disabled** — proving the harness *can* observe the failure — and (b) show
  no corruption with the guard **in place**. Because race PoCs are
  timing-dependent, a single run is insufficient: use either a **test-only
  synchronization hook that deterministically forces the check→write window
  open** (preferred — makes both controls deterministic), or failing that **N≥100
  repeated trials with a stated pass threshold (zero corruptions)**. A green "no
  corruption observed" that lacks the disable-and-see-it-fail control, or that
  rests on a single lucky run, is recorded as **inconclusive**, not "closed."
- **Inconclusive always escalates to the human**, regardless of the severity
  otherwise assigned — it never falls into Low/Info batch-approval.

### S2 — Patch / lint integrity (§12)
The markdownLint gap: `packages/core/src/broker/lint.ts` uses `matter()` parse
+ count-heuristics, not the byte-identical-**outside-hunks** guarantee. Now that
approved canonical revises are routine, determine whether an approved patch can
mutate bytes **outside its declared hunks** (frontmatter, other lines).
Adversarial patch tests; the fix (if warranted) is the outside-hunks assertion.

### S3 — Unguarded read path
`packages/core/src/contradiction/check.ts:40` **and** `:45` both
`readFileSync(join(vaultRoot, mem.path / peer.path))` with no
`assertContainedAndReadable`. Journal-sourced (low exploitability today), flagged
INFO in the b-2 review. Close for uniformity — assess whether journal `path`
values can ever be attacker-influenced (reindex from a hostile vault?).

### S4 — npx supply chain, hostile-vault parser DoS, **and input-size bounds**
- Supply chain: confirm **no** `postinstall`/`preinstall` scripts (none found in
  the first pass — verify across all packages), `pnpm audit` the tree.
- Hostile-vault parsers: `matter()`/js-yaml safety vs YAML-type attacks
  (`!!js/*`, aliases/billion-laughs) on frontmatter; the `diff` parser on hostile
  patch text; oversized notes into `extract`/`reindex` (parser DoS).
- **Resource bounds as a class (not just parsers):** the bridge has a
  `bodyLimit` (`server/src/app.ts:134`), but the **agent-facing MCP surface** —
  the primary attack path — has none: `memory_remember`/`memory_distill` take
  bare `z.string()`/`z.array()` with no `.max()` (`mcp-server/src/tools.ts:67,111`).
  Assess input-size bounds on the MCP write paths — a giant `remember` content,
  thousands of `sources[]` in a `distill`, a pathological patch. (The CLI has no
  free-content write command — write-content ops are MCP-only — so this is scoped
  to MCP, not the CLI.) Same DoS family; the npx audience makes it real.

### S5 — Bridge re-skim under new surfaces
Token/origin auth was tight at v0.2 — re-verify nothing since (conflicts routes,
audit additions) widened the surface, and that error paths never echo the bearer
token or absolute paths beyond intent.

### S6 — Secrets hygiene: **presence-scan, not just history-scan**
- History: scan git history for committed secrets (confirmation — the repo has
  been public-cloneable throughout).
- **In-flight (the runtime secret):** confirm the **bridge bearer token** has
  never been logged, written into a test fixture, or persisted anywhere **in the
  vault** — it lives in OS app-support by design (`bridge.json`, `0600`); verify
  nothing regressed that. Secrets-in-flight, not only secrets-in-history.

### S7 — Excluded-zone leakage re-sweep
Across everything added since the original zone tests: recall filters, staleness
`detail` strings (do they embed excluded content/paths?), `ledger memory audit`
output, and the new `--json` step results. Any surface that could reveal
excluded-zone content or paths.

### S8 — Obsidian plugin: token handling + XSS-defense invariant (the "store" surface)
The plugin (`packages/obsidian-plugin`) is the surface the opening line names as
the publishing trigger, and it renders **agent-produced, vault-derived content**
(diffs, notes, provenance, conflict details) inside Obsidian. Two properties to
re-verify hold across the views added since v0.2 (`activity.ts`, `approvals.ts`,
the conflicts tab):
- **Token hygiene (client side):** the plugin holds the bridge bearer token
  (`bridgeClient.ts`) — confirm it is never persisted via `saveData`, logged, or
  written into a fixture; it should live only in memory / app-support.
- **XSS-defense invariant:** `render.ts` states `innerHTML`/`insertAdjacentHTML`/
  `outerHTML` are never used — only `textContent`/`createEl({text})` — and
  `test/bundlePurity.test.ts` guards it. Verify every vault-derived string in the
  view files routes through `textContent`/`createEl({text})`, never markup
  interpolation, and that `bundlePurity.test.ts` still passes. A hostile
  diff/note that reached `innerHTML` would be script execution inside Obsidian.

---

## Method
- **Parallel subagent investigators**, one per WU (the subagent-driven pattern
  this project runs on). Each returns structured findings.
- **Adversarial verification** on every **High/Critical** finding before it's
  recorded — an independent pass that tries to refute the finding (or confirm the
  exploit) — so the record never carries a plausible-but-wrong claim. This is the
  same discipline that caught the real bugs in v0.4.
- **S1 PoC artifacts are kept**, not thrown away: race-repro scripts live under a
  referenced `security/poc/` path (gitignored but named in the findings doc) so
  the fix-time "prove closed" re-run uses the **same harness**, not a
  reconstruction. They are never imported by `src`.

---

## Severity rubric & the disposition gate

**Severity — calibrated by (exploitability × impact), one criterion per tier so
8 parallel investigators rank consistently:**
- **Critical** — remote/agent-triggerable with no human step, leads to silent
  data loss, containment escape (write/read outside the vault), or code execution.
- **High** — concrete exploit exists but needs a precondition (a specific vault
  shape, a race won under load, an approval); same impact classes as Critical.
  For S1, High/Critical **requires a PoC** (per the negative-control method).
- **Medium** — real weakness with a plausible but not-yet-demonstrated exploit,
  or a DoS/availability issue, or a defense-in-depth gap on a path currently
  guarded elsewhere.
- **Low** — hardening / uniformity gap with no concrete exploit today (e.g. the
  S3 unguarded read while `path` is journal-sourced).
- **Info** — observation, no security consequence on its own.

**Per-finding record fields:**
`ID (stable, e.g. VL-SEC-S1-01) · title · location (file:line) · description ·
exploit scenario / PoC result · severity + rationale · recommended disposition
(fix / accept-with-rationale) · [after fix] outcome`. The **stable ID** is the
cross-reference key from the fix-batch plan and commit messages — it survives
refactors that move the `file:line`.

**Disposition gate has a severity floor (so sign-off stays meaningful):**
- **Medium-and-up** → escalated to the human for **explicit fix/accept sign-off**.
- **Low / Info** → carry a **recommended disposition** the human can
  **batch-approve or spot-check**. Info noise never competes with real risk for
  attention.
- **Aggregation pass (before batching):** at findings-doc assembly, group related
  Low/Info findings by shared surface or attack path (e.g. the S3 unguarded read
  + any path-influence finding), and **promote the cluster to Medium** — i.e.
  into the explicit-sign-off tier — if the *combined* risk is real. A severity
  floor that reviews Lows only in isolation would miss risk that only exists in
  aggregate; this pass is what closes that hole.

**Accept-with-rationale requires an expiry condition (live record, not a
snapshot):** every accepted risk names the **condition under which it stops being
acceptable** — e.g. "accept until multi-user / shared-vault lands," "accept while
single-machine-local." This is precisely the failure mode that bit v0.1 (the
single-writer assumption silently expired when the bridge added a second writer):
an accept without an expiry condition is not a valid disposition.

---

## Deliverable & flow

**Deliverable:** `docs/design/specs/2026-07-12-vaultledger-security-skim-findings.md`
— the severity-ranked findings doc (published-record shape, like the design
docs). Sortable by severity; each finding carries the fields above.

**Flow:**
1. **Investigate** — parallel investigators per WU → structured findings; High/
   Critical adversarially verified; S1 PoCs (with negative controls) run.
2. **Findings doc** assembled, severity-ranked.
3. **Disposition gate** — assembly runs the aggregation pass first (related Low/
   Info clusters promoted to Medium if combined risk is real); then Medium+ (and
   any **inconclusive** S1 result) go to the human for fix/accept sign-off (each
   accept with an expiry condition); remaining Low/Info batch-approved.
4. **Fix batch** — a `writing-plans` cycle over the fix-dispositioned items, then
   subagent-driven execution with two-stage review; each fix re-verified, and
   **S1 fixes re-run the kept PoC harness to prove closure** (both controls).
5. **Doc updated** to the final record: reviewed X, fixed Y (with outcome),
   accepted Z (with rationale + expiry).

---

## Out of scope (this skim)
- The fixes themselves (separate post-disposition `writing-plans` cycle).
- Formal external pentest / paid audit.
- Multi-user / shared-vault threat model (explicitly a *future* condition that
  several S1/S-accept entries will reference as their expiry trigger).
- npm/store publishing mechanics (the next v1.0 track, gated on this skim).
