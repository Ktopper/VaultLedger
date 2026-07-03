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
});
