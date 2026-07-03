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
