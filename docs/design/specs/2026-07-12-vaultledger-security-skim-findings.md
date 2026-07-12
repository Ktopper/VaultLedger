# VaultLedger pre-public security skim — findings

**Date:** 2026-07-12
**Status:** Findings recorded; awaiting human disposition (Medium+).
**Method:** 8 work-unit investigators (S1–S8) per the audit plan
(`2026-07-12-vaultledger-security-skim-design.md`), each recording findings
only; every High/Critical adversarially verified by an independent refute-first
pass; S1/S2 races/relocation PoC-demonstrated with negative controls. PoC
harnesses under `security/poc/` (gitignored; re-runnable at fix-time).
**Baseline:** `main` @ `f9376e1` (v0.4), skim branch `feat/v1-security-skim`.

## Executive summary

The skim found **3 Critical, 4 High, 4 Medium, 7 Low** and many Info. Every
Critical and High is PoC-proven. This is the record for the publishing track:
**do not `npx`-publish until the Criticals and the agent-triggerable Highs are
dispositioned.** Good news up front: the §12 **TOCTOU check→write debt is
effectively closed** by the vault lock (S1-01, Low); the **supply-chain posture
is sound** (no lifecycle scripts, correct pnpm build-allowlist, S4-06); and
**S5 (bridge), S6 (secrets), S8 (plugin XSS/token) came back clean**.

| # | Severity | ID | One-line |
|---|---|---|---|
| 1 | **Critical** | VL-SEC-S1-02 | Symlink swapped into the check→write window redirects a governed write outside the vault (lock is no defense). |
| 2 | **Critical** | VL-SEC-S7-03 | Default `setup` writes root-anchored `Private/**`; a nested `Private/` folder is silently NOT excluded — correct user action, silent failure. |
| 3 | **Critical** | VL-SEC-S2-01+03 | An agent-crafted patch whose header lies about its landing line gets human-approved and rewrites governed `ledger:` provenance (approved path skips the guard). |
| 4 | High | VL-SEC-S7-01 | `reindex()` is zone-blind — indexes excluded-zone notes into the journal → `recall` surfaces their metadata. |
| 5 | High | VL-SEC-S7-02 | Chains S7-01 + S3 unguarded read → excluded note *content* into `conflicts.detail` out through CLI/HTTP. |
| 6 | High | VL-SEC-S4-01 | `diff@7.0.0` (CVE-2026-24001): an 8-byte `memory_revise` patch OOM-crashes the MCP server. |
| 7 | High | VL-SEC-S4-03 | YAML anchor bomb OOMs `governedProvenanceChanged`'s canonicalize (~600 bytes, via `memory_revise`). |
| 8 | Medium | VL-SEC-S3-03 | Unguarded `check.ts` read is a content-disclosure primitive into the audit trail (contingent on S3-01). |
| 9 | Medium | VL-SEC-S2-04 | Only `ledger:`+`entity` frontmatter is governed; any other key is unprotected against revise. |
| 10 | Medium | VL-SEC-S7-04 | `ledger_status` returns `excluded` globs verbatim to the agent (existence/path disclosure). |
| 11 | Medium | VL-SEC-S4-05 | MCP inputs have no `.max()` anywhere; `propose_edit` defers a parser-bomb crash to approval time. |

Lows (7): S1-01, S2-05, S3-01, S7-05, S7-06, S8-02, S4-06(dev-deps). Info: many.

---

## Critical

