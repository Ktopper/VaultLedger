import { describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVaultFile } from "../../src/broker/read.js";
import { hashBytes } from "../../src/broker/hash.js";
import { BrokerError } from "../../src/errors.js";
import type { PermissionsManifest } from "../../src/schemas/manifest.js";

// Canonical minimal test manifest — same shape as broker.test.ts's MANIFEST:
// Agent/** is agent-zone (readable), Private/** is excluded, ** is trusted
// (so Notes/** etc. resolve to trusted, also readable). Do NOT invent globs —
// resolveZone must behave exactly as in production.
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

function makeVault(): string {
  const v = mkdtempSync(join(tmpdir(), "vr-"));
  mkdirSync(join(v, "Agent"), { recursive: true });
  mkdirSync(join(v, "Notes"), { recursive: true });
  mkdirSync(join(v, "Private"), { recursive: true });
  return v;
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

describe("readVaultFile", () => {
  // -------- hash symmetry --------
  test("hash covers exactly the returned bytes (trailing newline)", () => {
    const v = makeVault();
    writeFileSync(join(v, "Agent", "n.md"), "hello\nworld\n");
    const r = readVaultFile(v, MANIFEST, "Agent/n.md");
    expect(r.path).toBe("Agent/n.md");
    expect(r.content).toBe("hello\nworld\n");
    expect(r.hash).toBe(hashBytes(Buffer.from(r.content, "utf8")));
    expect(r.size).toBe(Buffer.byteLength(r.content, "utf8"));
    expect(r.content.endsWith("\n")).toBe(true);
  });

  test("hash covers exactly the returned bytes (NO trailing newline)", () => {
    const v = makeVault();
    writeFileSync(join(v, "Agent", "n.md"), "a\nb");
    const r = readVaultFile(v, MANIFEST, "Agent/n.md");
    expect(r.content).toBe("a\nb");
    expect(r.content.endsWith("\n")).toBe(false);
    expect(r.hash).toBe(hashBytes(Buffer.from(r.content, "utf8")));
    expect(r.size).toBe(3);
  });

  // -------- cap boundary via opts.maxBytes --------
  test("exactly maxBytes reads; maxBytes-1 → FILE_TOO_LARGE (non-retriable)", () => {
    const v = makeVault();
    writeFileSync(join(v, "Agent", "cap.md"), "0123456789"); // 10 bytes
    // exactly at the cap: ok
    const ok = readVaultFile(v, MANIFEST, "Agent/cap.md", { maxBytes: 10 });
    expect(ok.size).toBe(10);
    // one under the cap: rejected
    const r = rej(() => readVaultFile(v, MANIFEST, "Agent/cap.md", { maxBytes: 9 }));
    expect(r.code).toBe("FILE_TOO_LARGE");
    expect(r.retriable).toBe(false);
  });

  test("FILE_TOO_LARGE message names the cap and steers to a human (no guess fallback)", () => {
    const v = makeVault();
    writeFileSync(join(v, "Agent", "big.md"), "0123456789");
    const r = rej(() => readVaultFile(v, MANIFEST, "Agent/big.md", { maxBytes: 5 }));
    expect(r.code).toBe("FILE_TOO_LARGE");
    expect(r.message).toMatch(/cannot be .*edited/i);
    expect(r.message).toMatch(/human/i);
    // must NOT invite reconstructing from memory
    expect(r.message).toMatch(/do not reconstruct/i);
  });

  // -------- errno / dir --------
  test("missing file → NOT_FOUND retriable:true", () => {
    const v = makeVault();
    expect(rej(() => readVaultFile(v, MANIFEST, "Agent/ghost.md"))).toMatchObject({
      code: "NOT_FOUND",
      retriable: true,
    });
  });

  test("directory path → NOT_FOUND (never reaches readFileSync / EISDIR)", () => {
    const v = makeVault();
    mkdirSync(join(v, "Agent", "dir"), { recursive: true });
    const r = rej(() => readVaultFile(v, MANIFEST, "Agent/dir"));
    expect(r.code).toBe("NOT_FOUND");
    expect(r.retriable).toBe(true);
    expect(r.message).toMatch(/^file not found: /);
  });

  // -------- non-UTF-8 --------
  test("non-UTF-8 file → NOT_TEXT (non-retriable)", () => {
    const v = makeVault();
    writeFileSync(join(v, "Agent", "bin.md"), Buffer.from([0xff, 0xfe, 0x00]));
    const r = rej(() => readVaultFile(v, MANIFEST, "Agent/bin.md"));
    expect(r.code).toBe("NOT_TEXT");
    expect(r.retriable).toBe(false);
  });

  test("valid UTF-8 with multibyte chars round-trips (no false NOT_TEXT)", () => {
    const v = makeVault();
    writeFileSync(join(v, "Agent", "uni.md"), "héllo — 世界 🌍\n");
    const r = readVaultFile(v, MANIFEST, "Agent/uni.md");
    expect(r.content).toBe("héllo — 世界 🌍\n");
    expect(r.hash).toBe(hashBytes(Buffer.from(r.content, "utf8")));
  });

  // -------- traversal / symlink stay FORBIDDEN_ZONE --------
  test("traversal → FORBIDDEN_ZONE", () => {
    const v = makeVault();
    expect(rej(() => readVaultFile(v, MANIFEST, "../outside")).code).toBe("FORBIDDEN_ZONE");
  });

  // -------- THE oracle test — excluded ≡ missing (VL-SEC-S7-04) --------
  test("excluded-but-existing and missing produce identical rejection payloads (VL-SEC-S7-04)", () => {
    const v = makeVault();
    writeFileSync(join(v, "Private", "secret.md"), "top secret\n"); // exists, excluded
    // Notes/ghost.md missing
    const ex = rej(() => readVaultFile(v, MANIFEST, "Private/secret.md"));
    const miss = rej(() => readVaultFile(v, MANIFEST, "Notes/ghost.md"));
    expect(ex.code).toBe("NOT_FOUND");
    expect(ex.retriable).toBe(true);
    // byte-identical code+retriable payload
    expect({ code: ex.code, retriable: ex.retriable }).toEqual({
      code: miss.code,
      retriable: miss.retriable,
    });
    expect(ex.message).toMatch(/^file not found: /);
    expect(miss.message).toMatch(/^file not found: /);
    // no zone vocabulary leaks in either message
    for (const m of [ex.message, miss.message]) {
      expect(m).not.toMatch(/exclud|zone|forbidden/i);
    }
  });

  test(".ledger / .git / .obsidian reads → NOT_FOUND (indistinguishable), manifest notwithstanding", () => {
    const v = makeVault();
    // Seed each hard-excluded path so it genuinely exists on disk.
    mkdirSync(join(v, ".ledger"), { recursive: true });
    writeFileSync(join(v, ".ledger", "permissions.yaml"), "version: 1\n");
    mkdirSync(join(v, ".git"), { recursive: true });
    writeFileSync(join(v, ".git", "config"), "[core]\n");
    mkdirSync(join(v, ".obsidian", "plugins", "vaultledger"), { recursive: true });
    writeFileSync(join(v, ".obsidian", "plugins", "vaultledger", "data.json"), "{}\n");
    for (const p of [
      ".ledger/permissions.yaml",
      ".git/config",
      ".obsidian/plugins/vaultledger/data.json",
    ]) {
      const r = rej(() => readVaultFile(v, MANIFEST, p));
      expect(r.code).toBe("NOT_FOUND");
      expect(r.retriable).toBe(true);
      expect(r.message).toMatch(/^file not found: /);
      expect(r.message).not.toMatch(/exclud|zone|forbidden/i);
    }
  });
});
