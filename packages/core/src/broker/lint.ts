import matter from "gray-matter";
import { BrokerError } from "../errors.js";

/**
 * v0.1 markdown structure-preservation lint (design §5).
 *
 * The spec's ideal check is "byte-identical outside the hunks" (see §12),
 * which requires diff-aware tooling this package doesn't yet have. Until
 * that lands, `assertStructurePreserved` uses four deterministic,
 * count-based heuristics instead:
 *
 *   1. Frontmatter integrity — if `before` has a closed YAML frontmatter
 *      block, `after` must still parse via gray-matter without throwing and
 *      must still have a closed frontmatter block.
 *   2. Wikilink non-decrease — the number of `[[...]]` occurrences in
 *      `after` must be >= the number in `before`. This is deliberately
 *      conservative: a legitimate patch that *removes* a wikilink is
 *      rejected. Acceptable for v0.1.
 *   3. Block-reference non-decrease — same rule, for `^block-id` markers.
 *   4. Callout-header non-decrease — same rule, for `> [!type]` callout
 *      headers.
 *
 * NOTE ON THE SIGNATURE: the current `(before, after)` signature is what v0.1
 * needs — these heuristics only compare aggregate token counts, so the patch
 * text is genuinely not required and is intentionally not a parameter. A
 * stricter future checker (byte-identical outside the hunks, per §12) will
 * need the patch text — specifically the hunk line ranges — to know which
 * regions are allowed to change, and will therefore likely change this
 * signature. Do not treat the current signature as permanently stable.
 */

const FRONTMATTER_BLOCK = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;
const WIKILINK = /\[\[[^\]]+\]\]/g;
const BLOCK_REF = /\s\^[A-Za-z0-9-]+$/gm;
const CALLOUT_HEADER = /^\s*>\s*\[![A-Za-z]+\]/gm;

function count(re: RegExp, text: string): number {
  return text.match(re)?.length ?? 0;
}

export function assertStructurePreserved(before: string, after: string): void {
  const hadFrontmatter = FRONTMATTER_BLOCK.test(before);
  if (hadFrontmatter) {
    let parsedOk: boolean;
    try {
      matter(after);
      parsedOk = true;
    } catch {
      parsedOk = false;
    }
    if (!parsedOk || !FRONTMATTER_BLOCK.test(after)) {
      throw new BrokerError("SYNTAX_BREAK", "frontmatter block was corrupted or removed");
    }
  }

  const beforeLinks = count(WIKILINK, before);
  const afterLinks = count(WIKILINK, after);
  if (afterLinks < beforeLinks) {
    throw new BrokerError(
      "SYNTAX_BREAK",
      `wikilink count decreased (${beforeLinks} -> ${afterLinks})`,
    );
  }

  const beforeRefs = count(BLOCK_REF, before);
  const afterRefs = count(BLOCK_REF, after);
  if (afterRefs < beforeRefs) {
    throw new BrokerError(
      "SYNTAX_BREAK",
      `block-reference count decreased (${beforeRefs} -> ${afterRefs})`,
    );
  }

  const beforeCallouts = count(CALLOUT_HEADER, before);
  const afterCallouts = count(CALLOUT_HEADER, after);
  if (afterCallouts < beforeCallouts) {
    throw new BrokerError(
      "SYNTAX_BREAK",
      `callout-header count decreased (${beforeCallouts} -> ${afterCallouts})`,
    );
  }
}

