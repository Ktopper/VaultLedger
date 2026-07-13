import { describe, expect, test } from "vitest";
import { createPatch, applyPatch as rawDiffApply } from "diff";
import { applyPatch } from "../../src/broker/patch.js";
import { BrokerError } from "../../src/errors.js";

/**
 * VL-SEC-S2-01 / VL-SEC-S2-05: patch landing-position + hunk-order
 * verification.
 *
 * Background (see security/poc/s2-patch.mjs for the original PoC this ports
 * from): jsdiff's `applyPatch` does not require a hunk to land at its
 * declared `@@ -oldStart` line. With an exact-match search (fuzzFactor 0),
 * if the declared position's content doesn't match, jsdiff walks the WHOLE
 * file for a position where the hunk's removed/context lines DO match, and
 * silently applies there -- so a patch whose header/context claims to touch
 * one line but whose content only actually matches elsewhere mutates that
 * elsewhere location with zero signal from the header a human reviewer (or
 * `assertStructurePreserved`) would see.
 */
describe("applyPatch — landing-position verification (VL-SEC-S2-01)", () => {
  const before = [
    "---",
    "ledger:",
    "  status: working",
    'entity: "Acme Corp"',
    "deadline: 2026-01-01",
    "sentinel: TBD",
    "---",
    "# Acme Corp status",
    "",
    "Line A body text.",
    "Line B body text.",
    "",
    "Line C body text.",
    "Line D body text.",
    "",
  ].join("\n");

  // Declared to touch line 13 ("Line C body text.") per the @@ header, but
  // the actual removed/context line is "sentinel: TBD" -- which occurs ONLY
  // inside the frontmatter, at line 6.
  const lyingPatch = [
    "--- a/note.md",
    "+++ b/note.md",
    "@@ -13,1 +13,1 @@",
    "-sentinel: TBD",
    "+sentinel: APPROVED",
    "",
  ].join("\n");

  test("negative control: jsdiff's raw applyPatch DOES relocate the hunk silently (documents the underlying exploit)", () => {
    // No compareLine/landing check here -- exercises jsdiff directly, the
    // same call our broker.ts made pre-fix (`diffApply(original, patchText)`
    // with zero options), to prove the relocation is real, not hypothetical.
    const raw = rawDiffApply(before, lyingPatch);
    expect(raw).not.toBe(false);
    const rawResult = raw as string;
    const beforeLines = before.split("\n");
    const afterLines = rawResult.split("\n");
    // Declared target (line 13, body) is untouched...
    expect(afterLines[12]).toBe(beforeLines[12]);
    // ...but the frontmatter line the header never named DID change.
    expect(beforeLines[5]).toBe("sentinel: TBD");
    expect(afterLines[5]).toBe("sentinel: APPROVED");
  });

  test("our applyPatch wrapper rejects the same relocated hunk with SYNTAX_BREAK", () => {
    try {
      applyPatch(before, lyingPatch);
      throw new Error("expected applyPatch to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BrokerError);
      expect((e as BrokerError).code).toBe("SYNTAX_BREAK");
    }
  });

  test("rejects relocation onto a GOVERNED field (ledger.status) the same way as an ungoverned one", () => {
    const before2 = before;
    const patch2 = [
      "--- a/note.md",
      "+++ b/note.md",
      "@@ -13,1 +13,1 @@",
      "-  status: working",
      "+  status: canonical",
      "",
    ].join("\n");

    try {
      applyPatch(before2, patch2);
      throw new Error("expected applyPatch to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BrokerError);
      expect((e as BrokerError).code).toBe("SYNTAX_BREAK");
    }
  });

  test("a legit patch that lands exactly at its declared position still applies", () => {
    const originalSimple = "line1\nline2\nline3\nline4\nline5\n";
    const expectedSimple = "line1\nline2\nCHANGED\nline4\nline5\n";
    const patchText = createPatch("file.md", originalSimple, expectedSimple);
    expect(applyPatch(originalSimple, patchText)).toBe(expectedSimple);
  });

  test("an honest, correctly-addressed edit to frontmatter still applies (no over-blocking of legitimate frontmatter edits)", () => {
    const after = before.replace("deadline: 2026-01-01", "deadline: 1999-01-01");
    const patchText = createPatch("note.md", before, after);
    expect(applyPatch(before, patchText)).toBe(after);
  });

  test("duplicate/repeated lines elsewhere in the file do not cause a false SYNTAX_BREAK on a legit single-line edit", () => {
    // Repeated blank lines AND a repeated section header surround a unique
    // sentence the patch legitimately edits at its true, declared position.
    // If landing verification used a naive diffLines(before, after)
    // recomputation (a DIFFERENT algorithm than jsdiff's own hunk-apply
    // search), duplicate lines near the edit could make the two algorithms
    // disagree on "which" duplicate moved, producing a FALSE SYNTAX_BREAK.
    // Our approach instead observes jsdiff's OWN real search (via
    // compareLine), so it can never disagree with what jsdiff actually did.
    const dup = [
      "---",
      "ledger:",
      "  status: working",
      "---",
      "# Notes",
      "",
      "",
      "## Section A",
      "",
      "",
      "## Section B",
      "",
      "",
      "## Section A",
      "",
      "Some unique content to edit.",
      "",
    ].join("\n");
    const dupAfter = dup.replace("Some unique content to edit.", "Some EDITED content.");
    const patchText = createPatch("dup.md", dup, dupAfter);
    expect(applyPatch(dup, patchText)).toBe(dupAfter);
  });

  test("a legit multi-hunk patch with two well-separated edits still applies (both hunks land at their declared positions)", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line${i + 1}`);
    const original = lines.join("\n") + "\n";
    const editedLines = lines.slice();
    editedLines[4] = "CHANGED-A"; // line 5
    editedLines[34] = "CHANGED-B"; // line 35
    const expected = editedLines.join("\n") + "\n";
    const patchText = createPatch("multi.md", original, expected);
    // Sanity: this really did produce >1 hunk (createPatch's default
    // context window is small enough that two edits 30 lines apart split
    // into separate hunks).
    expect(applyPatch(original, patchText)).toBe(expected);
  });
});

describe("applyPatch — hunk-order / non-overlap verification (VL-SEC-S2-05)", () => {
  test("rejects two hunks that both declare the same (overlapping) oldStart", () => {
    const before = [
      "---",
      "ledger:",
      "  status: working",
      'entity: "Acme Corp"',
      "---",
      "alpha",
      "beta",
      "gamma",
      "delta",
      "",
    ].join("\n");

    const patchText = [
      "--- a/note.md",
      "+++ b/note.md",
      "@@ -6,1 +6,1 @@",
      "-alpha",
      "+ALPHA",
      "@@ -6,1 +6,1 @@",
      "-beta",
      "+BETA",
      "",
    ].join("\n");

    try {
      applyPatch(before, patchText);
      throw new Error("expected applyPatch to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BrokerError);
      expect((e as BrokerError).code).toBe("SYNTAX_BREAK");
    }
  });

  test("rejects hunks declared out of order (second hunk's oldStart precedes the first's)", () => {
    const before = "alpha\nbeta\ngamma\ndelta\nepsilon\n";
    const patchText = [
      "--- a/note.md",
      "+++ b/note.md",
      "@@ -4,1 +4,1 @@",
      "-delta",
      "+DELTA",
      "@@ -1,1 +1,1 @@",
      "-alpha",
      "+ALPHA",
      "",
    ].join("\n");

    try {
      applyPatch(before, patchText);
      throw new Error("expected applyPatch to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BrokerError);
      expect((e as BrokerError).code).toBe("SYNTAX_BREAK");
    }
  });

  test("accepts two hunks in proper ascending, non-overlapping order", () => {
    const before = "alpha\nbeta\ngamma\ndelta\nepsilon\n";
    const patchText = [
      "--- a/note.md",
      "+++ b/note.md",
      "@@ -1,1 +1,1 @@",
      "-alpha",
      "+ALPHA",
      "@@ -4,1 +4,1 @@",
      "-delta",
      "+DELTA",
      "",
    ].join("\n");

    expect(applyPatch(before, patchText)).toBe("ALPHA\nbeta\ngamma\nDELTA\nepsilon\n");
  });
});
