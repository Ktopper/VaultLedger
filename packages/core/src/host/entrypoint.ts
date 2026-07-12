import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Is `argv1` (typically `process.argv[1]`) the same file as `moduleUrl`
 * (typically `import.meta.url`)? Used by every VaultLedger bin entrypoint
 * (`packages/cli/src/index.ts`, `packages/mcp-server/src/index.ts`) to guard
 * "only auto-run main() when this file is the process's actual entry point,
 * never when a test imports it" — hoisted here once both depend on
 * `@vaultledger/core` anyway, rather than duplicating the guard verbatim in
 * each bin.
 *
 * Compares via `pathToFileURL` (not a bare `file://${argv1}` template) so
 * this still matches when the path contains characters (spaces, unicode,
 * ...) that `import.meta.url` percent-encodes — a bare template-literal
 * comparison would silently never match (and so never run `main()`) for any
 * install/vault path containing a space, which is common enough (this
 * repo's own path included) to be a real bug rather than a hypothetical one.
 *
 * `realpathSync` on `argv1` is load-bearing whenever the file is launched
 * through a workspace-linked symlink (e.g. pnpm's bin shim,
 * `node_modules/@vaultledger/<pkg> -> ../../packages/<pkg>`): Node's ESM
 * loader resolves `moduleUrl` to the REAL path, but `argv1` keeps the
 * symlinked path verbatim — `pathToFileURL` alone doesn't resolve symlinks,
 * so a bare comparison silently mismatches and the bin looks installed, runs,
 * and exits 0 having done nothing.
 *
 * The `realpathSync` call is wrapped so a defined-but-nonexistent `argv1`
 * (which makes it throw `ENOENT`) degrades to `false` rather than crashing —
 * importing an entrypoint module must never throw.
 */
export function resolvesToThisModule(argv1: string | undefined, moduleUrl: string): boolean {
  if (argv1 === undefined) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}