/**
 * Deep-equality over an arbitrary JSON-ish value pair, where object-key
 * order is insignificant (two objects that differ only in key order compare
 * equal) and array order IS significant (reordering array elements is a
 * real change).
 *
 * VL-SEC-S4-03: js-yaml (via gray-matter) resolves YAML anchors/aliases
 * (`*name`) as shared object REFERENCES, not copies -- a document using the
 * same anchored array/map at several keys parses in near-constant time. The
 * original implementation built a fresh, fully-materialized canonical COPY
 * of the whole tree (`value.map(canonicalize)` / per-key rebuild, no
 * memoization) and then `JSON.stringify`'d it for comparison. Both steps
 * independently re-walk every shared reference from scratch every time it's
 * encountered, turning reference sharing into an EXPONENTIAL blowup (a
 * depth-N fan-out of breadth-B anchors visits ~B^N nodes): a ~600-byte
 * hostile `ledger:` block is enough to OOM-crash the process, and this runs
 * synchronously on every unapproved `memory_revise` (governedProvenanceChanged).
 *
 * IMPORTANT: memoizing the copy-then-stringify step alone is NOT sufficient
 * -- even if the recursive COPY is memoized by input identity (so it isn't
 * re-allocated on every visit), the resulting copy still has the exact same
 * exponential fan-out SHAPE, and `JSON.stringify` has no concept of shared
 * references: it walks every logical position in that shape and re-emits
 * text for it, so serializing it is still exponential regardless of how
 * cheaply the copy itself was produced. The only way to avoid that is to
 * never build a full copy or stringify anything at all -- compare `before`
 * and `after` PAIRWISE, node by node, and memoize by the (nodeA, nodeB) PAIR
 * so a shared sub-structure that's compared more than once is only ever
 * actually walked once.
 *
 * `canonicalEqual` memoizes three ways, all keyed by object IDENTITY (a
 * `WeakMap<object, WeakSet<object>>` from the `a`-side node to the set of
 * `b`-side nodes it's been paired with):
 *   - `trueCache` / `falseCache`: once a pair has been fully compared and
 *     resolved, every later encounter of the SAME pair reuses that result
 *     instead of re-walking -- this collapses the fan-out DAG case from
 *     exponential back down to linear in the number of DISTINCT node pairs.
 *   - `inProgress`: marks a pair as "currently being compared", checked
 *     BEFORE recursing into it. Required for correctness, not just speed: a
 *     completed-cache ALONE is not enough for a genuinely CYCLIC anchor
 *     (`&a {self: *a}`) on either side -- that pair's cache entry isn't
 *     written until its own recursive call returns, so re-entering it from
 *     inside its own subtree would recurse forever (stack overflow) before
 *     ever reaching the cache. Re-entering an in-progress pair is treated as
 *     equal (the two structures are self-consistent along every cycle
 *     reachable so far); any real difference elsewhere in the pair's
 *     comparison still fails it via a different branch.
 *
 * A top-level shape mismatch (different key sets, different array lengths,
 * a primitive vs. an object) short-circuits immediately without ever
 * recursing into either side's deep structure.
 *
 * KNOWN, INTENTIONAL divergences from the old canonicalize+JSON.stringify
 * comparator (both unreachable/fail-safe here, called out so a future reader
 * knows they're deliberate, not bugs): (1) an explicit JS `undefined`-valued
 * key participates in the key-set comparison here whereas JSON.stringify
 * dropped it — moot because YAML/gray-matter never produces an `undefined`
 * value (absent keys simply don't exist; `~`/`null` parse to JS `null`);
 * (2) `NaN` compares UNequal to itself (`a === b` is false for NaN), so a
 * governed field that were somehow NaN reads as "changed" — strictly safer
 * (fails toward requiring approval), and again unreachable since YAML has no
 * bare NaN scalar in a governed field today.
 */
function canonicalEqualInner(
  a: unknown,
  b: unknown,
  inProgress: WeakMap<object, WeakSet<object>>,
  trueCache: WeakMap<object, WeakSet<object>>,
  falseCache: WeakMap<object, WeakSet<object>>,
): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false; // a === b already handled identical primitives/null above
  }
  const objA = a as object;
  const objB = b as object;

  if (trueCache.get(objA)?.has(objB)) return true;
  if (falseCache.get(objA)?.has(objB)) return false;
  if (inProgress.get(objA)?.has(objB)) return true; // cyclic re-entry: consistent so far

  let inSet = inProgress.get(objA);
  if (inSet === undefined) {
    inSet = new WeakSet();
    inProgress.set(objA, inSet);
  }
  inSet.add(objB);

  const arrayA = Array.isArray(a);
  const arrayB = Array.isArray(b);
  let result: boolean;
  if (arrayA !== arrayB) {
    result = false;
  } else if (arrayA && arrayB) {
    const arrA = a as unknown[];
    const arrB = b as unknown[];
    result =
      arrA.length === arrB.length &&
      arrA.every((v, i) => canonicalEqualInner(v, arrB[i], inProgress, trueCache, falseCache));
  } else {
    const recA = a as Record<string, unknown>;
    const recB = b as Record<string, unknown>;
    const keysA = Object.keys(recA).sort();
    const keysB = Object.keys(recB).sort();
    result =
      keysA.length === keysB.length &&
      keysA.every((k, i) => k === keysB[i]) &&
      keysA.every((k) => canonicalEqualInner(recA[k], recB[k], inProgress, trueCache, falseCache));
  }

  inSet.delete(objB);
  const cache = result ? trueCache : falseCache;
  let cacheSet = cache.get(objA);
  if (cacheSet === undefined) {
    cacheSet = new WeakSet();
    cache.set(objA, cacheSet);
  }
  cacheSet.add(objB);

  return result;
}

