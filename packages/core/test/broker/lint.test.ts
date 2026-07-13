import { describe, expect, test } from "vitest";
import { assertStructurePreserved, governedProvenanceChanged } from "../../src/broker/lint.js";
import { BrokerError } from "../../src/errors.js";

describe("assertStructurePreserved", () => {
  test("does not throw for a content-only edit that preserves frontmatter and wikilinks", () => {
    const before =
      "---\ntitle: Test\n---\n\nSee [[Alpha]] and [[Beta]] for details. Block ref here ^abc123\n";
    const after =
      "---\ntitle: Test\n---\n\nSee [[Alpha]] and [[Beta]] again for clarity. Block ref here ^abc123\n";

    expect(() => assertStructurePreserved(before, after)).not.toThrow();
  });

  test("throws SYNTAX_BREAK when after corrupts the frontmatter block", () => {
    const before =
      "---\ntitle: Test\n---\n\nSee [[Alpha]] and [[Beta]] for details. Block ref here ^abc123\n";
    // Closing '---' removed, so gray-matter can no longer find a closed frontmatter block.
    const after =
      "---\ntitle: Test\n\nSee [[Alpha]] and [[Beta]] for details. Block ref here ^abc123\n";

    try {
      assertStructurePreserved(before, after);
      throw new Error("expected assertStructurePreserved to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BrokerError);
      expect((e as BrokerError).code).toBe("SYNTAX_BREAK");
    }
  });

  test("throws SYNTAX_BREAK when after drops a wikilink present in before", () => {
    const before =
      "---\ntitle: Test\n---\n\nSee [[Alpha]] and [[Beta]] for details. Block ref here ^abc123\n";
    const after = "---\ntitle: Test\n---\n\nSee [[Alpha]] for details. Block ref here ^abc123\n";

    try {
      assertStructurePreserved(before, after);
      throw new Error("expected assertStructurePreserved to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BrokerError);
      expect((e as BrokerError).code).toBe("SYNTAX_BREAK");
    }
  });

  test("does not throw for a content-only edit that preserves callout headers", () => {
    const before =
      "# Notes\n\n> [!warning] Heads up\n> Be careful here.\n\n> [!note] Aside\n> More context.\n";
    const after =
      "# Notes\n\n> [!warning] Heads up\n> Be careful here, really.\n\n> [!note] Aside\n> More context, expanded.\n";

    expect(() => assertStructurePreserved(before, after)).not.toThrow();
  });

  test("throws SYNTAX_BREAK when after drops a callout header present in before", () => {
    const before =
      "# Notes\n\n> [!warning] Heads up\n> Be careful here.\n\n> [!note] Aside\n> More context.\n";
    const after = "# Notes\n\n> [!warning] Heads up\n> Be careful here.\n\nMore context.\n";

    try {
      assertStructurePreserved(before, after);
      throw new Error("expected assertStructurePreserved to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BrokerError);
      expect((e as BrokerError).code).toBe("SYNTAX_BREAK");
    }
  });
});

describe("governedProvenanceChanged", () => {
  // Realistic note shape: `entity` is a TOP-LEVEL frontmatter field (a sibling
  // of `ledger:`, NOT inside it — see MemoryProvenance, which has no entity),
  // and it is a governed field (the contradiction matcher's comparison set is
  // keyed on it), so a change to it must be caught by the guard.
  const base =
    "---\nledger:\n  status: working\n  supersedes: null\nentity: alice\ntitle: X\n---\n\nBody text.\n";

  test("returns true when ledger.status differs", () => {
    const after =
      "---\nledger:\n  status: canonical\n  supersedes: null\nentity: alice\ntitle: X\n---\n\nBody text.\n";
    expect(governedProvenanceChanged(base, after)).toBe(true);
  });

  test("returns true when the top-level entity differs", () => {
    const after =
      "---\nledger:\n  status: working\n  supersedes: null\nentity: bob\ntitle: X\n---\n\nBody text.\n";
    expect(governedProvenanceChanged(base, after)).toBe(true);
  });

  test("returns true when the top-level entity is removed", () => {
    const after =
      "---\nledger:\n  status: working\n  supersedes: null\ntitle: X\n---\n\nBody text.\n";
    expect(governedProvenanceChanged(base, after)).toBe(true);
  });

  test("returns true when a top-level entity is added where there was none", () => {
    const before =
      "---\nledger:\n  status: working\n  supersedes: null\ntitle: X\n---\n\nBody text.\n";
    const after =
      "---\nledger:\n  status: working\n  supersedes: null\nentity: sneaky\ntitle: X\n---\n\nBody text.\n";
    expect(governedProvenanceChanged(before, after)).toBe(true);
  });

  test("returns true when ledger.supersedes differs", () => {
    const after =
      "---\nledger:\n  status: working\n  supersedes: mem_123\nentity: alice\ntitle: X\n---\n\nBody text.\n";
    expect(governedProvenanceChanged(base, after)).toBe(true);
  });

  test("returns true when a ledger block is added where there was none", () => {
    const before = "---\nentity: alice\ntitle: X\n---\n\nBody text.\n";
    const after = base;
    expect(governedProvenanceChanged(before, after)).toBe(true);
  });

  test("returns true when a ledger block is removed", () => {
    const before = base;
    const after = "---\nentity: alice\ntitle: X\n---\n\nBody text.\n";
    expect(governedProvenanceChanged(before, after)).toBe(true);
  });

  test("returns false when only the body differs", () => {
    const after =
      "---\nledger:\n  status: working\n  supersedes: null\nentity: alice\ntitle: X\n---\n\nBody text, revised.\n";
    expect(governedProvenanceChanged(base, after)).toBe(false);
  });

  test("returns false when only a non-governed frontmatter key differs", () => {
    const after =
      "---\nledger:\n  status: working\n  supersedes: null\nentity: alice\ntitle: X\ndeadline: 2026-01-01\n---\n\nBody text.\n";
    expect(governedProvenanceChanged(base, after)).toBe(false);
  });

  test("returns false when governed fields are merely reordered with identical values", () => {
    const after =
      "---\nentity: alice\nledger:\n  supersedes: null\n  status: working\ntitle: X\n---\n\nBody text.\n";
    expect(governedProvenanceChanged(base, after)).toBe(false);
  });
});

describe("governedSlice boundary (VL-SEC-S2-04 drift invariant)", () => {
  // Locks the fact/governance boundary documented on `governedSlice` in
  // lint.ts: the guard is deliberately narrow (only `ledger:` + top-level
  // `entity`) so an agent can freely revise facts in its own memory's
  // frontmatter without triggering an approval requirement. This is a REAL
  // assertion, not a tautology against the implementation -- it drives the
  // full parse+compare pipeline (governedProvenanceChanged) with a table of
  // representative non-ledger/entity mutations (different key names, value
  // types, additions, removals, and even top-level keys that LOOK
  // governance-related) and asserts every one of them is a no-op for the
  // guard. If a future change makes governance sensitive to any of these
  // (e.g. someone starts reading a top-level `status`/`supersedes`, or the
  // `deadline`/`priority`/custom-key fact-update model regresses), one of
  // these cases flips to `true` and this test fails, forcing an explicit
  // update to `governedSlice` (and its doc comment) rather than a silent
  // widening or a silent gap.
  const base =
    "---\nledger:\n  status: working\n  supersedes: null\nentity: alice\ntitle: X\n---\n\nBody text.\n";

  const nonGovernedMutations: Array<[name: string, after: string]> = [
    ["a string fact key changes", base.replace("title: X", "title: Y")],
    [
      "a date-shaped fact is added",
      base.replace("title: X", "title: X\ndeadline: 2026-08-15"),
    ],
    ["a numeric fact is added", base.replace("title: X", "title: X\npriority: 3")],
    ["a boolean fact is added", base.replace("title: X", "title: X\narchived: false")],
    [
      "a nested/object custom key is added",
      base.replace("title: X", "title: X\ncustom:\n  nested: value\n  list:\n    - a\n    - b"),
    ],
    ["an array fact is added", base.replace("title: X", "title: X\nwatchers:\n  - bob\n  - carol")],
    ["a fact key is removed entirely", base.replace("title: X\n", "")],
    // Canary: top-level keys that SHARE A NAME with governed sub-fields of
    // `ledger:` but live OUTSIDE it must not be mistaken for the governed
    // ones -- only `data.ledger.status`/`data.ledger.supersedes` are
    // governed, never a same-named top-level key.
    [
      "a top-level `status` key (NOT inside ledger) is added",
      base.replace("title: X", "title: X\nstatus: draft"),
    ],
    [
      "a top-level `supersedes` key (NOT inside ledger) is added",
      base.replace("title: X", "title: X\nsupersedes: mem_999"),
    ],
  ];

  test.each(nonGovernedMutations)("does NOT flag when %s", (_name, after) => {
    expect(governedProvenanceChanged(base, after)).toBe(false);
  });

  // Control: mirrors the same style of mutation but on an ACTUALLY governed
  // field, proving the table above isn't vacuously passing (e.g. because
  // governedProvenanceChanged always returned false for some unrelated
  // reason).
  const governedMutations: Array<[name: string, after: string]> = [
    [
      "ledger.status changes",
      base.replace("status: working", "status: canonical"),
    ],
    ["top-level entity changes", base.replace("entity: alice", "entity: bob")],
  ];

  test.each(governedMutations)("DOES flag when %s (control)", (_name, after) => {
    expect(governedProvenanceChanged(base, after)).toBe(true);
  });
});
