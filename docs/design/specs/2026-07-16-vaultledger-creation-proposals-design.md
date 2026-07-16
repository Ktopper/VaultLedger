# VaultLedger — `vault_propose_edit` supports new-file creation (0.4.4)

**Date:** 2026-07-16
**Status:** design (pre-implementation)
**Source:** field finding #5 (live Hermes). `vault_propose_edit` and the approval
path disagree about nonexistent targets.

## The finding that makes this non-negotiable (read first)

`applyPatch` (jsdiff) does NOT reject a diff/target mismatch — it silently
CORRUPTS. Verified by running it (2026-07-16):

- **Creation diff (`--- /dev/null`) applied to an EXISTING file → jsdiff
  PREPENDS the new content** onto the old (`applyPatch("existing\n",
  creationDiff)` → `"# Test\nhello\nexisting\n"`). Not an error — corruption.
- **Deletion diff (`+++ /dev/null`) applied to content → jsdiff yields `""`**
  (`applyPatch("# Test\nhello\n", deletionDiff)` → `""`). It silently EMPTIES
  the file.

So the diff↔target **pairing gate below is not about nice error messages — it
is the only thing preventing silent data corruption.** This sentence is the
invariant that must survive every future refactor: a `vault_propose_edit` whose
patch cannot be *correctly* applied to its target's actual state must never
enter the queue, and must never be applied.

## The repro (confirmed post-0.4.3 by running it, not reading)

A well-formed `--- /dev/null` creation diff against a nonexistent path
`Testing/VaultLedger Approval Queue Test.md`:
- (a) `assertPatchParseable(diff)` → **PASSES** (it is a valid unified diff),
- (b) `vault_propose_edit` → **QUEUES** (an unapplyable proposal enters the queue),
- (c) approve → `applyRevise` → `broker.ts:310-311` `if (!existsSync(abs)) throw
  NOT_FOUND "target not found"` → **dies at approve**.

The 0.4.3 patch-format fix guards *parseability*; this gap is *pairing* —
independent, and in the silent-corruption class above.

---

## Decision: SUPPORT new-file creation

An agent proposing a new standards doc into the trusted zone is a legitimate
governed write, and the unified-diff standard already has the native creation
convention (`--- /dev/null`, `+++ b/path`, `@@ -0,0 +N @@`). Design review
confirms SUPPORT fits one cycle: the apply machinery (`create` + its undo)
exists, containment already resolves nonexistent paths via the deepest existing
ancestor, and jsdiff applies a `/dev/null` diff to `""` cleanly. **Reject-early
is the honest fallback** if build surprises us — and the propose-time pairing
check below IS reject-early, so the degradation is free.

---

## 1. The pairing gate (propose-time — the load-bearing guard)

Detect the diff kind by its **header**, via `parsePatch`'s `oldFileName` /
`newFileName` (NOT by `oldLines === 0` — a legitimate insert-at-top of an
*existing* file also has a hunk with `oldLines: 0`; only `--- /dev/null` marks a
true creation). Three cases, all decided at propose time, in the broker where
the patch is parsed:

| Diff kind | Signal | Rule | Mismatch → reject at propose (retriable) |
|---|---|---|---|
| **creation** | `oldFileName === "/dev/null"` | target must NOT exist | target exists → `TARGET_EXISTS` "creation diff, but <path> already exists" |
| **normal edit** | neither is `/dev/null` | target MUST exist | target absent → `NOT_FOUND` "edit diff, but <path> does not exist" |
| **deletion** | `newFileName === "/dev/null"` | **unsupported** | always → `SYNTAX_BREAK` "file deletion via vault_propose_edit is not supported" |

- **Deletion is rejected, not silently applied.** A `+++ /dev/null` patch would
  otherwise empty the note (jsdiff yields `""`) — neither a deletion nor an edit
  anyone proposed. Rejecting it (retriable, so the agent learns the boundary)
  makes silently-emptying-a-note impossible today. Deletion-as-a-feature is a
  separate future decision, explicitly out of scope.
- All three reject with a **retriable** error whose message names the reason, so
  the agent can fix-and-retry (same contract as the 0.4.3 format gate).

## 2. Propose-time appliability guarantee for creations (dry-run — strongest invariant)

An edit's appliability depends on file state at approve time, so propose can only
check parseability. But **a creation's output is fully determined by the patch
alone** — `applyPatch("", patch)` needs no file and is deterministic, and it is
*exactly* the operation approve will perform. So the creation branch of the
propose gate **dry-runs `applyPatch("", op.patch)`**; if it throws, reject at
propose (retriable). This upgrades the invariant for creations from "nothing
unparseable enters the queue" to **"no creation that cannot be applied enters the
queue"** — the strongest form available, essentially free.

## 3. `expected_hash` semantics — symmetric, schema-honest

`expected_hash` becomes **schema-optional** on `propose_edit`; the *conditional*
requirement is enforced in the broker (where the patch is parsed and the kind is
known):

- **Normal edit WITHOUT a hash → reject** (unchanged from today — the edit path
  is not weakened).
- **Creation WITH a hash → reject** ("creations take no `expected_hash`"). An
  agent supplying a hash for a file that doesn't exist is confused about the
  world; ignoring the hash would hide that confusion. Symmetric enforcement
  keeps the schema honest.
- **Apply-time analog of the stale-hash check, for creations:** the check
  becomes **"the file still does not exist."** A file that appeared between
  propose and approve is a **conflict → clean `TARGET_EXISTS` rejection**, never
  an overwrite and never jsdiff's silent prepend.

## 4. Zone + containment on a would-be path (mostly unchanged) + parent dirs

- `resolveZone(target, manifest)` works on a nonexistent path already —
  excluded/agent-zone rules unchanged; a creation into an excluded path is
  rejected exactly as an edit would be.
