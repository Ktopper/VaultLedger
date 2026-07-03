import { describe, expect, test } from "vitest";
import { assertStructurePreserved } from "../../src/broker/lint.js";
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