function canonicalEqual(a: unknown, b: unknown): boolean {
  return canonicalEqualInner(a, b, new WeakMap(), new WeakMap(), new WeakMap());
}

/** Extract the `ledger` frontmatter field from a parsed gray-matter data
 * object, normalizing "absent" or "not an object" to `null` so "no ledger
 * block" is a well-defined, comparable value. */
function normalizeLedger(data: Record<string, unknown>): unknown {
  const ledger = data.ledger;
  return ledger !== null && typeof ledger === "object" ? ledger : null;
}

/** The governed-provenance slice of a note's parsed frontmatter: the `ledger:`
 * block PLUS the top-level `entity` field. `entity` is deliberately NOT part
 * of the `ledger:` block (see MemoryProvenance — it has no entity) but it IS a
 * governed field: the contradiction matcher keys its same-entity comparison
 * set on it, so silently rewriting/removing it drops a belief from every
 * comparison — exactly the evasion this guard exists to stop. `tags` is
 * intentionally excluded: it is descriptive metadata that gates no behavior.
 * A non-string entity normalizes to `null` so "no entity" is comparable.
 *
 * VL-SEC-S2-04 — THE BOUNDARY IS INTENTIONAL, NOT AN OVERSIGHT: every OTHER
 * frontmatter key (`deadline:`, `priority:`, any agent-defined custom key,
 * `tags` per above) is deliberately UNGOVERNED. This is the fact-update
 * model: an agent must be free to revise facts in its own memory's
 * frontmatter (e.g. correcting a `deadline:`) WITHOUT triggering an approval
 * requirement. The tempting-looking "fix" of widening this slice to cover
 * all frontmatter would silently break that model — every routine fact edit
 * would start demanding human approval. So do NOT add keys here to close a
 * hypothetical gap unless a REAL governance/decision path (an approval-bypass
 * gate, the entity comparison-set membership, or a status-transition decision
 * — see `contradiction/matcher.ts`'s `DefaultEntityMatcher`, `memory/store.ts`'s
 * `flipFrontmatterStatus`, `broker/undo.ts`'s status-from-ledger derivation)
 * is found to key off that key. As of this writing, an audit of every
 * frontmatter-parsing call site in `packages/core/src` confirms nothing does:
 * the only OTHER frontmatter reads are `tags` (memory/reindex.ts, stored but
 * never used for gating) and the intentionally-broad, NON-gating fact
 * extraction in `contradiction/extract.ts` (feeds contradiction/staleness
 * ADVISORY conflict detection, not approval decisions). See
 * `governedSlice.driftInvariant` in lint.test.ts, which locks this fact down:
 * it fails if a future change makes `governedProvenanceChanged` sensitive to
 * some field other than `ledger`/`entity` without a matching update here. */
function governedSlice(data: Record<string, unknown>): unknown {
  return {
    ledger: normalizeLedger(data),
    entity: typeof data.entity === "string" ? data.entity : null,
  };
}

/**
 * Governance guard (v0.3a, provenance tamper closure): does the note's
 * governed provenance — the `ledger:` block (status/supersedes/...) plus the
 * top-level `entity` field — differ between `before` and `after`, canonically
 * (a mere key reorder is NOT a change)?
 *
 * Deliberately narrower than `assertStructurePreserved` — it looks ONLY at the
 * governed slice, ignoring the body and every other frontmatter key, so an
 * unapproved revise that edits body text or an unrelated fact field (e.g.
 * `deadline:`) is unaffected.
 *
 * Adding a ledger block/entity where there was none, or removing one entirely,
 * both count as CHANGED: the absent side normalizes to `null`, which never
 * canonically equals a present value.
 *
 * v0.3b's `derivation`, `retired_reason`, `superseded_by`, and `score` all
 * live INSIDE the `ledger:` block, so this whole-block comparison already
 * covers them by construction — no change was needed here to guard them
 * (see broker.test.ts's LEDGER_NOTE_V03B tests for the locking regression).
 */
export function governedProvenanceChanged(before: string, after: string): boolean {
  let beforeSlice: unknown;
  let afterSlice: unknown;
  try {
    beforeSlice = governedSlice(matter(before).data as Record<string, unknown>);
  } catch {
    // Defensive: shouldn't happen (callers run this after
    // assertStructurePreserved, which already proved `before`/`after` parse),
    // but an unparsable input is treated as "changed" rather than silently
    // passing the guard.
    return true;
  }
  try {
    afterSlice = governedSlice(matter(after).data as Record<string, unknown>);
  } catch {
    return true;
  }
  return !canonicalEqual(beforeSlice, afterSlice);
}
