import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StepResult } from "./types.js";

/**
 * Resolve the `@vaultledger/obsidian-plugin` package ROOT via Node module
 * resolution. The package is `private` with no `main`/`exports` (it's a
 * leaf Obsidian plugin, not a library any workspace package imports), so a
 * bare `require.resolve("@vaultledger/obsidian-plugin")` throws
 * MODULE_NOT_FOUND. Resolving the `package.json` subpath instead works
 * because there's no `exports` map gating it, and its dirname IS the
 * package root — where esbuild's `outfile` puts the bundled `main.js` and
 * where `manifest.json` lives (NOT `dist/`, which is unrelated tsc output
 * from a pre-Phase-4 stub).
 */
export function resolvePluginRoot(): string | null {
  const require = createRequire(import.meta.url);
  try {
    return dirname(require.resolve("@vaultledger/obsidian-plugin/package.json"));
  } catch {
    return null;
  }
}

const ENABLE_HINT =
  "\n  Enable it: Obsidian → Settings → Community plugins → (turn off Restricted mode) → enable VaultLedger";

/** Read a manifest's `version` field, tolerating a missing or malformed
 * file by returning null rather than throwing — a corrupt manifest must
 * fail this one step cleanly, not crash the whole `setup` run. */
function readVersion(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const version = (parsed as { version?: unknown } | null)?.version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/**
 * `ledger setup --install-plugin`: copy the built Obsidian review-plugin
 * bundle (`manifest.json` + `main.js`, plus `styles.css` if present) from
 * the `@vaultledger/obsidian-plugin` package root into
 * `<vault>/.obsidian/plugins/vaultledger/`.
 *
 * This is the ONE sanctioned human-initiated exception to the
 * `.ledger/`-only in-vault footprint invariant (see CLAUDE.md): it's an
 * explicit opt-in flag, it touches Obsidian config, and it never touches
 * vault notes.
 *
 * Copying does NOT activate the plugin — Obsidian still requires a manual
 * enable — so the returned `detail` always carries that instruction.
 *
 * Freshness is compared BEFORE copying (fresh dest → "created", same
 * version → "already", older version at dest → "updated"), which is what
 * drives `ledger setup`'s diagnostic re-run.
 *
 * `resolveRoot` is an injectable seam (defaults to `resolvePluginRoot`) so
 * tests can point the not-built / not-found guards at fixture directories
 * without needing an actually-broken monorepo install; production callers
 * never pass it.
 */
export async function installPlugin(
  vault: string,
  resolveRoot: () => string | null = resolvePluginRoot,
): Promise<StepResult> {
  const root = resolveRoot();
  if (root === null) {
    return { step: "plugin", state: "failed", detail: "plugin package not found" };
  }

  const mainJs = join(root, "main.js");
  const manifest = join(root, "manifest.json");
  if (!existsSync(mainJs)) {
    return {
      step: "plugin",
      state: "failed",
      detail: "plugin not built — run: pnpm -C packages/obsidian-plugin build",
    };
  }

  const pkgVersion = readVersion(manifest);
  if (pkgVersion === null) {
    return { step: "plugin", state: "failed", detail: `unreadable plugin manifest: ${manifest}` };
  }

  const dest = join(vault, ".obsidian", "plugins", "vaultledger");
  const destManifest = join(dest, "manifest.json");
  // Freshness compare BEFORE copying (drives the diagnostic re-run).
  const installedVersion = readVersion(destManifest);

  mkdirSync(dest, { recursive: true });
  copyFileSync(manifest, destManifest);
  copyFileSync(mainJs, join(dest, "main.js"));
  const styles = join(root, "styles.css");
  if (existsSync(styles)) copyFileSync(styles, join(dest, "styles.css")); // copy-if-present (future-proof)

  if (installedVersion === null) {
    return { step: "plugin", state: "created", detail: `installed v${pkgVersion} → ${dest}${ENABLE_HINT}` };
  }
  if (installedVersion === pkgVersion) {
    return { step: "plugin", state: "already", detail: `v${pkgVersion} already current${ENABLE_HINT}` };
  }
  return {
    step: "plugin",
    state: "updated",
    detail: `updated v${installedVersion} → v${pkgVersion} → ${dest}${ENABLE_HINT}`,
  };
}
