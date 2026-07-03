import { describe, expect, test } from "vitest";
import { PermissionsManifest } from "../../src/schemas/manifest.js";

describe("PermissionsManifest", () => {
  test("parses zones as glob lists", () => {
    const input = {
      zones: {
        trusted: ["Notes/**"],
        agent: ["Agent/**"],
        scratch: ["Agent/Scratch/**"],
        excluded: ["Agent/Secret/**"],
      },
    };
    const parsed = PermissionsManifest.parse(input);
    expect(parsed.zones.trusted).toEqual(["Notes/**"]);
    expect(parsed.zones.agent).toEqual(["Agent/**"]);
    expect(parsed.zones.scratch).toEqual(["Agent/Scratch/**"]);
    expect(parsed.zones.excluded).toEqual(["Agent/Secret/**"]);
  });

  test("mode defaults to assisted", () => {
    const input = { zones: {} };
    const parsed = PermissionsManifest.parse(input);
    expect(parsed.mode).toBe("assisted");
  });

  test("overrides are optional and default to empty array", () => {
    const input = { zones: {} };
    const parsed = PermissionsManifest.parse(input);
    expect(parsed.overrides).toEqual([]);
  });

  test("overrides parse when provided", () => {
    const input = {
      zones: {},
      overrides: [{ glob: "Agent/Pinned/**", zone: "trusted" }],
    };
    const parsed = PermissionsManifest.parse(input);
    expect(parsed.overrides).toEqual([{ glob: "Agent/Pinned/**", zone: "trusted" }]);
  });

  test("empty manifest defaults all zones to empty arrays", () => {
    const parsed = PermissionsManifest.parse({});
    expect(parsed.zones.trusted).toEqual([]);
    expect(parsed.zones.agent).toEqual([]);
    expect(parsed.zones.scratch).toEqual([]);
    expect(parsed.zones.excluded).toEqual([]);
    expect(parsed.version).toBe(1);
  });
});
