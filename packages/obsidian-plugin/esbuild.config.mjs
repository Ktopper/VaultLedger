import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The single source of esbuild options for the Obsidian plugin bundle, shared
 * between the CLI build (`node esbuild.config.mjs` / `pnpm build`) and the
 * bundle-purity guard test (test/bundlePurity.test.ts), so both exercise the
 * EXACT same configuration. Obsidian loads CJS, and `obsidian`/`electron` are
 * provided by the host at runtime, so they're marked external.
 *
 * Paths are resolved against this file's own directory (not process.cwd()) so
 * the config produces the same bundle regardless of where it's invoked from.
 */
export const buildOptions = {
  entryPoints: [resolve(here, "src/main.ts")],
  outfile: resolve(here, "main.js"),
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2022",
  external: ["obsidian", "electron"],
  sourcemap: true,
  logLevel: "info",
};

// Only build when run directly (`node esbuild.config.mjs`), not when imported
// by the purity test (which wants the options object, not a side-effecting
// build on import).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await esbuild.build(buildOptions);
}