### VL-SEC-S1-02 — Symlink race: governed write escapes the vault
**Location:** `packages/core/src/broker/containment.ts:62-92` (realpath check, once), `broker.ts:278` (check) → `:355` (`writeFileSync(abs, after)`, follows symlinks, no re-check, no `O_NOFOLLOW`).
**Description:** Containment is realpath-checked once, early, and returns a plain path. Between the check and the write there's a wide window (patch apply, guards, `await git.fileAtHead()`, a possible baseline commit). Swapping the target to an outside-pointing symlink in that window makes the final `writeFileSync` follow it, landing a governed write outside the vault. The `vault.lock` is cooperative-advisory among VaultLedger's own writers and provides **zero** defense against a symlink swap by any other local process.
**PoC / verification (CONFIRMED Critical):** `security/poc/s1-symlink.mjs` — outside canary overwritten with patched content, `apply()` returns `{ok:true}`, no rollback; identical with and without the lock. Refutation failed (`writeFileSync` no `ELOOP`; `reconcile` never re-hashes disk; journal `hash_after` computed from memory). Race is *necessary* — a pre-existing outside symlink IS caught (`FORBIDDEN_ZONE`). Real un-hooked window **measured at ~7 ms (steady revise) / ~90–170 ms (first-edit baseline commit)** — winnable by a local `fs` watcher an agent can spawn (agents driving MCP typically also have Bash/FS access); failed attempts are free.
**Severity rationale:** Critical — agent-triggerable, no human step, containment escape (write outside vault), PoC-confirmed.
**Recommended disposition — FIX (no expiry):** re-verify the **full ancestor chain** with zero intervening `await` immediately before a non-following leaf write (`O_NOFOLLOW` open via fd, or temp-file + `renameSync` into a realpath-verified parent), all under the lock. Honest residual: a microsecond ancestor-*directory* swap window remains (Node has no `openat`/`renameat`) — document as sharply-reduced, not eliminated.

### VL-SEC-S7-03 — Nested "Private" folder silently under-excluded (default setup)
**Location:** `packages/core/src/scan/scanner.ts:170` (`hasPrivate` = `PRIVATE_FOLDER_RE` over *all* folder names, any depth) vs `:189-190` (writes root-anchored `"Private/**"`).
**Description:** The scan detects a folder named "Private" at any depth but writes a root-anchored exclusion glob. A vault with `Agent/Memory/Private/` or `Projects/ClientX/Private/` gets a manifest that *reports* `hasPrivate: true` and proposes `excluded: ["Private/**"]`, but `resolveZone` classifies the nested folder as `agent`/`trusted`. Reproduces from a **completely default `ledger setup --yes`** — no override, no reindex.
**PoC / verification (confirmed by controller):** `resolveZone("Agent/Memory/Private/secret.md")` → `"agent"`; `"Projects/ClientX/Private/notes.md"` → `"trusted"`; only root `"Private/secret.md"` → `"excluded"`. With that manifest, `broker.apply({op:"create"})` into the nested folder succeeds with no approval, and `assertContainedAndReadable` passes so `/provenance?path=Agent/Memory/Private/secret.md` returns its frontmatter instead of `403`.
**Severity rationale:** Critical — the human did exactly what the design asks (name a folder "Private", approve the proposed exclusion) and the tool silently fails to honor it; no misconfiguration, no precondition; both the write gate and the flagship hardened read gate are defeated for the nested folder.
**Recommended disposition — FIX (no expiry):** `scanVault` writes `**/Private/**` (unanchored) whenever `hasPrivate` fires (safer per "choose auditability"); add a `ledger init`/`doctor` invariant asserting every `PRIVATE_FOLDER_RE` match resolves to `excluded` under the proposed manifest before printing success.

