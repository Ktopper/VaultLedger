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
 * Canonicalize an arbitrary JSON-ish value so two values that differ only in
 * object-key order compare equal via JSON.stringify: object keys are sorted
 * recursively; array order IS significant (reordering array elements is a
 * real change) so arrays are walked element-wise but not reordered.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const out: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
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
 * A non-string entity normalizes to `null` so "no entity" is comparable. */
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
  return JSON.stringify(canonicalize(beforeSlice)) !== JSON.stringify(canonicalize(afterSlice));
}
