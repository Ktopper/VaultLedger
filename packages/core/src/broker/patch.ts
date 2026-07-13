import { applyPatch as diffApply, parsePatch, type Hunk } from "diff";
import { BrokerError } from "../errors.js";

/** Signature jsdiff's `applyPatch` calls per matchable hunk line — matches
 * `ApplyPatchOptions["compareLine"]` from `@types/diff`. Declared locally so
 * `deriveHunkLandings` doesn't need a broader import. */
type CompareLine = (
  lineNumber: number,
  line: string,
  operation: "-" | " ",
  patchContent: string,
) => boolean;

/**
 * Count the hunk lines jsdiff's `applyHunk` will actually call `compareLine`
 * for: '-' (removed) and ' ' (context) lines. A '+' (added) line only pushes
 * content — it never compares against `original` — and a stray `\ No newline
 * at end of file` marker line (leading `\`) matches neither branch and is
 * likewise skipped. See diff@7's `lib/patch/apply.js`.
 */
function countMatchableLines(hunk: Hunk): number {
  let n = 0;
  for (const l of hunk.lines) {
    const op = l.length > 0 ? l[0] : " ";
    if (op === "-" || op === " ") n += 1;
  }
  return n;
}

/**
 * VL-SEC-S2-01: re-derive, from jsdiff's REAL search (not a reimplementation
 * of it), the 0-indexed line each hunk actually landed at — by instrumenting
 * the `compareLine` hook `applyPatch` already exposes as public API, rather
 * than duplicating jsdiff's internal distance-search algorithm (which risks
 * silently diverging from whatever jsdiff actually does on some future
 * version bump).
 *
 * This works ONLY because the caller always runs jsdiff with `fuzzFactor: 0`
 * (enforced by the caller passing it explicitly): at fuzzFactor 0, jsdiff's
 * `applyHunk` aborts a candidate the instant any single comparison fails —
 * the backtracking/substitution recursion path is gated behind `maxErrors`,
 * which is always 0 here — so a run of exactly `countMatchableLines(hunk)`
 * consecutive `true` results from `compareLine` can only mean that hunk's
 * entire non-insert line sequence matched, in order, starting at the
 * position of the FIRST comparison in that run. That position is hunk N's
 * actual landing line. Hunks with zero matchable lines (pure-insertion, no
 * context/removed lines) never call `compareLine` at all — jsdiff accepts
 * the very first candidate it tries for them without searching — so their
 * landing is computed directly from the running inter-hunk offset instead of
 * observed.
 *
 * Returns jsdiff's own `applyPatch` result unchanged, plus the derived
 * per-hunk landing (0-indexed line, or `null` if that hunk was never
 * reached — e.g. an earlier hunk failed to apply at all).
 */
function deriveHunkLandings(
  hunks: readonly Hunk[],
  apply: (compareLine: CompareLine) => string | false,
): { result: string | false; landings: (number | null)[] } {
  const landings: (number | null)[] = new Array(hunks.length).fill(null);
  let hunkIdx = 0;
  let runCount = 0;
  let runStartLine: number | null = null; // 1-indexed, per compareLine's convention

  function runningOffsetBefore(idx: number): number {
    if (idx === 0) return 0;
    const prevLanding = landings[idx - 1];
    const prevHunk = hunks[idx - 1];
    if (prevLanding == null || prevHunk === undefined) return 0; // defensive; shouldn't happen
    return prevLanding + 1 - prevHunk.oldStart;
  }

  function skipEmptyHunks(): void {
    for (
      let hunk = hunks[hunkIdx];
      hunkIdx < hunks.length && hunk !== undefined && countMatchableLines(hunk) === 0;
      hunk = hunks[hunkIdx]
    ) {
      const offset = runningOffsetBefore(hunkIdx);
      landings[hunkIdx] = hunk.oldStart + offset - 1;
      hunkIdx += 1;
    }
    runCount = 0;
    runStartLine = null;
  }
  skipEmptyHunks();

  const compareLine: CompareLine = (lineNumber, line, _operation, patchContent) => {
    const isMatch = line === patchContent;
    const currentHunk = hunks[hunkIdx];
    if (currentHunk === undefined) return isMatch; // defensive; shouldn't happen
    if (runCount === 0) runStartLine = lineNumber;
    if (isMatch) {
      runCount += 1;
      if (runCount === countMatchableLines(currentHunk)) {
        landings[hunkIdx] = (runStartLine as number) - 1;
        hunkIdx += 1;
        skipEmptyHunks();
      }
    } else {
      runCount = 0;
      runStartLine = null;
    }
    return isMatch;
  };

  const result = apply(compareLine);
  return { result, landings };
}

