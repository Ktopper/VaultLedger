import { describe, expect, test } from "vitest";
import { resolveZone } from "../src/zones.js";
import { PermissionsManifest } from "../src/schemas/manifest.js";

describe("resolveZone", () => {
  const manifest = PermissionsManifest.parse({
    zones: {
      trusted: ["**"],
      agent: ["Agent/**"],
      scratch: ["Agent/Scratch/**"],
      excluded: ["Agent/Secret/**"],
    },
    overrides: [{ glob: "Agent/Pinned/**", zone: "trusted" }],
  });

  test("agent path resolves to agent zone", () => {
    expect(resolveZone("Agent/notes.md", manifest)).toBe("agent");
  });

  test("more specific scratch glob wins over agent", () => {
    expect(resolveZone("Agent/Scratch/tmp.md", manifest)).toBe("scratch");
  });

  test("excluded always wins even if agent glob also matches", () => {
    expect(resolveZone("Agent/Secret/x.md", manifest)).toBe("excluded");
  });

  test("override beats base zone", () => {
    expect(resolveZone("Agent/Pinned/keep.md", manifest)).toBe("trusted");
  });

  test("unmatched path with only ** trusted falls back to trusted", () => {
    expect(resolveZone("Random/file.md", manifest)).toBe("trusted");
  });

  test("empty manifest falls back to trusted", () => {
    const empty = PermissionsManifest.parse({});
    expect(resolveZone("anything/here.md", empty)).toBe("trusted");
  });

  test("a shallow override always beats a deeply-nested base-zone match", () => {
    // Invariant: overrides ALWAYS beat base zones regardless of specificity.
    // The override glob has specificity 1; the agent base glob has specificity 6
    // and matches the same path. The override must still win.
    const m = PermissionsManifest.parse({
      zones: {
        agent: ["Agent/a/b/c/d/pinned.md"],
      },
      overrides: [{ glob: "**/pinned.md", zone: "trusted" }],
    });
    expect(resolveZone("Agent/a/b/c/d/pinned.md", m)).toBe("trusted");
  });

  // -------------------------------------------------------------------
  // security: .ledger/** and .git/** are hard-coded, always-excluded
  // regardless of what the manifest says (fix 1).
  // -------------------------------------------------------------------

  describe("hard-coded exclusion of .ledger/** and .git/**", () => {
    // An attacker-controlled manifest that tries to make the security
    // policy itself ("trusted", i.e. writable-with-approval) by matching
    // everything with "**". This must NOT be able to expose .ledger or
    // .git — those are excluded no matter what the manifest configures.
    const manifestWithTrustedStarStar = PermissionsManifest.parse({
      zones: {
        trusted: ["**"],
      },
      overrides: [],
    });

    test(".ledger/permissions.yaml resolves to excluded even though '**' is trusted", () => {
      expect(resolveZone(".ledger/permissions.yaml", manifestWithTrustedStarStar)).toBe(
        "excluded",
      );
    });

    test(".ledger/config.json resolves to excluded", () => {
      expect(resolveZone(".ledger/config.json", manifestWithTrustedStarStar)).toBe("excluded");
    });

    test(".git/config resolves to excluded", () => {
      expect(resolveZone(".git/config", manifestWithTrustedStarStar)).toBe("excluded");
    });

    test("the bare .ledger directory path itself resolves to excluded", () => {
      expect(resolveZone(".ledger", manifestWithTrustedStarStar)).toBe("excluded");
    });

    test("the bare .git directory path itself resolves to excluded", () => {
      expect(resolveZone(".git", manifestWithTrustedStarStar)).toBe("excluded");
    });

    test("an override trying to reclaim .ledger/** as trusted cannot win", () => {
      const m = PermissionsManifest.parse({
        zones: { trusted: ["**"] },
        overrides: [{ glob: ".ledger/**", zone: "trusted" }],
      });
      expect(resolveZone(".ledger/permissions.yaml", m)).toBe("excluded");
    });
  });

  // -------------------------------------------------------------------
  // security (v0.4.6): .obsidian and .obsidian/** are hard-coded,
  // always-excluded regardless of the manifest — it holds Obsidian config
  // plus the review plugin's own data (including the bridge token). No
  // governed read/write may reach it.
  // -------------------------------------------------------------------

  describe("hard-coded exclusion of .obsidian (both glob forms)", () => {
    // A manifest whose excluded list does NOT mention .obsidian at all —
    // the hard-coded exclusion must still apply.
    const m = PermissionsManifest.parse({
      zones: {
        trusted: ["**"],
        excluded: ["Private/**"],
      },
    });

    test("the bare .obsidian directory path itself resolves to excluded", () => {
      expect(resolveZone(".obsidian", m)).toBe("excluded");
    });

    test(".obsidian/plugins/vaultledger/data.json resolves to excluded", () => {
      expect(resolveZone(".obsidian/plugins/vaultledger/data.json", m)).toBe("excluded");
    });
  });

  // -------------------------------------------------------------------
  // security: case-insensitive matching so an APFS/NTFS case-folding
  // filesystem can't be used to dodge an excluded glob (fix 2).
  // -------------------------------------------------------------------

  describe("case-insensitive zone matching (defeats case-folding filesystem escape)", () => {
    const m = PermissionsManifest.parse({
      zones: {
        trusted: ["**"],
        excluded: ["Private/**"],
      },
    });

    test("lowercased path still resolves to excluded", () => {
      expect(resolveZone("private/secret.md", m)).toBe("excluded");
    });

    test("uppercased path still resolves to excluded", () => {
      expect(resolveZone("PRIVATE/x.md", m)).toBe("excluded");
    });

    test("exact-case path still resolves to excluded (unchanged behavior)", () => {
      expect(resolveZone("Private/secret.md", m)).toBe("excluded");
    });
  });
});