### VL-SEC-S2-01 + VL-SEC-S2-03 — Approved patch rewrites governed provenance via hunk relocation
**Location:** `packages/core/src/broker/patch.ts:84` (`diffApply` no options), `broker.ts:330` (`if (!approved && governedProvenanceChanged(...))` — guard skipped when approved), `approvals/queue.ts` `dispatchApply` (approved revise/propose_edit), `cli/src/commands/approve.ts:50-61` + `server/src/render.ts:38-70` (both render the raw patch).
**Description:** jsdiff's `applyPatch` does not require a hunk to land at its declared `@@` line — `distanceIterator` searches the whole document for a content match (regardless of `fuzzFactor`) and applies there; `patch.ts` never checks the landing position. So a patch header can claim an innocuous body line while its context matches a `ledger:`/`entity` frontmatter line. On the **approved** path (`approved:true`), `governedProvenanceChanged` is skipped — and both approval renderers print the raw (lying) patch, not the actually-applied bytes.
**PoC / verification (CONFIRMED, escalated to Critical):** `security/poc/s2-broker-e2e.mjs` (S2-01: header line 13 rewrote frontmatter line 6 through the real broker, real commit). `security/poc/s2-03-approved-provenance.mjs` (the escalation): a `propose_edit` header claiming line 9 body, context `status: working` (actually line 3 in `ledger:`), run through the real `Approvals.approve` → **`ledger.status` flipped working→canonical, `applied:true`, guard skipped.** The skip is a *documented, unit-tested, accepted* tradeoff (`store.ts:488-495`, `broker.test.ts:972`) whose stated safety is "the approval diff is the human's one chance to catch a smuggled change" — S2-01 makes that diff lie, silently defeating the one control. S2-02 positive control holds: on the *unapproved* path `governedProvenanceChanged` (whole-file, hunk-agnostic) catches it → `LEDGER_GUARD`.
**Severity rationale:** Critical — agent-craftable, requires only the normal human "approve", defeats both informed consent and the ledger governance model (the product's core value: "every mutation attributable").
**Recommended disposition — FIX (no expiry), both required:** (1) **landing-position verification in `patch.ts`** — after `diffApply`, `diffLines(before, after)` and assert every changed line falls within the union of the patch's *declared* hunk ranges (± explicit fuzz), else `SYNTAX_BREAK` (restores "rendered diff == applied change" for all fields). (2) **Defense-in-depth:** split the `approved` boolean — keep the guard bypass only for internal privileged callers (`flipFrontmatterStatus`), and have the generic `dispatchApply` revise/propose_edit path **always** run `governedProvenanceChanged`.

---

## High

### VL-SEC-S7-01 — `reindex()` is zone-blind
**Location:** `packages/core/src/memory/reindex.ts:201-237`, `:70-86` (`walkMarkdownFiles`).
**Description:** `reindex()` upserts any ledger-tagged `.md` under `Agent/Memory`/`Agent/Archive` (or a caller `agentGlobs`) into the journal without `resolveZone`/containment. An override nesting an `excluded` zone inside those dirs, or a stray ledger note there, gets indexed → `recall` (= `memory_recall` / `GET /memories`) returns its `path`/`entity`/`tags`/`status`/`reason` to the agent. PoC `security/poc/s7-01-*`. Reindex is a routine disposable-journal-rebuild op, so the precondition is plausible.
**Recommended disposition — FIX:** thread the manifest into the walk; skip/report any discovered path resolving to `excluded`.

### VL-SEC-S7-02 — Excluded content leaks into `conflicts.detail`
**Location:** `check.ts:40,45` (unguarded read) + `detector.ts:87-91` (value embedded verbatim).
**Description:** Once an excluded note is journal-resident (S7-01) sharing an entity, `checkContradictions` reads its content unguarded and, on a fact-key collision, writes its real value verbatim into `conflicts.detail` → surfaced by `ledger conflicts` / `GET /conflicts`. PoC `security/poc/s7-02-*` leaked an `ssn:`. Reachable via CLI/HTTP (not an MCP tool); zero human step for a shell-capable agent once the precondition holds.
**Recommended disposition — FIX:** jointly close S7-01 (reindex gate) + route `check.ts` reads through `assertContainedAndReadable` (same fix as S3-01).

### VL-SEC-S4-01 — `diff@7.0.0` parser infinite-loop / OOM (CVE-2026-24001)
**Location:** `patch.ts:40` (`parsePatch`) ← `broker.ts:319` ← `tools.ts` `ReviseInput.patch` (`z.string().min(1)`, no max).
**Description:** An 8-byte patch with an embedded `\r` in the `--- ` header (`"--- a\rb\n"`) makes `parseIndex` consume zero lines; the caller loops forever, leaking memory → OOM (~1.7 s under a 512 MB cap). Reachable from `memory_revise` on any scratch/working memory (default) with no human step; crashes the MCP server and abandons the vault lock (self-heals in 20 s). Pre-write, so no data loss (→ High, not Critical). PoC `security/poc/s4-01-*`. Size limits do **not** help (8 bytes suffices).
**Recommended disposition — FIX:** upgrade `diff` → `^8.0.3` in all 5 declaring packages; add `.max()` bounds as defense-in-depth.

### VL-SEC-S4-03 — YAML anchor "billion laughs" OOM in `governedProvenanceChanged`
**Location:** `lint.ts:121-166` (`canonicalize` materializes js-yaml's shared alias references into distinct objects, then `JSON.stringify`s them).
**Description:** js-yaml resolves aliases as references (safe parse, ~0 ms), but `canonicalize`'s naive recursion defeats that protection — ~600 bytes of nested anchors in a `ledger:` block → OOM. Runs on every *unapproved* `memory_revise` (the common immediate-apply path); the OOM happens while *computing* the changed-verdict, before it's reached. PoC `security/poc/s4-03-*`.
**Recommended disposition — FIX:** memoize `canonicalize` by object identity (`WeakMap`/`WeakSet` visited-set) — fixes the DoS and makes the guard reference-aware; cap frontmatter size/depth as defense-in-depth.

---

## Medium

### VL-SEC-S3-03 — Unguarded read is a content-disclosure primitive
`check.ts:40/45` read + `detector.ts` → `conflicts.detail` verbatim → CLI unredacted. Contingent on S3-01's precondition (no live producer today). PoC demonstrated. **FIX** (same containment gate as S3-01). Expiry if `detail` is ever exposed via a lower-trust surface → reassess upward.

### VL-SEC-S2-04 — Only `ledger:`+`entity` frontmatter is governed
`lint.ts:113-126` `governedSlice` hardcodes the protected slice; a correctly-addressed honest revise of `deadline:` or any custom key passes with zero signal. Impact depends on whether any governance logic reads a non-`ledger:`/`entity` key (today: no). **Recommended: FIX** (invert to an explicit allowlist) **or accept-with-rationale + expiry** (revisit the moment any matcher/staleness/logic keys off another frontmatter field).

### VL-SEC-S7-04 — `ledger_status` leaks `excluded` globs to the agent
`tools.ts:331-336` (+ CLI `status`, `GET /status`) return `manifest.zones.excluded` verbatim; the MCP tool is agent-callable with no precondition. Existence/path disclosure (not content); rises toward High if overrides encode person/file names. **Recommended: FIX** (redact `excluded` from agent-facing surfaces, keep in human CLI) **or accept + expiry** (revisit before overrides are expected to carry human-identifying literals).

### VL-SEC-S4-05 — No input-size bounds on the MCP surface
`tools.ts` `content`/`patch`/`sources`/`tags`/`reason` have no `.max()`; MCP stdio `ReadBuffer` is unbounded. Blast radius: giant `remember` content → permanent git-history bloat (persists after `forget`); millions of `sources[]` → synchronous SQLite block starving all ops; a pathological `propose_edit` patch is stored and its crash **deferred to `ledger approve`** (a time-bomb on the human). **FIX:** `.max()` on every free-text/array field + element caps (align to the bridge's 16 KiB), + a stdio pre-parse length check.

---

## Low (recommended batch-approve as FIX unless noted)

- **VL-SEC-S1-01** — TOCTOU check→write **is** lock-atomic for all three writers (PoC-confirmed); the §12 debt is effectively closed. Residual: `lockDir` is optional in the public `Broker`/`undo` API (an embedder could construct unlocked), and the stale `// v0.1 TOCTOU gap` comment (`broker.ts:307-309`) misleads. **FIX:** make `lockDir` non-optional (or an explicit `"unsafe-no-lock"` sentinel); remove the stale comment. Expiry: any new host constructing `Broker` outside `openVault`/`context`, or shared-vault.
- **VL-SEC-S2-05** — No non-overlapping/monotonic hunk-order validation. **FIX:** fold into the S2-01 fix (assert hunks sorted by `oldStart`, non-overlapping).
- **VL-SEC-S3-01** — `check.ts` reads bypass `assertContainedAndReadable` (no live producer, S3-02). **FIX:** thread manifest → gate both reads (also closes S3-03/S7-02).
- **VL-SEC-S7-05** — `recall()` has no defense-in-depth zone re-check. **FIX opportunistically:** re-check `resolveZone(row.path)` before returning, filter+log excluded rows. Low urgency if S7-01/03 fixed at source.
- **VL-SEC-S7-06** — `reindex()`'s public `agentGlobs` param has no zone validation (not currently reachable). **FIX:** covered by S7-01 if gated at the file-check level.
- **VL-SEC-S8-02** — `bundlePurity.test.ts` guards native-module leaks, **not** the XSS invariant (which today rests only on source discipline + `render.ts`-only unit tests; `activity/approvals/hover` have zero coverage of it). **FIX:** extend the forbidden list to `innerHTML=`/`insertAdjacentHTML(`/`.outerHTML=`/`document.write(`/`dangerouslySetInnerHTML` against the built bundle. Expiry: close before any PR adds DOM-write code outside `render.ts`.
- **VL-SEC-S4-06 (dev-deps)** — `vitest@2.1.9` (Critical, dev-only, unreachable), `vite`/`esbuild` (Moderate, dev-only). **FIX opportunistically** — not in any shipped `npx` path. Expiry: re-check before next major.

## Info (confirmed-clean / context — no action)
S2-02 (positive control), S2-06 (size guard position-blind, subsumed), S3-02 (no live path-injection producer — load-bearing negative), S4-02 (gray-matter `safeLoad`, no code-exec), S4-04 (no ReDoS in extract), S4-06 (no lifecycle scripts, correct pnpm allowlist), **S5-01..08** (bridge auth global, no widening, no token/path leak — live-verified), **S6-01..07** (no committed secrets; token never in-vault/logged/persisted), S7-07/08/09 (audit/stale-source/setup-json clean), **S8-01/03** (plugin DOM path `textContent`-only; token never persisted/logged). Optional hardening noted: gitignore `.npmrc` pre-emptively (S6-03).

---

## Fix clusters (for the post-disposition `writing-plans` batch)
- **A · Containment (Critical):** S1-02 — ancestor-chain re-check + `O_NOFOLLOW`/temp-rename, no intervening await, under lock.
- **B · Zone exclusion (Critical + 2 High + Med + 2 Low):** S7-03 glob anchor; S7-01 reindex `resolveZone` gate; S3-01/S3-03/S7-02 `check.ts` containment gate; S7-04 redact excluded from agent surfaces; S7-05/06 defense-in-depth. (One theme: thread the manifest through every read/index path.)
- **C · Patch integrity & governance (Critical + Med + Low):** S2-01 landing-position verification; S2-03 split the `approved` bool; S2-04 frontmatter-key allowlist; S2-05 hunk-order.
- **D · MCP DoS / hardening (2 High + Med):** S4-01 upgrade `diff`; S4-03 memoize `canonicalize`; S4-05 zod `.max()` bounds.
- **E · Misc hardening (Low):** S8-02 bundle XSS guard; S1-01 `lockDir` non-optional + stale-comment; S6-03 gitignore `.npmrc`; dev-dep bumps.

## Disposition (to be completed at the gate)
Medium-and-up require explicit human fix/accept sign-off (each accept names an
expiry condition); Low/Info batch-approved. Recorded here after the gate as:
reviewed → **fixed** (outcome + commit) / **accepted** (rationale + expiry).
