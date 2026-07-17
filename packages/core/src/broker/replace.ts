import { createPatch, formatPatch, structuredPatch } from "diff";
import { BrokerError } from "../errors.js";
import { applyPatch } from "./patch.js";

interface Replacement {
  old_text: string;
  new_text: string;
  expected_occurrences?: number;
}

/** All non-overlapping left-to-right match spans of `needle` in `hay`
 * (advance past each match by its length, so "aa" in "aaaa" is 2 — matching
 * the splice). `[start, end)`, end-exclusive. */
function findSpans(hay: string, needle: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx < 0) break;
    spans.push({ start: idx, end: idx + needle.length });
    from = idx + needle.length;
  }
  return spans;
}

/**
 * Pure, I/O-free: turn a set of exact find/replace edits against a known
 * snapshot into a canonical unified-diff EDIT. No fuzz, no regex, no
 * normalization — exact substring only, determinism is the point.
 *
 * Throws (all retriable): SYNTAX_BREAK on empty old_text or a no-op splice;
 * TEXT_NOT_FOUND on 0 matches; AMBIGUOUS_MATCH on count != expected_occurrences;
 * OVERLAPPING_REPLACEMENTS when two replacements' spans overlap in the one
 * snapshot. Throws INVARIANT_VIOLATION (non-retriable) if the generated diff
 * fails to round-trip — a generation bug, not caller input.
 */
export function generateReplacementPatch(
  path: string,
  oldContent: string,
  replacements: readonly Replacement[],
): string {
  const spans: Array<{ start: number; end: number; newText: string }> = [];
  for (const r of replacements) {
    if (r.old_text.length === 0) {
      throw new BrokerError("SYNTAX_BREAK", "old_text must not be empty", true);
    }
    const found = findSpans(oldContent, r.old_text);
    const want = r.expected_occurrences ?? 1;
    if (found.length === 0) {
      throw new BrokerError("TEXT_NOT_FOUND", `text not found in ${path}`, true);
    }
    if (found.length !== want) {
      throw new BrokerError(
        "AMBIGUOUS_MATCH",
        `found ${found.length} occurrences of the text, expected ${want} — include more ` +
          `surrounding context to disambiguate (${path})`,
        true,
      );
    }
    for (const s of found) spans.push({ ...s, newText: r.new_text });
  }

  // Overlap across ALL replacements, against the ORIGINAL content.
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  for (let i = 0; i + 1 < sorted.length; i++) {
    if (sorted[i]!.end > sorted[i + 1]!.start) {
      throw new BrokerError(
        "OVERLAPPING_REPLACEMENTS",
        `two replacements overlap in ${path}; drop or merge one`,
        true,
      );
    }
  }

  // Splice from the original in span order.
  let out = "";
  let cursor = 0;
  for (const s of sorted) {
    out += oldContent.slice(cursor, s.start) + s.newText;
    cursor = s.end;
  }
  out += oldContent.slice(cursor);

  if (out === oldContent) {
    throw new BrokerError("SYNTAX_BREAK", "no changes", true);
  }

  const diff = createPatch(path, oldContent, out);

  // Correctness self-check (spec §1.6): prove the generated diff round-trips
  // through the HARDENED applyPatch (strict landing S2-01/S2-05) before it can
  // enqueue. threshold=Infinity disables the SIZE ratio on purpose — size
  // policy is enforced downstream at APPROVE (applyRevise, this.patchThreshold),
  // identical to a raw propose_edit; this check is about generation, not size.
  const roundTrip = applyPatch(oldContent, diff, Number.POSITIVE_INFINITY);
  if (roundTrip !== out) {
    throw new BrokerError(
      "INVARIANT_VIOLATION",
      `generated replace diff did not round-trip for ${path}`,
    );
  }
  return diff;
}

/**
 * Pure, I/O-free: a `/dev/null`-headed creation diff via the two-filename
 * `structuredPatch` form — `oldFileName "/dev/null"`, `newFileName <path>`.
 * Do NOT use `createPatch("/dev/null", "", content)`: createPatch writes ONE
 * filename on BOTH headers (`--- /dev/null` AND `+++ /dev/null`), an artifact
 * that reads as a creation AND a deletion. The create branch of
 * applyProposeEdit consumes this (dry-run + Option B).
 */
export function generateCreatePatch(path: string, content: string): string {
  return formatPatch(structuredPatch("/dev/null", path, "", content, "", ""));
}
