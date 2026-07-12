import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * Proves the COMMITTED bin launcher (`packages/cli/bin/ledger.mjs`, what
 * `"bin": { "ledger": "./bin/ledger.mjs" }` in package.json actually points
 * at) boots the real CLI, not just that `dist/index.js` works when run
 * directly (that's `bin.symlink.test.ts`).
 *
 * This is the regression guard for the fresh-clone BLOCKER: the launcher
 * imports `../dist/index.js` and calls its exported `main()` explicitly,
 * because `dist/index.js`'s own `isMainModule` auto-run guard is FALSE when
 * invoked this way (`process.argv[1]` is the launcher's path, not
 * `dist/index.js`'s). A launcher that only `import`s `dist/index.js` without
 * calling `main()` would print nothing and exit 0 — silently broken — which
 * is exactly the shape this test catches: it asserts real stdout content,
 * not just a clean exit code.
 *
 * Guarded on the built dist like the other bin tests — needs `pnpm -C
 * packages/cli build` first.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const launcherPath = join(__dirname, "..", "bin", "ledger.mjs");
const distEntry = join(__dirname, "..", "dist", "index.js");
const distBuilt = existsSync(distEntry);

if (!distBuilt) {
  console.warn(
    "[bin.launcher.test] SKIPPED: packages/cli/dist not built — run `pnpm -C packages/cli build`",
  );
}

describe.skipIf(!distBuilt)("ledger.mjs bin launcher (the actual package.json \"bin\" target)", () => {
  test("--version prints 0.4.0 and exits 0", () => {
    const stdout = execFileSync("node", [launcherPath, "--version"], { encoding: "utf8" });
    expect(stdout.trim()).toBe("0.4.0");
  });

  test("--help prints real commander output (proves main() actually ran)", () => {
    const stdout = execFileSync("node", [launcherPath, "--help"], { encoding: "utf8" });
    expect(stdout.length).toBeGreaterThan(0);
    expect(stdout).toContain("Usage");
    expect(stdout).toContain("setup");
  });
});

test.skipIf(distBuilt)("bin.launcher test skipped: packages/cli/dist not built (run `pnpm build` first)", () => {
  expect(distBuilt).toBe(false);
});
