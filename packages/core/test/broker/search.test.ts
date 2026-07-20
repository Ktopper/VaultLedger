import { describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchVault } from "../../src/broker/search.js";
import type { PermissionsManifest } from "../../src/schemas/manifest.js";

// Mirror read.test.ts's MANIFEST — Private/** excluded, ** trusted. No invented globs.
const MANIFEST: PermissionsManifest = {
  version: 1,
  mode: "assisted",
  zones: {
    agent: ["Agent/**"],
    scratch: ["Agent/Scratch/**"],
    excluded: ["Private/**"],
    trusted: ["**"],
  },
  overrides: [],
};

function freshVault(): string {
  return mkdtempSync(join(tmpdir(), "vl-search-"));
}

describe("searchVault", () => {
  // -------- literal, case-insensitive --------
  test("case-insensitive literal hit → {path, snippet, line}", () => {
    const v = freshVault();
    mkdirSync(join(v, "Notes"), { recursive: true });
    writeFileSync(join(v, "Notes", "a.md"), "alpha\nHello World here\nbeta\n");

    const r = searchVault(v, MANIFEST, "hello world"); // lowercase query, mixed-case content
    expect(r.truncated).toBe(false);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].path).toBe("Notes/a.md");
    expect(r.matches[0].line).toBe(2);
    expect(r.matches[0].snippet).toContain("Hello World here");
  });

  test("no match → empty result", () => {
    const v = freshVault();
    writeFileSync(join(v, "a.md"), "nothing to see\n");
    expect(searchVault(v, MANIFEST, "absent")).toEqual({ matches: [], truncated: false });
  });

  test("empty query → empty result (no unbounded zero-length hits)", () => {
    const v = freshVault();
    writeFileSync(join(v, "a.md"), "anything\n");
    expect(searchVault(v, MANIFEST, "")).toEqual({ matches: [], truncated: false });
  });

  // -------- multiple matches (same file, different lines) --------
  test("multiple matches across lines, correct line numbers", () => {
    const v = freshVault();
    writeFileSync(join(v, "a.md"), "findme one\nnope\nfindme two\n");
    const r = searchVault(v, MANIFEST, "findme");
    expect(r.matches).toHaveLength(2);
    expect(r.matches.map((m) => m.line)).toEqual([1, 3]);
  });

  // -------- excluded content NEVER surfaces --------
  test("excluded file containing the query verbatim → empty result, no 'skipped' signal", () => {
    const v = freshVault();
    mkdirSync(join(v, "Private"), { recursive: true });
    writeFileSync(join(v, "Private", "secret.md"), "the FINDME token is here\n");
    mkdirSync(join(v, "Notes"), { recursive: true });
    writeFileSync(join(v, "Notes", "other.md"), "nothing relevant here\n");
    // hard-excluded zones with the query too
    mkdirSync(join(v, ".obsidian"), { recursive: true });
    writeFileSync(join(v, ".obsidian", "cfg.md"), "findme in obsidian\n");
    mkdirSync(join(v, ".ledger"), { recursive: true });
    writeFileSync(join(v, ".ledger", "x.md"), "findme in ledger\n");

    const r = searchVault(v, MANIFEST, "findme");
    // byte-identical to a genuine no-match (no count/skip hint anywhere)
    expect(r).toEqual({ matches: [], truncated: false });
  });

  // -------- oversized + non-UTF-8 skipped silently --------
  test("over-64-KiB file containing the query → skipped, empty result", () => {
    const v = freshVault();
    writeFileSync(join(v, "big.md"), "x".repeat(64 * 1024 + 10) + "findme");
    expect(searchVault(v, MANIFEST, "findme")).toEqual({ matches: [], truncated: false });
  });

  test("non-UTF-8 file whose bytes contain the query → skipped, empty result", () => {
    const v = freshVault();
    // "findme" as ASCII bytes followed by invalid UTF-8 → fails the round-trip check.
    writeFileSync(join(v, "bin.md"), Buffer.concat([Buffer.from("findme"), Buffer.from([0xff, 0xfe, 0x00])]));
    expect(searchVault(v, MANIFEST, "findme")).toEqual({ matches: [], truncated: false });
  });

  // -------- HOLD 3: skip/filter BEFORE cap --------
  test("filter-before-cap: a skipped file that would match does not change {matches, truncated}", () => {
    // Vault A: 2 real hits + an excluded file + an oversized file, both matching.
    const withSkipped = freshVault();
    mkdirSync(join(withSkipped, "Notes"), { recursive: true });
    writeFileSync(join(withSkipped, "Notes", "a.md"), "findme\n");
    writeFileSync(join(withSkipped, "Notes", "b.md"), "findme\n");
    mkdirSync(join(withSkipped, "Private"), { recursive: true });
    writeFileSync(join(withSkipped, "Private", "c.md"), "findme\n"); // excluded, would match
    writeFileSync(join(withSkipped, "Notes", "big.md"), "x".repeat(64 * 1024 + 10) + "findme"); // oversized

    // Vault B: only the 2 real hits.
    const without = freshVault();
    mkdirSync(join(without, "Notes"), { recursive: true });
    writeFileSync(join(without, "Notes", "a.md"), "findme\n");
    writeFileSync(join(without, "Notes", "b.md"), "findme\n");

    const a = searchVault(withSkipped, MANIFEST, "findme", { maxMatches: 2 });
    const b = searchVault(without, MANIFEST, "findme", { maxMatches: 2 });
    // Cap is 2, exactly 2 REAL hits → truncated:false; the skipped files must NOT
    // nudge the cap or the flag. Byte-identical payloads.
    expect(a).toEqual(b);
    expect(a.truncated).toBe(false);
    expect(a.matches.map((m) => m.path)).toEqual(["Notes/a.md", "Notes/b.md"]);
  });

  test("truncated:true when REAL hits exceed the cap", () => {
    const v = freshVault();
    mkdirSync(join(v, "Notes"), { recursive: true });
    writeFileSync(join(v, "Notes", "a.md"), "findme\n");
    writeFileSync(join(v, "Notes", "b.md"), "findme\n");
    writeFileSync(join(v, "Notes", "c.md"), "findme\n");
    const r = searchVault(v, MANIFEST, "findme", { maxMatches: 2 });
    expect(r.truncated).toBe(true);
    expect(r.matches).toHaveLength(2);
  });

  test("exactly maxMatches real hits → truncated:false (boundary)", () => {
    const v = freshVault();
    mkdirSync(join(v, "Notes"), { recursive: true });
    writeFileSync(join(v, "Notes", "a.md"), "findme\n");
    writeFileSync(join(v, "Notes", "b.md"), "findme\n");
    const r = searchVault(v, MANIFEST, "findme", { maxMatches: 2 });
    expect(r.truncated).toBe(false);
    expect(r.matches).toHaveLength(2);
  });

  // -------- snippet bounded + centered --------
  test("snippet is bounded to SEARCH_SNIPPET_MAX and centered on the match", () => {
    const v = freshVault();
    const long = "a".repeat(500) + "NEEDLE" + "b".repeat(500);
    writeFileSync(join(v, "long.md"), long + "\n");
    const r = searchVault(v, MANIFEST, "needle", { snippetMax: 200 });
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].snippet.length).toBeLessThanOrEqual(200);
    expect(r.matches[0].snippet).toContain("NEEDLE"); // the match is inside the window
  });
});
