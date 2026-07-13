import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface PackageJson {
  publishConfig?: { access?: string };
  files?: string[];
  license?: string;
  description?: string;
  repository?: unknown;
  homepage?: string;
  bugs?: unknown;
  engines?: { node?: string };
}

const PUBLISHABLE_PACKAGE_DIRS = [
  "../../core",
  "../../server",
  "../../mcp-server",
  "../../cli",
];

describe("publish metadata", () => {
  for (const relDir of PUBLISHABLE_PACKAGE_DIRS) {
    const dir = join(import.meta.dirname, relDir);

    describe(relDir, () => {
      const pkg: PackageJson = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf8"),
      );

      test("publishConfig.access is public", () => {
        expect(pkg.publishConfig?.access).toBe("public");
      });

      test("files is a non-empty array", () => {
        expect(Array.isArray(pkg.files)).toBe(true);
        expect(pkg.files?.length).toBeGreaterThan(0);
      });

      test("license is MIT", () => {
        expect(pkg.license).toBe("MIT");
      });

      test("description is non-empty", () => {
        expect(typeof pkg.description).toBe("string");
        expect((pkg.description ?? "").length).toBeGreaterThan(0);
      });

      test("repository is non-empty", () => {
        expect(pkg.repository).toBeTruthy();
      });

      test("homepage is non-empty", () => {
        expect(typeof pkg.homepage).toBe("string");
        expect((pkg.homepage ?? "").length).toBeGreaterThan(0);
      });

      test("bugs is non-empty", () => {
        expect(pkg.bugs).toBeTruthy();
      });

      test("engines.node is present", () => {
        expect(typeof pkg.engines?.node).toBe("string");
        expect((pkg.engines?.node ?? "").length).toBeGreaterThan(0);
      });

      test("has a LICENSE file", () => {
        expect(existsSync(join(dir, "LICENSE"))).toBe(true);
      });

      test("has a README.md file", () => {
        expect(existsSync(join(dir, "README.md"))).toBe(true);
      });
    });
  }
});
