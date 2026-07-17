# VaultLedger — structured propose surfaces (0.4.5)

**Date:** 2026-07-16
**Status:** design (pre-implementation)
**Source:** field finding #6 (live Hermes). **An interface finding, not a bug.**

## The finding

Agents produce structurally valid unified diffs with **wrong hunk coordinates** —
`@@ -1,1` placeholders for text actually at line 32/190, overlapping hunks. The
broker's strict landing check (VL-SEC-S2-01/S2-05) **correctly rejects** them.
The check is right; the **API is wrong** — it asks the model to do line
arithmetic it is structurally bad at. The fix is not to loosen the check; it is
to stop asking the agent for coordinates at all. Move diff generation to the
broker, where it is mechanical and correct by construction.

**Feasibility de-risked by running it (2026-07-16):** replacements → new content
→ `createPatch(path, old, new)` produces correct hunk headers
(`@@ -8,9 +8,9 @@`), and the **broker's HARDENED `applyPatch` (the strict
landing check) PASSES** with output matching. The generated diff sails through
the exact check the agent's hand-written diff fails.

---

## The design: two single-purpose sibling tools

The tool description IS the agent's UX — an agent bad at diffs should never be
shown diff vocabulary. Applying that one level down splits **create** from
**replace**, because merging them reintroduces the conditional-`expected_hash`
shape 0.4.4 spent a cycle making structurally impossible (replace needs the hash
to pin its snapshot; create has nothing to hash). **Two tools make the rule
structural, not conditional:**

| Tool | Input | `expected_hash` | Generates |
|---|---|---|---|
| **`vault_propose_replace`** | `{path, expected_hash, replacements: [{old_text, new_text, expected_occurrences?=1}]}` | **required field** | an EDIT diff |
| **`vault_propose_create`** | `{path, content}` | **field absent** | a `--- /dev/null` CREATE diff |
| `vault_propose_edit` (unchanged) | `{path, expected_hash?, patch}` | conditional (0.4.4) | — (raw diff) |

Catalog 9 → 11. `vault_propose_edit` stays for the rare caller holding a genuine
diff. No conditional enforcement in the new tools, no wrong-mode invocations —
each description is one sentence an agent can't misread.

**Both new tools feed the EXISTING `applyProposeEdit`** with a broker-generated
patch, so 0.4.4's pairing gate, dry-run, Option B, and every downstream stage
(queue storage, render, approval, apply, undo, landing checks) are **inherited,
not re-implemented**. The structured forms are a thin generation layer at the
propose boundary; nothing below them knows.

---

## 1. `vault_propose_replace` — the generation, atomic and hash-pinned

One broker call does read → verify → generate → enqueue (never a separate
build step — see the rejected `vault_build_patch` alternative):

1. **Read + hash-verify the snapshot.** `assertContainedAndReadable(vaultRoot,
   manifest, path)` → `readFileSync` → `hashFile`. If the content's hash ≠
   `expected_hash` → **`STALE_HASH`** (the replacements would match the wrong
   snapshot). This pins the exact content the replacements are found in.
2. **Reject an empty `old_text` up front** (retriable input error) — `"".indexOf`
   matches at every position and would produce pathological counts/overlaps.
