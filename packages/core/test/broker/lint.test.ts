import { describe, expect, test } from "vitest";
import { assertStructurePreserved, ledgerBlockChanged } from "../../src/broker/lint.js";
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

describe("ledgerBlockChanged", () => {
  const base =
    "---\nledger:\n  status: working\n  entity: alice\n  supersedes: null\ntitle: X\n---\n\nBody text.\n";

  test("returns true when ledger.status differs", () => {
    const after =
      "---\nledger:\n  status: canonical\n  entity: alice\n  supersedes: null\ntitle: X\n---\n\nBody text.\n";
    expect(ledgerBlockChanged(base, after)).toBe(true);
  });

  test("returns true when ledger.entity differs", () => {
    const after =
      "---\nledger:\n  status: working\n  entity: bob\n  supersedes: null\ntitle: X\n---\n\nBody text.\n";
    expect(ledgerBlockChanged(base, after)).toBe(true);
  });

  test("returns true when ledger.supersedes differs", () => {
    const after =
      "---\nledger:\n  status: working\n  entity: alice\n  supersedes: mem_123\ntitle: X\n---\n\nBody text.\n";
    expect(ledgerBlockChanged(base, after)).toBe(true);
  });

  test("returns true when a ledger block is added where there was none", () => {
    const before = "---\ntitle: X\n---\n\nBody text.\n";
    const after = base;
    expect(ledgerBlockChanged(before, after)).toBe(true);
  });

  test("returns true when a ledger block is removed", () => {
    const before = base;
    const after = "---\ntitle: X\n---\n\nBody text.\n";
    expect(ledgerBlockChanged(before, after)).toBe(true);
  });

  test("returns false when only the body differs", () => {
    const after =
      "---\nledger:\n  status: working\n  entity: alice\n  supersedes: null\ntitle: X\n---\n\nBody text, revised.\n";
    expect(ledgerBlockChanged(base, after)).toBe(false);
  });

  test("returns false when only a non-ledger frontmatter key differs", () => {
    const after =
      "---\nledger:\n  status: working\n  entity: alice\n  supersedes: null\ntitle: X\ndeadline: 2026-01-01\n---\n\nBody text.\n";
    expect(ledgerBlockChanged(base, after)).toBe(false);
  });

  test("returns false when ledger keys are merely reordered with identical values", () => {
    const after =
      "---\nledger:\n  entity: alice\n  supersedes: null\n  status: working\ntitle: X\n---\n\nBody text.\n";
    expect(ledgerBlockChanged(base, after)).toBe(false);
  });
});
