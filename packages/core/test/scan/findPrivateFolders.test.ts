import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
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
});