3. **For each replacement, exact-match find + count** — `old_text` located by
   **non-overlapping left-to-right substring scan** (`indexOf`, advance past each
   match by the match length; so `"aa"` in `"aaaa"` is 2, deterministic and
   matching the splice). **No fuzz, no regex, no normalization.**
   - **0 occurrences → retriable `TEXT_NOT_FOUND`** ("text not found in <path>").
     (A NEW retriable code — NOT `NOT_FOUND`, which is non-retriable in the enum
     and reserved for genuinely-missing files; see §5.)
   - **count ≠ `expected_occurrences` (default 1) → retriable `AMBIGUOUS_MATCH`**
     ("found N occurrences of the text, expected M — include more surrounding
     context to disambiguate").
4. **Overlap rejection (multiple replacements, one snapshot).** Compute every
   replacement's match span(s) against the ORIGINAL content; if any two spans
   **overlap → retriable `OVERLAPPING_REPLACEMENTS`**. (Applying against the one
   snapshot, not sequentially against a mutating string, is what makes "multiple
   replacements" well-defined.)
5. **Splice all replacements from the original** → `newContent`. If
   `newContent === oldContent` (a true no-op — every `old_text === new_text`) →
   retriable `SYNTAX_BREAK` "no changes" (thrown explicitly with `retriable:true`,
   since SYNTAX_BREAK defaults non-retriable; cleaner than letting it surface as
   the empty-diff "no parseable hunks").
6. **`createPatch(path, oldContent, newContent)`** → the canonical unified diff.
   **Self-check (cheap propose-time dry-run):** `applyPatch(oldContent,
   generatedDiff) === newContent` before enqueue — the edit branch of
   `applyProposeEdit` does NOT run `applyPatch` at propose (only the create
   branch does), so the landing check first runs at APPROVE; a dry-run here
   surfaces any generation bug at propose instead. Safe by construction, cheap
   insurance.
7. **Feed the existing `applyProposeEdit`** as `{path, expected_hash, patch:
   generatedDiff}`. Its edit branch (0.4.4) runs — the target exists, the hash
   is present, the landing check passes by construction.
   - **Double hash check is intentional:** propose-time (step 1, so the
     replacements matched the right snapshot) AND apply-time (0.4.4's
     `applyRevise` hash compare, so the file hasn't drifted during the
     queue-wait — a drift there is a clean `STALE_HASH` at approve).

**A no-op replace** (`old_text === new_text`, or a replacement that changes
nothing) yields an empty diff → reject retriably (`SYNTAX_BREAK` "no changes"),
consistent with the parse gate's empty-patch rejection.

## 2. `vault_propose_create` — structured creation ({path, content})

Generate a **`/dev/null`-headed creation diff** → the EXISTING `applyProposeEdit`
create branch (0.4.4). Spares agents hand-writing creation diffs — the same
class of arithmetic replace removes.

- **CRITICAL (spec-review, verified by running jsdiff): `createPatch(path, "",
  content)` does NOT produce a `/dev/null` diff.** jsdiff uses the filename you
  pass **verbatim** on both `---`/`+++`, so `patchTargetKind` (keys off
  `oldFileName === "/dev/null"`) returns **`edit`** → the create tool would hit
  the edit branch → `NOT_FOUND` "edit diff, but <path> does not exist" →
  **reject every creation**, and Option B (in the create branch) would never
  run. The generator MUST use the **two-filename `structuredPatch` form**:
  `structuredPatch("/dev/null", <path>, "", content, "", "")` + `formatPatch`.
  Verified: `oldFileName === "/dev/null"`, `newFileName === <path>` (the real
  path), formatted headers `--- /dev/null` / `+++ <path>`, `patchTargetKind`
  "create", applies EXACT to `""`, reaches Option B.
  - **Do NOT use `createPatch("/dev/null", "", content)` (the sibling trap).**
    `createPatch` takes ONE filename and writes it on **both** header lines, so
    it produces `--- /dev/null` AND `+++ /dev/null`. That still classifies as
    `create` (patchTargetKind checks `oldFileName` first) — so it *works*, while
    queueing an artifact that reads simultaneously as a creation AND a deletion:
    misleading in the approval render and to anything that keys on `newFileName`
    for path display. The two-filename form is mandatory; §6 pins it with a test
    asserting the generated diff's `newFileName` is the real path, not `/dev/null`.

- **Option B is inherited for FREE.** `applyProposeEdit`'s create branch already
  runs `governedProvenanceChanged("", newContent)` (0.4.4 + the apply-time
  hardening), so a `vault_propose_create` whose `content` carries a `ledger:`
  block / top-level `entity:` is rejected identically — the structured form does
  not weaken the governance boundary because it doesn't touch it.
- No `expected_hash` (structural — the field isn't in the tool schema).

## 3. Downstream is UNCHANGED (the whole point)

The queue stores the **generated diff**, so `GET /approvals` rendering, the
plugin's diff view, human approval, `applyRevise`, `undo`, and the S2-01/S2-05
landing checks all operate exactly as today. **The landing checks pass by
construction** — jsdiff computed the coordinates from the actual content, so
they can't lie about where a hunk lands. Zero changes below the propose
boundary.

---

## 4. Rejected alternative — `vault_build_patch` helper (document it)

A tool that takes replacements, returns a built patch, and lets the agent then
call `vault_propose_edit` with it. **Rejected** for the exact reason this track
exists:
- It reintroduces the agent **handling a diff** (the corruptible thing — the
  agent can mangle it in transit, defeating the purpose).
- A **stale window** opens between build and propose (the file can change).
- An extra **round-trip**.
Generation and propose MUST be one atomic broker call against the hash-pinned
snapshot — which is what the two sibling tools do.

---

## 5. Broker representation

Two new ops in the `ProposedOperation` union — `propose_replace` and
`propose_create` — each with a handler that generates the patch and **delegates
to the existing propose-edit core** (rather than duplicating the enqueue path):

- The generation logic is a **pure, independently-testable helper**
  `generateReplacementPatch(path, oldContent, replacements): string` (find +
  count + overlap + splice + `createPatch`) — no I/O, so its occurrence/overlap
  rules are unit-tested without a vault.
- The op handlers do the I/O (read + hash-verify for replace; nothing for
  create), call the helper (replace) or generate a **`/dev/null`-headed** create
  diff (create — §2), then construct a `propose_edit`-shaped op `{op:"propose_edit",
  path, expected_hash, patch, session, reason}` and call `applyProposeEdit`
  directly. **Spec-review confirmed `applyProposeEdit` is already the shared
  body** — it needs only path/expected_hash/patch and does the gates+enqueue, so
  a generated patch feeds straight in (an explicit refactor is optional tidy, not
  required). For a create, the handler supplies no `expected_hash` (the create
  branch forbids it).

New rejection codes (add to the RejectionCode enum + RETRIABLE map, **all
retriable:true**): `TEXT_NOT_FOUND`, `AMBIGUOUS_MATCH`, `OVERLAPPING_REPLACEMENTS`.
**Do NOT reuse `NOT_FOUND` for "text not found"** — `RETRIABLE.NOT_FOUND = false`
in the enum (reserved for genuinely-missing files, correctly non-retriable), so
overloading it would tell the agent NOT to retry a fully-retriable "add more
context" case. Reuse `STALE_HASH` (snapshot drift) and `SYNTAX_BREAK`
(no-op / empty diff — thrown with explicit `retriable:true`).

---

## 6. Tests

- **NAMED ground-check (a real jsdiff round-trip):** `generateReplacementPatch`
  on multi-line content with edits at lines ~12 and ~32 → the generated diff,
  fed to the **hardened `applyPatch`** (the strict landing check), **passes** and
  yields exactly the spliced content. (Load-bearing feasibility claim — verified
  in the brainstorm; pin it.)
- **NO-TRAILING-NEWLINE round-trip** (real vault notes constantly lack one — the
  fiddly `\ No newline at end of file` case): content ending WITHOUT a trailing
  newline, replacement near the end → generated diff → hardened `applyPatch` →
  EXACT spliced output. (Verified at spec-review: jsdiff emits the no-newline
  marker and round-trips exact — this pins it against regression.)
- **create diff `newFileName` is the REAL path, not `/dev/null`** — assert the
  generated creation diff's `newFileName === <path>` (the two-filename
  `structuredPatch` form), guarding the sibling trap where a one-filename
  `createPatch("/dev/null", …)` would put `/dev/null` on both headers.
- `generateReplacementPatch` unit: exact single match → correct diff; 0 matches
  → `TEXT_NOT_FOUND` (retriable); 2 matches with `expected_occurrences:1` →
  `AMBIGUOUS_MATCH`; 2 matches with `expected_occurrences:2` → both replaced;
  overlapping-same-`old_text` count determinism (`"aa"` in `"aaaa"` → 2, not 3);
  **empty `old_text` → retriable input reject**; two replacements whose spans
  overlap → `OVERLAPPING_REPLACEMENTS`; two non-overlapping replacements → both
  applied against the one snapshot; no-op (old===new) → retriable `SYNTAX_BREAK`
  "no changes"; **the self-check dry-run** (`applyPatch(old, generated) ===
  new`) passes for a valid replacement.
- **replace end-to-end**: `vault_propose_replace` on a real file with wrong-line
  text (the field repro: text at line 32, agent gives no coordinates) → queues a
  correct diff → approve applies → undo reverts. Stale hash → STALE_HASH.
- **create end-to-end**: `vault_propose_create {path, content}` → queues a
  `/dev/null` diff → approve creates → undo removes. Content with a `ledger:`
  block → rejected (Option B inherited). Existing target → TARGET_EXISTS.
- **downstream-unchanged**: the queued op's stored patch is a normal unified
  diff; the render/approve/apply path is exercised identically to a raw
  `propose_edit` (no new rendering code).

---

## 7. Versioning & publish

- **core + mcp-server → 0.4.5.** core: the two ops + the generation helper +
  rejection codes. mcp-server: the two new tools. cli 0.4.1, server 0.4.0,
  plugin 0.4.1 unchanged.
- Ordered publish **core → mcp-server**, same runbook. `verify-publish` passes
  the graph (verify, don't assume). doctor major.minor stays quiet.

## 8. Interplay with 0.4.4 (concrete, not hypothetical)

0.4.5 is the natural companion to 0.4.4: 0.4.4 built the **creation-diff
plumbing** (pairing gate, create branch, Option B); 0.4.5 gives agents a
**structured way to drive it** without writing the diff. `vault_propose_create`
generates a `/dev/null`-headed creation diff (§2) into the 0.4.4 create branch.
Do NOT fold the two cycles — 0.4.4 shipped (merge 767b9bd); this is the next
cycle, built on top.

## 9. Post-land follow-ups (not code)
- **Memory skill:** steer agents to `vault_propose_replace` / `vault_propose_create`
  for edits/creations — "describe the change as find/replace or full content;
  don't hand-write unified diffs" — near rule 6 (writes go through the tools).
- **Integration guides:** document the two structured tools as the default edit
  path; `vault_propose_edit` (raw diff) as the advanced/tool-holds-a-diff case.

## File structure
**Modify (core):** `schemas/operation.ts` (two new ops in the union), `errors.ts`
(two retriable codes), `broker/broker.ts` (two handlers + factor the shared
propose-edit gate/enqueue body), a new `broker/generateReplacementPatch.ts` (the
pure helper) or fold into patch.ts. **Modify (mcp-server):** `tools.ts` (two new
tools). **Tests:** core generation helper + broker end-to-end; mcp-server tool
wiring. **Version:** core VERSION + placeholder test, mcp SERVER_VERSION, both
package.json.

## Non-goals
- Fuzz/regex/normalized matching (exact substring only — determinism is the point).
- Structured DELETION (deletion is rejected at propose, unchanged — separate future).
- Any change below the propose boundary (queue/apply/undo/render untouched).
- Multi-file structured ops (single-file, unchanged).
