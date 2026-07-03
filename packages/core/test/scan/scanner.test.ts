import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanVault } from "../../src/scan/scanner.js";

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

    expect(result.profile.folders.sort()).toEqual(
      ["Attachments", "Daily", "Private", "Projects", "Templates"].sort(),
    );

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

  test("skips unreadable/binary files without crashing", () => {
    dir = makeVault();
    // Write an invalid-utf8 byte file with a .md extension to simulate a corrupt note
    writeFileSync(join(dir, "Corrupt.md"), Buffer.from([0xff, 0xfe, 0x00, 0xff, 0xff]));

    const result = scanVault(dir);

    // scan should complete without throwing; noteCount should count only .md files (including Corrupt.md itself as a file, just not crash)
    expect(result.profile.noteCount).toBeGreaterThanOrEqual(9);
  });
});
