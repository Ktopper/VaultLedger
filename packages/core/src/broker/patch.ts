import { applyPatch as diffApply, parsePatch } from "diff";
import { BrokerError } from "../errors.js";

/**
 * Apply a unified-diff patch to `original`, guarding against oversized or
 * unparseable patches.
 *
 * - Throws SYNTAX_BREAK if the patch text has no parseable hunks, or if the
 *   patch's context does not match `original` closely enough to apply.
 * - Throws PATCH_TOO_LARGE if the fraction of changed lines (added + removed,
 *   across all hunks) relative to the original line count exceeds `threshold`.
 */
export function applyPatch(original: string, patchText: string, threshold = 0.5): string {
  const parsed = parsePatch(patchText);
  if (parsed.length === 0 || parsed.every((f) => f.hunks.length === 0)) {
    throw new BrokerError("SYNTAX_BREAK", "unparseable or empty patch");
  }

  let changed = 0;
  for (const file of parsed) {
    for (const h of file.hunks) {
      changed += h.lines.filter((l) => l.startsWith("+") || l.startsWith("-")).length;
    }
  }

  const originalLines = Math.max(original.split("\n").length, 1);
  if (changed / originalLines > threshold) {
    throw new BrokerError(
      "PATCH_TOO_LARGE",
      `patch changes ${changed} lines (> ${threshold * 100}% of ${originalLines})`,
    );
  }

  const result = diffApply(original, patchText);
  if (result === false) {
    throw new BrokerError("SYNTAX_BREAK", "patch did not apply cleanly");
  }
  return result;
}
