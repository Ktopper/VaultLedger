import { applyPatch as diffApply, parsePatch } from "diff";
import { BrokerError } from "../errors.js";

/**
 * Apply a unified-diff patch to `original`, guarding against oversized or
 * unparseable patches.
 *
 * - Throws SYNTAX_BREAK if the patch text has no parseable hunks, if it spans
 *   more than one file (jsdiff's applyPatch only accepts a single input), if a
 *   hunk header miscounts its +/- lines (jsdiff's parser throws), or if the
 *   patch's context does not match `original` closely enough to apply.
 * - Throws PATCH_TOO_LARGE if EITHER the fraction of changed lines OR the
 *   fraction of changed bytes (added + removed hunk lines, across all hunks)
 *   relative to the original exceeds `threshold`. The byte guard stops a
 *   single-line edit from silently rewriting thousands of bytes — common in
 *   Obsidian's unwrapped paragraphs.
 *
 * Any error thrown by jsdiff's parser or applier is converted into a clean
 * SYNTAX_BREAK rejection; the function never surfaces a raw Error. Our own
 * BrokerError rejections (e.g. PATCH_TOO_LARGE) propagate unchanged.
 */
export function applyPatch(original: string, patchText: string, threshold = 0.5): string {
  try {
    const parsed = parsePatch(patchText);
    if (parsed.length === 0 || parsed.every((f) => f.hunks.length === 0)) {
      throw new BrokerError("SYNTAX_BREAK", "unparseable or empty patch");
    }
    if (parsed.length !== 1) {
      throw new BrokerError(
        "SYNTAX_BREAK",
        `patch spans ${parsed.length} files; only single-file patches are supported`,
      );
    }

    let changedLines = 0;
    let changedBytes = 0;
    for (const file of parsed) {
      for (const h of file.hunks) {
        for (const l of h.lines) {
          if (l.startsWith("+") || l.startsWith("-")) {
            changedLines += 1;
            // Exclude the leading +/- marker from the byte count.
            changedBytes += l.length - 1;
          }
        }
      }
    }

    // Strip a single trailing newline so a file ending in "\n" isn't counted as
    // having one extra (empty) line.
    const normalized = original.endsWith("\n") ? original.slice(0, -1) : original;
    const originalLines = Math.max(normalized.split("\n").length, 1);
    const originalBytes = Math.max(original.length, 1);

    const lineRatio = changedLines / originalLines;
    const byteRatio = changedBytes / originalBytes;
    if (lineRatio > threshold || byteRatio > threshold) {
      throw new BrokerError(
        "PATCH_TOO_LARGE",
        `patch changes ${changedLines} lines / ${changedBytes} bytes ` +
          `(> ${threshold * 100}% of ${originalLines} lines / ${originalBytes} bytes)`,
      );
    }

    const result = diffApply(original, patchText);
    if (result === false) {
      throw new BrokerError("SYNTAX_BREAK", "patch did not apply cleanly");
    }
    return result;
  } catch (e) {
    // Preserve our own typed rejections (SYNTAX_BREAK, PATCH_TOO_LARGE, ...);
    // only foreign errors from jsdiff's parser/applier are reclassified.
    if (e instanceof BrokerError) throw e;
    throw new BrokerError(
      "SYNTAX_BREAK",
      `patch could not be parsed or applied: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
