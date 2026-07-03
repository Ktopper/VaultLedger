import { describe, expect, test } from "vitest";
import { createPatch } from "diff";
import { applyPatch } from "../../src/broker/patch.js";
import { BrokerError } from "../../src/errors.js";

describe("applyPatch", () => {
  test("applies a clean unified-diff hunk and returns the expected text", () => {
    const original = "line1\nline2\nline3\nline4\nline5\n";
    const expected = "line1\nline2\nCHANGED\nline4\nline5\n";
    const patchText = createPatch("file.md", original, expected);

    expect(applyPatch(original, patchText)).toBe(expected);
  });

  test("throws SYNTAX_BREAK for a malformed patch string", () => {
    expect(() => applyPatch("some content\n", "this is not a valid patch")).toThrow(BrokerError);
    try {
      applyPatch("some content\n", "this is not a valid patch");
      throw new Error("expected applyPatch to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BrokerError);
      expect((e as BrokerError).code).toBe("SYNTAX_BREAK");
    }
  });

  test("throws PATCH_TOO_LARGE when a patch changes more than the threshold of a small file", () => {
    const original = "a\nb\nc\nd\n";
    const rewritten = "A\nB\nC\nd\n";
    const patchText = createPatch("file.md", original, rewritten);

    try {
      applyPatch(original, patchText, 0.5);
      throw new Error("expected applyPatch to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BrokerError);
      expect((e as BrokerError).code).toBe("PATCH_TOO_LARGE");
    }
  });

  test("throws SYNTAX_BREAK when the patch context doesn't match the original", () => {
    // Use a file large enough that a one-line change is well under the size
    // guard, so the rejection is genuinely due to context mismatch.
    const originalA = "aaa\nbbb\nccc\nddd\neee\nfff\nggg\nhhh\n";
    const originalB = "111\n222\n333\n444\n555\n666\n777\n888\n";
    const updatedA = "aaa\nBBB\nccc\nddd\neee\nfff\nggg\nhhh\n";
    const patchText = createPatch("file.md", originalA, updatedA);

    try {
      applyPatch(originalB, patchText);
      throw new Error("expected applyPatch to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BrokerError);
      expect((e as BrokerError).code).toBe("SYNTAX_BREAK");
    }
  });

  test("throws SYNTAX_BREAK (not a raw Error) for a multi-file patch", () => {
    // jsdiff's applyPatch throws Error("... only works with a single input.")
    // for >1 file; it must surface as a clean BrokerError rejection.
    const p1 = createPatch("a.md", "a\nb\n", "a\nB\n");
    const p2 = createPatch("b.md", "x\ny\n", "x\nY\n");
    const combined = p1 + p2;

    try {
      applyPatch("a\nb\n", combined);
      throw new Error("expected applyPatch to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BrokerError);
      expect((e as BrokerError).code).toBe("SYNTAX_BREAK");
    }
  });

  test("throws PATCH_TOO_LARGE when a single long line rewrites most of the bytes", () => {
    // 50 short lines plus one 5000-char line. Replacing only the long line is a
    // tiny line-ratio change but a huge byte-ratio change.
    const longLine = "x".repeat(5000);
    const shortLines = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n");
    const original = `${shortLines}\n${longLine}\n`;
    const rewritten = `${shortLines}\n${"y".repeat(5000)}\n`;
    const patchText = createPatch("file.md", original, rewritten);

    try {
      applyPatch(original, patchText, 0.5);
      throw new Error("expected applyPatch to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BrokerError);
      expect((e as BrokerError).code).toBe("PATCH_TOO_LARGE");
    }
  });

  test("throws SYNTAX_BREAK (not a raw Error) for a single-file patch with a mismatched hunk count", () => {
    // jsdiff's parsePatch itself throws Error("Added line count did not match ...")
    // when a hunk header's +/- counts don't match the body. It must surface as a
    // clean BrokerError rejection, not escape as a raw Error.
    const badHunk =
      "--- a/file.md\n+++ b/file.md\n@@ -1,3 +1,3 @@\n line1\n-line2\n+line2x\n+extraline\n line3\n";

    try {
      applyPatch("line1\nline2\nline3\n", badHunk);
      throw new Error("expected applyPatch to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BrokerError);
      expect((e as BrokerError).code).toBe("SYNTAX_BREAK");
    }
  });
});
