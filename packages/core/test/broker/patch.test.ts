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
    const originalA = "aaa\nbbb\nccc\n";
    const originalB = "xxx\nyyy\nzzz\n";
    const updatedA = "aaa\nBBB\nccc\n";
    const patchText = createPatch("file.md", originalA, updatedA);

    try {
      applyPatch(originalB, patchText);
      throw new Error("expected applyPatch to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BrokerError);
      expect((e as BrokerError).code).toBe("SYNTAX_BREAK");
    }
  });
});
