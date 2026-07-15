import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
describe("cli is publishable", () => {
  test("no private @vault-ledger workspace package in dependencies", () => {
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps).not.toContain("@vault-ledger/obsidian-plugin");
  });
});
