import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Repo root from packages/cli/test/ is three levels up.
// (Precedent: packages/core/test/prepackCheck.test.ts tests a root scripts/ file the same way.)
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const SKILL = join(REPO_ROOT, "skills", "vaultledger-memory", "SKILL.md");
const SNIPPET = join(REPO_ROOT, "skills", "vaultledger-memory", "SNIPPET.md");

/** Strip a leading `---` fenced YAML frontmatter block, if present. */
function body(md: string): string {
  const m = /^---\n[\s\S]*?\n---\n/.exec(md);
  return (m ? md.slice(m[0].length) : md).trim();
}

describe("vaultledger-memory skill: the two shapes cannot diverge", () => {
  test("SNIPPET.md is exactly SKILL.md's body (frontmatter stripped)", () => {
    // This codebase's thesis is 'enforced in code, not prompts' — the skill's
    // own packaging lives by it. Editing one shape and not the other fails here.
    expect(body(readFileSync(SNIPPET, "utf8"))).toBe(body(readFileSync(SKILL, "utf8")));
  });

  test("SKILL.md has the frontmatter Claude Code needs to trigger it", () => {
    const raw = readFileSync(SKILL, "utf8");
    expect(raw.startsWith("---\n")).toBe(true);
    expect(raw).toMatch(/^name: vaultledger-memory$/m);
    expect(raw).toMatch(/^description: .+/m);
  });
});
