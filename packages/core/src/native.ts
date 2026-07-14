import Database from "better-sqlite3";

export type NativeProbe = { ok: true } | { ok: false; error: string };

/**
 * Read-only health probe for the `better-sqlite3` native binding. Opens (and
 * immediately closes) an in-memory database — no file, no vault touch — which
 * forces the compiled `.node` binding to actually load. A missing/unbuilt
 * binding (the classic pnpm-10 "skipped approve-builds" state our own docs warn
 * about) surfaces here as `{ok:false}` instead of only blowing up later, deep
 * in a journal open, with a raw bindings path dump. `:memory:` never uses WAL
 * and writes nothing to disk, so this stays within `ledger doctor`'s read-only
 * guarantee.
 */
export function probeNativeDeps(): NativeProbe {
  try {
    const db = new Database(":memory:");
    db.close();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const NATIVE_REMEDY =
  "better-sqlite3's native binding failed to load. Reinstall it — on pnpm 10 run " +
  "`pnpm approve-builds` (or add it to the package.json `pnpm.onlyBuiltDependencies` " +
  "allowlist) and reinstall; otherwise `npm rebuild better-sqlite3`. " +
  "Run `ledger doctor <vault>` for a full check.";

/**
 * If `e` is the `better-sqlite3` "native binding won't load" error class,
 * return a one-line remediation; otherwise `null`. Both the CLI (`reportError`)
 * and the MCP server (entry catch) route their top-level error printing through
 * this so a broken native install yields ONE actionable line instead of the raw
 * ~14-line `bindings` path dump that leaves a user with no idea what to do.
 *
 * Matches the missing-binding message, the wrong-arch/wrong-Node ABI messages,
 * and the bare `.node` filename — the family of ways a native module fails to
 * load on a machine it wasn't built for.
 */
export function explainNativeBindingError(e: unknown): string | null {
  const msg = e instanceof Error ? e.message : String(e);
  const NATIVE_ERR_RE =
    /could not locate the bindings file|better_sqlite3\.node|invalid elf header|was compiled against a different node|node_module_version/i;
  return NATIVE_ERR_RE.test(msg) ? NATIVE_REMEDY : null;
}
