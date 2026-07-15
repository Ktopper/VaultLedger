import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StepResult } from "./types.js";

/**
 * Resolve the `@vault-ledger/obsidian-plugin` package ROOT via Node module
 * resolution. The package is `private` with no `main`/`exports` (it's a
 * leaf Obsidian plugin, not a library any workspace package imports), so a
 * bare `require.resolve("@vault-ledger/obsidian-plugin")` throws
 * MODULE_NOT_FOUND. Resolving the `package.json` subpath instead works
 * because there's no `exports` map gating it, and its dirname IS the
 * package root — where esbuild's `outfile` puts the bundled `main.js` and
 * where `manifest.json` lives (NOT `dist/`, which is unrelated tsc output
 * from a pre-Phase-4 stub).
 */
export function resolvePluginRoot(): string | null {
  const require = createRequire(import.meta.url);
  try {
    return dirname(require.resolve("@vault-ledger/obsidian-plugin/package.json"));
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
 * the `@vault-ledger/obsidian-plugin` package root into
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
    return {
      step: "plugin",
      state: "failed",
      detail:
        "plugin not available in this install — get it from the Obsidian community-plugin store (once listed) or github.com/Ktopper/VaultLedger/releases; from a source clone, `pnpm -C packages/obsidian-plugin build` then rerun --install-plugin",
    };
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

/**
 * Read-only freshness probe for a FLAGLESS `ledger setup` re-run (no
 * `--install-plugin`, no copy): tells a user whose plugin is already
 * installed that it's stale, without ever nagging a user who never
 * installed it in the first place.
 *
 * - Not installed (no dest manifest) → `null` — nothing to report.
 * - Installed, but the `@vault-ledger/obsidian-plugin` package doesn't
 *   resolve (or its manifest is missing/unbuilt/corrupt) → `null` rather
 *   than throwing; we can't compare versions we can't read, and a probe run
 *   on every `ledger setup` invocation must never crash the whole command
 *   over this.
 * - Installed and current → `already`.
 * - Installed and older than the package version → `outdated`, with a
 *   `vOLD → vNEW` detail (the "rerun with --install-plugin" call-to-action is
 *   added by `report.ts`'s `outdated` renderer, not duplicated here).
 *
 * `resolveRoot` mirrors `installPlugin`'s injectable seam for the same
 * reason: tests need to exercise the not-resolvable / not-built guards
 * without a genuinely broken monorepo install.
 */
export function checkPluginFreshness(
  vault: string,
  resolveRoot: () => string | null = resolvePluginRoot,
): StepResult | null {
  const destManifest = join(vault, ".obsidian", "plugins", "vaultledger", "manifest.json");
  const installedVersion = readVersion(destManifest);
  if (installedVersion === null) return null; // not installed — don't nag

  const root = resolveRoot();
  if (root === null) return null; // package not resolvable — can't compare

  const pkgVersion = readVersion(join(root, "manifest.json"));
  if (pkgVersion === null) return null; // unbuilt/corrupt package manifest — can't compare

  if (installedVersion === pkgVersion) {
    return { step: "plugin", state: "already", detail: `plugin v${pkgVersion} current` };
  }
  return {
    step: "plugin",
    state: "outdated",
    detail: `v${installedVersion} → v${pkgVersion}`,
  };
}
