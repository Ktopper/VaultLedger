import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPrivateFolders } from "../../src/scan/scanner.js";

describe("findPrivateFolders", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "vl-findpriv-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test("finds nested Private folders at any depth, case-insensitively", () => {
    mkdirSync(join(root, "Private"), { recursive: true });
    mkdirSync(join(root, "Agent", "Memory", "private"), { recursive: true });
    mkdirSync(join(root, "Notes"), { recursive: true });
    const found = findPrivateFolders(root).sort();
    expect(found).toEqual(["Agent/Memory/private", "Private"]);
  });

  test("does not descend into excluded dirs (.git/.obsidian/.ledger/node_modules/.trash)", () => {
    mkdirSync(join(root, ".git", "Private"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg", "Private"), { recursive: true });
    expect(findPrivateFolders(root)).toEqual([]);
  });

  test("a nonexistent root is skipped, not thrown", () => {
    const missing = join(root, "gone");
    expect(() => findPrivateFolders(missing)).not.toThrow();
    expect(findPrivateFolders(missing)).toEqual([]);
  });

  test("an unreadable subdir is skipped (walk continues), not thrown", () => {
    mkdirSync(join(root, "Readable", "Private"), { recursive: true });
    const locked = join(root, "Locked");
    mkdirSync(locked, { recursive: true });
    mkdirSync(join(locked, "Private"), { recursive: true });
    chmodSync(locked, 0o000); // make it unreadable → readdirSync throws EACCES
    try {
      const found = findPrivateFolders(root);
      // The readable branch is still collected; the walk didn't crash. On a
      // permissive CI (e.g. root/Windows) the locked branch may still be read.
      expect(found).toContain("Readable/Private");
    } finally {
      chmodSync(locked, 0o755); // restore so afterEach cleanup can remove it
    }
  });
});