- `assertContainedAndReadable` resolves containment via the **deepest existing
  ancestor** (containment.ts:76-81) — so a traversal (`../`) in the new path is
  rejected, several-levels-up ancestors work, and the returned `abs` is the
  containment-verified would-be path.
- **Intermediate directories:** `writeContainedFile` does NOT mkdir (it
  `openSync`s a temp in `dirname(abs)` → ENOENT if the parent is absent —
  confirmed; the live repro's `Testing/` did not exist). So the apply-create
  path **creates the intermediate dirs under the containment-verified ancestor**
  before the write. Because `abs = join(verifiedAncestor, …remaining)` and
  traversal is already rejected, `mkdir` of `dirname(abs)` lands strictly under
  the verified ancestor; `writeContainedFile` then re-runs its realpath
  containment check as the final guard (defense in depth). The spec/plan pins
  the exact ordering (resolve containment → mkdir parents → writeContainedFile).
- **Undo of a creation** deletes the file (the existing `create`-undo path does
  exactly this — broker.ts comment at :383). **Decision (not oversight): undo
  leaves any intermediate directories it created behind** (empty). Git does not
  track empty dirs, and removing them would require tracking what the create
  made vs what pre-existed — not worth it; a stray empty `Testing/` is harmless.

## 5. Apply-create path

On approve of a creation proposal (an approved `revise`/apply whose patch is a
creation diff):
1. re-assert the target **still does not exist** (§3 race → `TARGET_EXISTS`);
2. `applyPatch("", op.patch)` → the new content (dry-run already proved this at
   propose, but apply recomputes — never trusts the queue);
3. mkdir intermediate dirs (§4), `writeContainedFile(...)` the content — stamp
   **nothing** beyond the patch content (no injected frontmatter);
4. commit via the **normal transaction path** (same as `create`), so the journal
   records it and `ledger undo` reverts the creation cleanly.

Placement mirrors `applyRevise`'s guard ordering: traversal/zone first, then the
pairing/kind branch, then the existence/hash analog, then apply+write+commit.

## 6. Plugin diff rendering (VERIFY, don't assume)

`render.ts` builds diff DOM via `textContent` only (security-hardened). A
creation diff (`--- /dev/null` + all-`+` lines) will *display* as literal text —
legible. The spec-grounding / build **checks render.ts against a real creation
diff** and decides whether a small "new file" affordance (a label) is warranted;
functional legibility is the bar, the affordance is optional.

## 7. Tool description

`vault_propose_edit`'s description documents the creation convention:
`to CREATE a new file, use the unified-diff creation form: --- /dev/null,
+++ b/<path>, @@ -0,0 +N @@. Editing requires the file to exist; file deletion
is not supported.`

## 8. Tests (mirror each case; several are the corruption-class siblings)

- valid creation proposal → queues → approve **creates + commits** → `undo` removes the file.
- nonexistent target + **normal** diff → propose-time reject (retriable `NOT_FOUND`).
- existing target + **creation** diff → propose-time reject (retriable `TARGET_EXISTS`) — the silent-prepend corruption case.
- **deletion** diff (`+++ /dev/null`) → propose-time reject (retriable, "not supported") — the silent-empty corruption case.
- creation into an **excluded** path → rejected (zone).
- **traversal** in the new path (`../escape.md`) → rejected (containment).
- creation **with** an `expected_hash` → rejected (symmetric hash).
- normal edit **without** a hash → rejected (unchanged).
- **race**: file appears between propose and approve → clean `TARGET_EXISTS` at apply, no overwrite.
- **nonexistent parent dir** (`Testing/new.md`, `Testing/` absent) → approve creates the dir + file; undo removes the file (empty dir may remain — asserted as the decided behavior).
- **propose-time dry-run**: a creation diff that parses but cannot apply to `""` → rejected at propose (retriable).

---

## Versioning & publish

- **core + mcp-server → 0.4.4.** core: the pairing gate + dry-run + apply-create
  in the broker. mcp-server: `expected_hash` schema-optional + the tool
  description. cli stays 0.4.1, server 0.4.0.
- Ordered publish **core → mcp-server**, same runbook.
- `verify-publish.mjs` (reads each sibling's local version) passes the graph —
  verify, don't assume.
- doctor `major.minor` keeps cli 0.4.1 ↔ mcp-server 0.4.4 quiet (both 0.4).

## Post-land follow-ups (not code)
- Remove the interim "don't propose new files" line from Hermes's standing prompt.
- Note the `--- /dev/null` creation convention near the memory skill's rule 6
  (writes go through the tools — and here's how to create).

## File structure
**Modify (core):** `broker/broker.ts` (`applyProposeEdit` pairing gate + dry-run; the apply path's creation branch), possibly `broker/patch.ts` (a `patchTargetKind(patchText)` helper returning `"create" | "edit" | "delete"` from `oldFileName`/`newFileName`), `schemas/operation.ts` (ProposeEditOp `expected_hash` optional), `broker/containment.ts` only if the mkdir belongs there (prefer the apply path).
**Modify (mcp-server):** `tools.ts` (ProposeEdit input `expected_hash` optional + description).
**Modify (tests):** `core/test/broker/` (all §8 cases), version bump set (core VERSION + placeholder test, mcp SERVER_VERSION, both package.json).
**Verify:** `obsidian-plugin/src/render.ts` against a creation diff (§6).

## Non-goals
- File deletion via `vault_propose_edit` (rejected today; separate future decision).
- Multi-file patches (still single-file, unchanged).
- Removing empty dirs on undo (decided §4).
- Any change to the normal-edit path's behavior beyond `expected_hash` becoming schema-optional-but-conditionally-required.
