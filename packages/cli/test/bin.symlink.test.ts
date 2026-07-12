import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

/**
 * Regression guard for the symlink-launch bug (WU-5 follow-up): the CLI's
 * `isMainModule` check compares `import.meta.url` (which Node resolves to the
 * REAL path) against `process.argv[1]` (kept verbatim). pnpm's `ledger` bin
 * shim launches `dist/index.js` through a symlink
 * (node_modules/@vaultledger/cli -> ../../packages/cli), so before the
 * `realpathSync(argv[1])` fix, `run()` never fired and the bin exited 0 with
 * NO output. This test reproduces exactly that shape — spawn the built entry
 * through a temp symlink — and asserts `main()` actually ran (real help
 * output, exit 0). Without the fix it fails (empty stdout).
 *
 * Guarded on the built dist like the smoke test: needs `pnpm -C packages/cli
 * build` first.
 */

const distEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const distBuilt = existsSync(distEntry);

if (!distBuilt) {
  console.warn(
    "[bin.symlink.test] SKIPPED: packages/cli/dist not built — run `pnpm -C packages/cli build`",
  );
}

let linkDir: string;

afterEach(() => {
  if (linkDir) rmSync(linkDir, { recursive: true, force: true });
});

describe.skipIf(!distBuilt)("ledger bin launched through a symlink (pnpm bin-shim shape)", () => {
  test("main() runs — real --help output over a symlinked entry, exit 0", () => {
    linkDir = mkdtempSync(join(tmpdir(), "vl-bin-symlink-"));
    // A symlink that resolves to the real built entry, exactly how pnpm's bin
    // shim reaches it (node_modules/@vaultledger/cli -> packages/cli).
    const linkPath = join(linkDir, "ledger-link.js");
    symlinkSync(distEntry, linkPath);

    // Capture stdout only — if main() never ran, this is empty (the silent
    // exit-0 the fix prevents). execFileSync throws on a non-zero exit, so a
    // clean return already proves exit 0.
    const stdout = execFileSync("node", [linkPath, "--help"], { encoding: "utf8" });

    expect(stdout.length).toBeGreaterThan(0);
    expect(stdout).toContain("Usage");
    expect(stdout).toContain("setup");
  });
});

test.skipIf(distBuilt)("bin.symlink test skipped: packages/cli/dist not built (run `pnpm build` first)", () => {
  expect(distBuilt).toBe(false);
});
