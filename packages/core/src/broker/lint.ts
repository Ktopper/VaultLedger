import matter from "gray-matter";
import { BrokerError } from "../errors.js";

/**
 * v0.1 markdown structure-preservation lint (design §5).
 *
 * The spec's ideal check is "byte-identical outside the hunks" (see §12),
 * which requires diff-aware tooling this package doesn't yet have. Until
 * that lands, `assertStructurePreserved` uses three deterministic,
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
 *
 * The signature is stable so a stricter (byte-identical-outside-hunks)
 * checker can replace this implementation later without touching callers.
 */

const FRONTMATTER_BLOCK = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;
const WIKILINK = /\[\[[^\]]+\]\]/g;
const BLOCK_REF = /\s\^[A-Za-z0-9-]+$/gm;

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
}
