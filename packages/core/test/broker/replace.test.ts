import { describe, it, expect } from "vitest";
import { applyPatch } from "../../src/broker/patch.js";
import { generateReplacementPatch, generateCreatePatch } from "../../src/broker/replace.js";
import { patchTargetKind, assertPatchParseable } from "../../src/broker/patch.js";
import { BrokerError } from "../../src/errors.js";

function code(fn: () => unknown): { code: string; retriable: boolean } {
  try {
    fn();
  } catch (e) {
    if (e instanceof BrokerError) return { code: e.code, retriable: e.retriable };
    throw e;
  }
  throw new Error("expected a BrokerError, none thrown");
}

const MULTILINE = Array.from({ length: 40 }, (_, i) => `line ${i + 1} content here`).join("\n") + "\n";

describe("generateReplacementPatch", () => {
  it("NAMED ground-check: edits at lines ~12 and ~32 round-trip through the HARDENED applyPatch", () => {
    const replacements = [
      { old_text: "line 12 content here", new_text: "line 12 CHANGED" },
      { old_text: "line 32 content here", new_text: "line 32 CHANGED" },
    ];
    const diff = generateReplacementPatch("notes/n.md", MULTILINE, replacements);
    const expected = MULTILINE.replace("line 12 content here", "line 12 CHANGED").replace(
      "line 32 content here",
      "line 32 CHANGED",
    );
    // The hardened applyPatch (strict landing S2-01/S2-05) must PASS and yield the splice.
    expect(applyPatch(MULTILINE, diff)).toBe(expected);
    expect(patchTargetKind(assertPatchParseable(diff))).toBe("edit");
  });

  it("NO-TRAILING-NEWLINE round-trip: content without a final newline, edit near the end", () => {
    const noNL = "alpha\nbravo\ncharlie\ndelta"; // no trailing \n
    const diff = generateReplacementPatch("notes/n.md", noNL, [
      { old_text: "delta", new_text: "DELTA" },
    ]);
    expect(applyPatch(noNL, diff)).toBe("alpha\nbravo\ncharlie\nDELTA");
  });

  it("exact single match → correct applyable diff", () => {
    const diff = generateReplacementPatch("n.md", "one two three\n", [
      { old_text: "two", new_text: "TWO" },
    ]);
    expect(applyPatch("one two three\n", diff)).toBe("one TWO three\n");
  });

  it("0 matches → retriable TEXT_NOT_FOUND", () => {
    expect(
      code(() => generateReplacementPatch("n.md", "abc\n", [{ old_text: "zzz", new_text: "q" }])),
    ).toEqual({ code: "TEXT_NOT_FOUND", retriable: true });
  });

  it("2 matches with expected_occurrences default 1 → retriable AMBIGUOUS_MATCH", () => {
    expect(
      code(() =>
        generateReplacementPatch("n.md", "foo foo\n", [{ old_text: "foo", new_text: "bar" }]),
      ),
    ).toEqual({ code: "AMBIGUOUS_MATCH", retriable: true });
  });

  it("2 matches with expected_occurrences: 2 → both replaced", () => {
    const diff = generateReplacementPatch("n.md", "foo x foo\n", [
      { old_text: "foo", new_text: "bar", expected_occurrences: 2 },
    ]);
    expect(applyPatch("foo x foo\n", diff)).toBe("bar x bar\n");
  });

  it("overlapping-same-old_text count is deterministic non-overlapping: 'aa' in 'aaaa' is 2", () => {
    // expected_occurrences 2 succeeds (non-overlapping scan), 3 would be AMBIGUOUS.
    const diff = generateReplacementPatch("n.md", "aaaa\n", [
      { old_text: "aa", new_text: "b", expected_occurrences: 2 },
    ]);
    expect(applyPatch("aaaa\n", diff)).toBe("bb\n");
    expect(
      code(() =>
        generateReplacementPatch("n.md", "aaaa\n", [
          { old_text: "aa", new_text: "b", expected_occurrences: 3 },
        ]),
      ).code,
    ).toBe("AMBIGUOUS_MATCH");
  });

  it("empty old_text → retriable reject (NOT a non-retriable shape error)", () => {
    const r = code(() =>
      generateReplacementPatch("n.md", "abc\n", [{ old_text: "", new_text: "x" }]),
    );
    expect(r.retriable).toBe(true);
  });

  it("two replacements whose spans overlap → retriable OVERLAPPING_REPLACEMENTS", () => {
    // "abcd" — replacement A matches "abc", B matches "bcd": spans [0,3) and [1,4) overlap.
    expect(
      code(() =>
        generateReplacementPatch("n.md", "abcd\n", [
          { old_text: "abc", new_text: "X" },
          { old_text: "bcd", new_text: "Y" },
        ]),
      ),
    ).toEqual({ code: "OVERLAPPING_REPLACEMENTS", retriable: true });
  });

  it("two non-overlapping replacements → both applied against the one snapshot", () => {
    const diff = generateReplacementPatch("n.md", "red green blue\n", [
      { old_text: "red", new_text: "R" },
      { old_text: "blue", new_text: "B" },
    ]);
    expect(applyPatch("red green blue\n", diff)).toBe("R green B\n");
  });

  it("no-op (old === new) → retriable SYNTAX_BREAK 'no changes'", () => {
    const r = code(() =>
      generateReplacementPatch("n.md", "same\n", [{ old_text: "same", new_text: "same" }]),
    );
    expect(r).toEqual({ code: "SYNTAX_BREAK", retriable: true });
  });
});

describe("generateCreatePatch", () => {
  it("newFileName is the REAL path, not /dev/null (two-filename form)", () => {
    const diff = generateCreatePatch("notes/created.md", "hello\nworld\n");
    const parsed = assertPatchParseable(diff);
    expect(parsed[0]!.oldFileName).toBe("/dev/null");
    expect(parsed[0]!.newFileName).toBe("notes/created.md");
    expect(patchTargetKind(parsed)).toBe("create");
  });

  it("applies EXACT to an empty file", () => {
    const diff = generateCreatePatch("notes/created.md", "hello\nworld\n");
    expect(applyPatch("", diff)).toBe("hello\nworld\n");
  });
});