// Below this many original bytes, the PATCH_TOO_LARGE ratio guard is not
// enforced at all -- a legit one-line edit to a tiny note (a few words) can
// trivially exceed a 50% line/byte ratio, tripping the guard on completely
// unremarkable edits. Rationale for why relaxing this is safe (a reviewer
// will ask): below the floor a *working* note can be fully rewritten
// unapproved, which is consistent with the model because (1) working status
// is provisional -- it hasn't been promoted to canonical yet; (2) the
// canonical-revise gate (a separate guard) still requires approval to touch
// a canonical note regardless of patch size; and (3) the ledger-guard
// (provenance tamper check) still protects status/entity/supersedes at ANY
// size, floor or no floor. So this floor only relaxes the size *heuristic*
// on tiny provisional bodies -- it never weakens a governance control.
const PATCH_RATIO_FLOOR_BYTES = 512;

/**
 * Apply a unified-diff patch to `original`, guarding against oversized,
 * unparseable, or (VL-SEC-S2-01/S2-05) *relocated* patches.
 *
 * - Throws SYNTAX_BREAK if the patch text has no parseable hunks, if it spans
 *   more than one file (jsdiff's applyPatch only accepts a single input), if a
 *   hunk header miscounts its +/- lines (jsdiff's parser throws), if the
 *   patch's context does not match `original` closely enough to apply, if the
 *   patch's hunks are not strictly ordered and non-overlapping by declared
 *   `oldStart`/`oldLines` (VL-SEC-S2-05), or if any hunk's ACTUAL landing line
 *   (where jsdiff really found a content match) deviates from its DECLARED
 *   `@@ -oldStart` line by more than `landingFuzz` lines (VL-SEC-S2-01).
 *
 *   S2-01 matters because jsdiff's `applyPatch` does not require a hunk to
 *   land at its declared header position — with an exact-match content
 *   search (fuzzFactor 0, always what we use), if the declared position
 *   doesn't match, jsdiff still walks the WHOLE file for a position where the
 *   hunk's removed/context lines DO match, and silently applies there. A
 *   patch whose header/context claims to touch one line (e.g. a body
 *   sentence) but whose content only actually matches elsewhere (e.g. inside
 *   frontmatter) would otherwise mutate that elsewhere location with zero
 *   signal — this check catches that for every hunk/field, governed or not.
 * - Throws PATCH_TOO_LARGE if `original` is larger than
 *   `PATCH_RATIO_FLOOR_BYTES` AND EITHER the fraction of changed lines OR the
 *   fraction of changed bytes (added + removed hunk lines, across all hunks)
 *   relative to the original exceeds `threshold`. The byte guard stops a
 *   single-line edit from silently rewriting thousands of bytes — common in
 *   Obsidian's unwrapped paragraphs. Below the byte floor the ratio is not
 *   enforced at all (see PATCH_RATIO_FLOOR_BYTES above).
 *
 * Any error thrown by jsdiff's parser or applier is converted into a clean
 * SYNTAX_BREAK rejection; the function never surfaces a raw Error. Our own
 * BrokerError rejections (e.g. PATCH_TOO_LARGE) propagate unchanged.
 *
 * `landingFuzz` (default 0, i.e. a hunk must land EXACTLY at its declared
 * line) is an explicit, separate knob from `threshold` — the size ratio and
 * the landing-position checks guard different things and should not be
 * conflated behind one parameter.
 */
