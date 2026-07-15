import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import esbuild from "esbuild";
import { buildOptions } from "../esbuild.config.mjs";

/**
 * BUNDLE PURITY GUARD (the invariant that crashes the plugin on load if
 * broken). `@vault-ledger/core`'s barrel does `export * from
 * "./journal/db.js"`, which imports better-sqlite3 — and its transitive graph
 * pulls in simple-git and proper-lockfile too. Bundled into the plugin's
 * CJS `main.js`, better-sqlite3 emits an UNCONDITIONAL top-level require of a
 * native `.node` addon that isn't shipped alongside main.js, so the plugin
 * would throw the instant Obsidian loads it.
 *
 * bridgeClient.ts avoids this by importing its two value symbols
 * (readConfig/vaultLockDir) from the narrow "@vault-ledger/core/config"
 * subpath (fs/path only) rather than the barrel. This test fails loudly if a
 * future value-import from the barrel re-pulls the native graph into the
 * bundle. It builds with the SAME esbuild options `pnpm build` uses (imported
 * from esbuild.config.mjs) into a temp outfile, then greps the bundle text.
 *
 * VL-SEC-S8-02: the same built bundle is also grepped for the DOM-write sinks
 * (`.innerHTML =`, `.outerHTML =`, `insertAdjacentHTML(`, `document.write(`,
 * `dangerouslySetInnerHTML`) that would defeat the plugin's textContent-only
 * XSS defense (see render.ts's SECURITY comment). Scoped to assignment/call
 * patterns rather than the bare property names — a bare `"innerHTML"` grep
 * would also fire on a harmless *read* of `el.innerHTML` or a string that
 * merely mentions the property, which isn't the exploitable sink. This test
 * currently PASSES against the real bundle (confirmed by building and
 * grepping it): the plugin's own source never touches these sinks (verified
 * by direct source grep too), and esbuild doesn't introduce them from any
 * bundled dependency. A future PR that adds e.g. `el.innerHTML = untrusted`
 * anywhere in the bundled graph will fail this test.
 */
describe("bundle purity", () => {
  test(
    "the built main.js contains none of the native-dependent modules, nor any DOM-write XSS sink",
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
        const forbiddenSubstrings = [
          "better-sqlite3",
          "better_sqlite3",
          "simple-git",
          "proper-lockfile",
          "node-gyp-build",
          "bindings",
        ];
        for (const needle of forbiddenSubstrings) {
          expect(bundle, `bundle must not contain ${JSON.stringify(needle)}`).not.toContain(needle);
        }

        // VL-SEC-S8-02: forbidden DOM-write sinks, as regexes scoped to the
        // actual exploitable pattern (assignment/call, not a bare property
        // read or an incidental string match).
        const forbiddenPatterns: RegExp[] = [
          /\.innerHTML\s*=/,
          /\.outerHTML\s*=/,
          /insertAdjacentHTML\s*\(/,
          /document\.write\s*\(/,
          /dangerouslySetInnerHTML/,
        ];
        for (const pattern of forbiddenPatterns) {
          expect(bundle, `bundle must not contain a DOM-write sink matching ${pattern}`).not.toMatch(
            pattern,
          );
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
