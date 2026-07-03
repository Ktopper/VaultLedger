import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanVault } from "../../src/scan/scanner.js";
import { BrokerError } from "../../src/errors.js";

let dir: string | undefined;

function makeVault(): string {
  const root = mkdtempSync(join(tmpdir(), "vaultledger-scan-"));

  // top-level notes with wikilinks
  writeFileSync(join(root, "Home.md"), "# Home\n\nSee [[Note A]] and [[Note B]].\n");
  writeFileSync(join(root, "Note A.md"), "Links to [[Note B]].\n");
  writeFileSync(join(root, "Note B.md"), "No links here.\n");

  // Daily folder with a YYYY-MM-DD note
  mkdirSync(join(root, "Daily"), { recursive: true });
  writeFileSync(join(root, "Daily", "2026-07-01.md"), "Daily note [[Home]].\n");

  // Templates folder
  mkdirSync(join(root, "Templates"), { recursive: true });
  writeFileSync(join(root, "Templates", "Daily Template.md"), "Template content.\n");

  // Attachments folder with a non-md file
  mkdirSync(join(root, "Attachments"), { recursive: true });
  writeFileSync(join(root, "Attachments", "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]));

  // Projects folder with 3 notes
  mkdirSync(join(root, "Projects"), { recursive: true });
  writeFileSync(join(root, "Projects", "Proj1.md"), "Project 1 [[Note A]].\n");
  writeFileSync(join(root, "Projects", "Proj2.md"), "Project 2.\n");
  writeFileSync(join(root, "Projects", "Proj3.md"), "Project 3.\n");

  // Private folder
  mkdirSync(join(root, "Private"), { recursive: true });
  writeFileSync(join(root, "Private", "Secret.md"), "Secret note.\n");

  // .obsidian dir (should be excluded)
  mkdirSync(join(root, ".obsidian"), { recursive: true });
  writeFileSync(join(root, ".obsidian", "config.json"), "{}");

  return root;
}

function listAllFiles(root: string): string[] {
  const results: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(full);
      } else {
        results.push(full);
      }
    }
  }
  walk(root);
  return results.sort();
}

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe("scanVault", () => {
  test("builds a VaultProfile from a fixture vault", () => {
    dir = makeVault();
    const result = scanVault(dir);

    expect(result.profile.root).toBe(dir);
    // Home.md, Note A.md, Note B.md, Daily/2026-07-01.md, Templates/Daily Template.md,
    // Projects/Proj1-3.md, Private/Secret.md = 9 notes
    expect(result.profile.noteCount).toBe(9);

    // wikilinks: Home.md=2, Note A.md=1, Daily note=1, Projects/Proj1.md=1 => 5 total
    expect(result.profile.linkCount).toBe(5);

    // folders must already be sorted (deterministic, human-diffable output).
    expect(result.profile.folders).toEqual([
      "Attachments",
      "Daily",
      "Private",
      "Projects",
      "Templates",
    ]);

    expect(result.profile.detected.dailyNotes).toBe(true);
    expect(result.profile.detected.templates).toBe(true);
    expect(result.profile.detected.attachments).toBe(true);
    expect(result.profile.detected.likelyProjects).toContain("Projects");

    expect(result.profile.hasPrivate).toBe(true);
    expect(result.profile.hasAgent).toBe(false);
  });

  test("proposedManifest is conservative and reflects hasPrivate", () => {
    dir = makeVault();
    const result = scanVault(dir);

    expect(result.proposedManifest.zones.trusted).toEqual(["**"]);
    expect(result.proposedManifest.zones.agent).toEqual(["Agent/**"]);
    expect(result.proposedManifest.zones.scratch).toEqual(["Agent/Scratch/**"]);
    expect(result.proposedManifest.zones.excluded).toEqual(
      expect.arrayContaining([".obsidian/**", "Private/**"]),
    );
    expect(result.proposedManifest.mode).toBe("assisted");
  });

  test("no Private folder means excluded is just .obsidian", () => {
    dir = mkdtempSync(join(tmpdir(), "vaultledger-scan-noprivate-"));
    writeFileSync(join(dir, "Note.md"), "Just a note.\n");

    const result = scanVault(dir);

    expect(result.profile.hasPrivate).toBe(false);
    expect(result.proposedManifest.zones.excluded).toEqual([".obsidian/**"]);
  });

  test("performs zero writes to the vault (no-write guarantee)", () => {
    dir = makeVault();

    const before = listAllFiles(dir);
    scanVault(dir);
    const after = listAllFiles(dir);

    expect(after).toEqual(before);
    expect(existsSync(join(dir, ".ledger"))).toBe(false);
  });

  test("survives a read that throws (EISDIR) without crashing", () => {
    dir = makeVault();
    // A DIRECTORY named with a .md extension. It is not a file, so it is not
    // counted as a note, but the scan must not crash walking it. (This also
    // guards the per-file read try/catch against EISDIR-style failures.)
    mkdirSync(join(dir, "Weird.md"), { recursive: true });

    const result = scanVault(dir);

    // scan completes; the directory-with-a-.md-name is not counted as a note.
    expect(result.profile.noteCount).toBe(9);
  });

  test("bounded wikilink regex does not hang on adversarial unterminated [[ (ReDoS)", () => {
    dir = mkdtempSync(join(tmpdir(), "vaultledger-scan-redos-"));
    // 50,000 unterminated "[[" sequences: an O(n^2) regex would take seconds.
    writeFileSync(join(dir, "Evil.md"), "[[".repeat(50_000));

    const start = Date.now();
    const result = scanVault(dir);
    const elapsed = Date.now() - start;

    expect(result.profile.noteCount).toBe(1);
    expect(result.profile.linkCount).toBe(0); // no closed wikilink present
    expect(elapsed).toBeLessThan(1_000);
  });

  test("throws NOT_FOUND when root does not exist", () => {
    const missing = join(tmpdir(), "vaultledger-scan-does-not-exist-xyz");
    expect(() => scanVault(missing)).toThrow(BrokerError);
    try {
      scanVault(missing);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BrokerError);
      expect((err as BrokerError).code).toBe("NOT_FOUND");
    }
  });

  test("throws NOT_FOUND when root is a file, not a directory", () => {
    dir = mkdtempSync(join(tmpdir(), "vaultledger-scan-fileroot-"));
    const filePath = join(dir, "not-a-vault.md");
    writeFileSync(filePath, "I am a file.\n");

    expect(() => scanVault(filePath)).toThrow(BrokerError);
    try {
      scanVault(filePath);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as BrokerError).code).toBe("NOT_FOUND");
    }
  });

  test("deeply nested note counts and attributes to its top-level folder", () => {
    dir = mkdtempSync(join(tmpdir(), "vaultledger-scan-deep-"));
    mkdirSync(join(dir, "Projects", "Sub", "Deep"), { recursive: true });
    writeFileSync(join(dir, "Projects", "Sub", "Deep", "note.md"), "Deep [[Home]] link.\n");
    // two more notes so Projects clears the >=3 md heuristic on its own name too
    writeFileSync(join(dir, "Projects", "a.md"), "a\n");
    writeFileSync(join(dir, "Projects", "b.md"), "b\n");

    const result = scanVault(dir);

    expect(result.profile.noteCount).toBe(3);
    expect(result.profile.linkCount).toBe(1);
    expect(result.profile.detected.likelyProjects).toContain("Projects");
  });

  test("likelyProjects output is sorted deterministically", () => {
    dir = mkdtempSync(join(tmpdir(), "vaultledger-scan-sort-"));
    // Two project-like folders; create in reverse-alpha order to prove sorting.
    mkdirSync(join(dir, "Work"), { recursive: true });
    mkdirSync(join(dir, "Areas"), { recursive: true });
    writeFileSync(join(dir, "Work", "w.md"), "w\n");
    writeFileSync(join(dir, "Areas", "a.md"), "a\n");

    const result = scanVault(dir);

    const lp = result.profile.detected.likelyProjects;
    expect([...lp]).toEqual([...lp].sort());
    expect(lp).toEqual(["Areas", "Work"]);
  });
});
