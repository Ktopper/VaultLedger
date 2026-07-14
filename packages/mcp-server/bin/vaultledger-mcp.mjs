#!/usr/bin/env node
// Committed launcher (decouples bin-linking from build order): this file
// EXISTS at the very first `pnpm install`, so pnpm links the
// `vaultledger-mcp` bin immediately — unlike a `"bin": "./dist/index.js"`
// field, which doesn't exist yet at first install and so links nothing
// (pnpm 11's second `pnpm install` is a no-op, it does not retroactively
// create the link).
//
// `dist/index.js`'s `main()` only auto-runs under an `isMainModule` guard
// that compares `import.meta.url` to `realpathSync(process.argv[1])`. When
// Node runs THIS file, `argv[1]` is this launcher's path, not
// `dist/index.js` — so that guard is false and `dist/index.js`'s own
// auto-run never fires. We call the exported `main()` explicitly instead.
import { main, explainNativeBindingError } from "../dist/index.js";

main().catch((e) => {
  // A broken better-sqlite3 native binding otherwise dumps a raw ~14-line
  // `bindings` path list; collapse that class to one actionable line.
  console.error(explainNativeBindingError(e) ?? (e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
});
