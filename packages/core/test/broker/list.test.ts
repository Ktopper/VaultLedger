import { describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listVaultDir } from "../../src/broker/list.js";
import { BrokerError } from "../../src/errors.js";
import type { PermissionsManifest } from "../../src/schemas/manifest.js";

// Mirror read.test.ts / broker.test.ts's MANIFEST exactly — Agent/** agent,
// Agent/Scratch/** scratch, Private/** excluded, ** trusted. Do NOT invent globs.
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
  return mkdtempSync(join(tmpdir(), "vl-list-"));
}

function rej(fn: () => unknown): { code: string; retriable: boolean; message: string } {
  try {
    fn();
  } catch (e) {
    if (e instanceof BrokerError) return { code: e.code, retriable: e.retriable, message: e.message };
    throw e;
  }
  throw new Error("expected a BrokerError");
}

describe("listVaultDir", () => {
  // -------- happy path --------
  test("lists a dir with files + subdirs; kind file/dir; size on files only", () => {
    const v = freshVault();
    mkdirSync(join(v, "Notes"), { recursive: true });
    writeFileSync(join(v, "Notes", "a.md"), "hello\n"); // 6 bytes
    mkdirSync(join(v, "Notes", "sub"), { recursive: true });

    const r = listVaultDir(v, MANIFEST, "Notes");
    expect(r.path).toBe("Notes");
    expect(r.truncated).toBe(false);
    expect(r.entries).toEqual([
      { name: "a.md", kind: "file", size: 6 },
      { name: "sub", kind: "dir" },
    ]);
  });

  test("root: path '.' lists the vault root", () => {
    const v = freshVault();
    writeFileSync(join(v, "top.md"), "x\n");
    mkdirSync(join(v, "Notes"), { recursive: true });
    const r = listVaultDir(v, MANIFEST, ".");
    expect(r.path).toBe(".");
    expect(r.entries).toEqual([
      { name: "Notes", kind: "dir" },
      { name: "top.md", kind: "file", size: 2 },
    ]);
  });

  // -------- excluded entries SILENTLY OMITTED --------
  test("excluded entries (Private, .obsidian, .git, .ledger) are omitted with no marker", () => {
    const v = freshVault();
    writeFileSync(join(v, "readme.md"), "hi\n");
    mkdirSync(join(v, "Notes"), { recursive: true });
    mkdirSync(join(v, "Private"), { recursive: true });
    writeFileSync(join(v, "Private", "secret.md"), "top secret\n");
    mkdirSync(join(v, ".obsidian"), { recursive: true });
    mkdirSync(join(v, ".git"), { recursive: true });
    mkdirSync(join(v, ".ledger"), { recursive: true });

    const r = listVaultDir(v, MANIFEST, ".");
    const names = r.entries.map((e) => e.name);
    expect(names).toEqual(["Notes", "readme.md"]);
    // no zone vocabulary / count hint leaks in the payload
    expect(JSON.stringify(r)).not.toMatch(/Private|obsidian|\.git|\.ledger|exclud/i);
  });

  // -------- payload-identity: only-excluded ≡ empty --------
  test("a dir whose only real entry is excluded is byte-identical to an empty dir", () => {
    const onlyExcluded = freshVault();
    mkdirSync(join(onlyExcluded, ".git"), { recursive: true }); // always-excluded, only entry

    const empty = freshVault(); // truly empty root

    const a = listVaultDir(onlyExcluded, MANIFEST, ".");
    const b = listVaultDir(empty, MANIFEST, ".");
    expect(a).toEqual({ path: ".", entries: [], truncated: false });
    expect(a).toEqual(b);
  });

  // -------- HOLD 3: filter-before-cap boundary --------
  test("filter-before-cap: maxEntries visible + 1 excluded ≡ maxEntries visible + 0 excluded", () => {
    const withExcluded = freshVault();
    writeFileSync(join(withExcluded, "a.md"), "1\n");
    writeFileSync(join(withExcluded, "b.md"), "1\n");
    writeFileSync(join(withExcluded, "c.md"), "1\n");
    mkdirSync(join(withExcluded, ".obsidian"), { recursive: true }); // 1 excluded entry

    const without = freshVault();
    writeFileSync(join(without, "a.md"), "1\n");
    writeFileSync(join(without, "b.md"), "1\n");
    writeFileSync(join(without, "c.md"), "1\n");

    const a = listVaultDir(withExcluded, MANIFEST, ".", { maxEntries: 3 });
    const b = listVaultDir(without, MANIFEST, ".", { maxEntries: 3 });
    // BYTE-IDENTICAL: the excluded entry at the boundary must NOT flip truncated
    // or the count. (Filter-after-cap would give the excluded vault truncated:true.)
    expect(a).toEqual(b);
    expect(a.truncated).toBe(false);
    expect(a.entries.map((e) => e.name)).toEqual(["a.md", "b.md", "c.md"]);
  });

  test("truncated:true when the POST-omission count exceeds maxEntries", () => {
    const v = freshVault();
    writeFileSync(join(v, "a.md"), "1\n");
    writeFileSync(join(v, "b.md"), "1\n");
    writeFileSync(join(v, "c.md"), "1\n");
    const r = listVaultDir(v, MANIFEST, ".", { maxEntries: 2 });
    expect(r.truncated).toBe(true);
    expect(r.entries).toHaveLength(2);
    expect(r.entries.map((e) => e.name)).toEqual(["a.md", "b.md"]);
  });

  // -------- empty vs missing --------
  test("empty dir → entries:[] (not NOT_FOUND)", () => {
    const v = freshVault();
    mkdirSync(join(v, "Empty"), { recursive: true });
    const r = listVaultDir(v, MANIFEST, "Empty");
    expect(r).toEqual({ path: "Empty", entries: [], truncated: false });
  });

  test("missing dir → NOT_FOUND (retriable)", () => {
    const v = freshVault();
    const r = rej(() => listVaultDir(v, MANIFEST, "Ghost"));
    expect(r.code).toBe("NOT_FOUND");
    expect(r.retriable).toBe(true);
  });

  test("a file path (not a dir) → NOT_FOUND", () => {
    const v = freshVault();
    writeFileSync(join(v, "file.md"), "x\n");
    const r = rej(() => listVaultDir(v, MANIFEST, "file.md"));
    expect(r.code).toBe("NOT_FOUND");
    expect(r.retriable).toBe(true);
  });

  // -------- containment / oracle --------
  test("traversal → FORBIDDEN_ZONE", () => {
    const v = freshVault();
    expect(rej(() => listVaultDir(v, MANIFEST, "../outside")).code).toBe("FORBIDDEN_ZONE");
  });

  test("symlink escape → FORBIDDEN_ZONE", () => {
    const v = freshVault();
    const outside = mkdtempSync(join(tmpdir(), "vl-outside-"));
    symlinkSync(outside, join(v, "Link"));
    expect(rej(() => listVaultDir(v, MANIFEST, "Link")).code).toBe("FORBIDDEN_ZONE");
  });

  test("excluded dir → NOT_FOUND, indistinguishable from a missing dir (oracle)", () => {
    const v = freshVault();
    mkdirSync(join(v, "Private"), { recursive: true });
    writeFileSync(join(v, "Private", "secret.md"), "top secret\n");
    const ex = rej(() => listVaultDir(v, MANIFEST, "Private"));
    const miss = rej(() => listVaultDir(v, MANIFEST, "Ghost"));
    expect(ex.code).toBe("NOT_FOUND");
    expect({ code: ex.code, retriable: ex.retriable }).toEqual({
      code: miss.code,
      retriable: miss.retriable,
    });
    // Both messages have the same shape (only the echoed input path differs — the
    // caller already knows the path it passed; that is not a zone leak). No zone
    // vocabulary leaks in either message (mirrors the read oracle).
    expect(ex.message).toMatch(/^directory not found: /);
    expect(miss.message).toMatch(/^directory not found: /);
    for (const m of [ex.message, miss.message]) {
      expect(m).not.toMatch(/exclud|zone|forbidden/i);
    }
  });

  test(".obsidian / .ledger / .git listed directly → NOT_FOUND (hard-excluded)", () => {
    const v = freshVault();
    mkdirSync(join(v, ".obsidian"), { recursive: true });
    mkdirSync(join(v, ".ledger"), { recursive: true });
    mkdirSync(join(v, ".git"), { recursive: true });
    for (const p of [".obsidian", ".ledger", ".git"]) {
      expect(rej(() => listVaultDir(v, MANIFEST, p)).code).toBe("NOT_FOUND");
    }
  });

  // -------- dot-dot / symlink into an excluded zone as the TARGET → NOT_FOUND --------
  test("dot-dot / symlink into an excluded zone as the target → NOT_FOUND (not FORBIDDEN, not a leak)", () => {
    const v = freshVault();
    mkdirSync(join(v, "Private"), { recursive: true });
    writeFileSync(join(v, "Private", "secret.md"), "top secret\n");
    mkdirSync(join(v, "Notes"), { recursive: true });
    symlinkSync(join(v, "Private"), join(v, "Link")); // Link -> Private (excluded)
    for (const p of ["Notes/../Private", "Link"]) {
      const r = rej(() => listVaultDir(v, MANIFEST, p));
      expect(r.code).toBe("NOT_FOUND"); // a leak would return entries; a raw-path bug FORBIDDEN
    }
  });
});
