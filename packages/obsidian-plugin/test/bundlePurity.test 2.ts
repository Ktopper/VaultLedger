import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import esbuild from "esbuild";
import { buildOptions } from "../esbuild.config.mjs";

/**
 * BUNDLE PURITY GUARD (the invariant that crashes the plugin on load if
 * broken). `@vaultledger/core`'s barrel does `export * from
 * "./journal/db.js"`, which imports better-sqlite3 — and its transitive graph
 * pulls in simple-git and proper-lockfile too. Bundled into the plugin's
 * CJS `main.js`, better-sqlite3 emits an UNCONDITIONAL top-level require of a
 * native `.node` addon that isn't shipped alongside main.js, so the plugin
 * would throw the instant Obsidian loads it.
 *
 * bridgeClient.ts avoids this by importing its two value symbols
 * (readConfig/vaultLockDir) from the narrow "@vaultledger/core/config"
 * subpath (fs/path only) rather than the barrel. This test fails loudly if a
 * future value-import from the barrel re-pulls the native graph into the
 * bundle. It builds with the SAME esbuild options `pnpm build` uses (imported
 * from esbuild.config.mjs) into a temp outfile, then greps the bundle text.
 */
describe("bundle purity", () => {
  test(
    "the built main.js contains none of the native-dependent modules",
    async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "vl-bundle-purity-"));
      const outfile = join(tmpDir, "main.js");
      try {
        await esbuild.build({
          ...buildOptions,
          outfile,
          // Sourcemap off: we grep the code, not the map, and it's faster.
          sourcemap: false,
          logLevel: "silent",
        });

        const bundle = readFileSync(outfile, "utf8");

        // Any of these appearing means the native-dependent core graph leaked
        // into the bundle (a value-import from the barrel, most likely).
        const forbidden = [
          "better-sqlite3",
          "better_sqlite3",
          "simple-git",
          "proper-lockfile",
          "node-gyp-build",
          "bindings",
        ];
        for (const needle of forbidden) {
          expect(bundle, `bundle must not contain ${JSON.stringify(needle)}`).not.toContain(needle);
        }

        // Positive sanity: the plugin's own code IS in there (guards against a
        // vacuously-passing empty/failed build).
        expect(bundle).toContain("vaultledger-approvals");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