export function applyPatch(
  original: string,
  patchText: string,
  threshold = 0.5,
  landingFuzz = 0,
): string {
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

    // VL-SEC-S2-05: reject hunks that are out of order or overlap by their
    // OWN declared ranges — jsdiff itself has no opinion on this (it applies
    // each hunk independently, in array order, regardless of whether the
    // ranges make sense together), so two hunks both claiming to own
    // (or reordered to precede) the same lines is otherwise silently
    // accepted, with the second hunk's search free to wander past the
    // first's already-edited region.
    // `parsed.length !== 1` already threw above, so index 0 is guaranteed.
    const hunks = parsed[0]!.hunks;
    for (let i = 0; i + 1 < hunks.length; i++) {
      // Both indices are in-bounds by the loop condition (`i + 1 < length`).
      const cur = hunks[i]!;
      const next = hunks[i + 1]!;
      if (cur.oldStart + cur.oldLines > next.oldStart) {
        throw new BrokerError(
          "SYNTAX_BREAK",
          `patch hunk ${i + 1} (oldStart ${cur.oldStart}, oldLines ${cur.oldLines}) ` +
            `overlaps or is out of order relative to hunk ${i + 2} (oldStart ${next.oldStart})`,
        );
      }
    }

    let changedLines = 0;
    let changedBytes = 0;
    for (const h of hunks) {
      for (const l of h.lines) {
        if (l.startsWith("+") || l.startsWith("-")) {
          changedLines += 1;
          // Exclude the leading +/- marker from the byte count.
          changedBytes += l.length - 1;
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
    if (
      originalBytes > PATCH_RATIO_FLOOR_BYTES &&
      (lineRatio > threshold || byteRatio > threshold)
    ) {
      throw new BrokerError(
        "PATCH_TOO_LARGE",
        `patch changes ${changedLines} lines / ${changedBytes} bytes ` +
          `(> ${threshold * 100}% of ${originalLines} lines / ${originalBytes} bytes)`,
      );
    }

    // fuzzFactor is passed EXPLICITLY (rather than relying on jsdiff's own
    // default, which happens to also be 0) because deriveHunkLandings'
    // landing-observation technique is only sound at fuzzFactor 0 (see its
    // doc comment) — pinning it here means a future jsdiff version changing
    // its default can never silently invalidate that assumption.
    const { result, landings } = deriveHunkLandings(hunks, (compareLine) =>
      diffApply(original, patchText, { fuzzFactor: 0, compareLine }),
    );
    if (result === false) {
      throw new BrokerError("SYNTAX_BREAK", "patch did not apply cleanly");
    }

    // VL-SEC-S2-01: every hunk's ACTUAL landing must fall within
    // `landingFuzz` lines of its DECLARED `@@ -oldStart` position. This is
    // checked for every hunk regardless of what field it touches — a
    // relocation that reaches an ungoverned field is still a patch that
    // mutated bytes its own header never disclosed, and the separate
    // ledger-guard (governedProvenanceChanged) is not a substitute here: it
    // only runs on the unapproved path and only inspects the governed slice.
    for (let i = 0; i < hunks.length; i++) {
      const hunk = hunks[i]!; // in-bounds by the loop condition
      const declared = hunk.oldStart - 1; // 0-indexed
      const actual = landings[i] ?? null;
      if (actual === null || Math.abs(actual - declared) > landingFuzz) {
        throw new BrokerError(
          "SYNTAX_BREAK",
          `patch hunk ${i + 1} declared landing at line ${hunk.oldStart} but actually ` +
            `applied at line ${actual === null ? "<unreached>" : actual + 1} — rejecting a ` +
            `relocated hunk`,
        );
      }
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
