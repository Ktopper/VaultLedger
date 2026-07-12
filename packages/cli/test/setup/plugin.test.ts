import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { installPlugin, resolvePluginRoot } from "../../src/setup/plugin.js";

/**
 * `installPlugin` copies the REAL built `@vaultledger/obsidian-plugin`
 * bundle for the "created" happy path (no faking that part — the plugin
 * must actually be built via `pnpm -C packages/obsidian-plugin build`
 * before this suite runs). The not-built / not-found / styles-optional
 * guards are exercised through the injectable `resolveRoot` seam against
 * temp fixture directories, since the real package IS built and resolvable
 * in this repo and can't be used to exercise "missing" states.
 */

let vaultDir: string;
let fixtureDir: string;

afterEach(() => {
  if (vaultDir) rmSync(vaultDir, { recursive: true, force: true });
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  vaultDir = "";
  fixtureDir = "";
});

function destDir(vault: string): string {
  return join(vault, ".obsidian", "plugins", "vaultledger");
}

describe("installPlugin — real built plugin (happy path)", () => {
  test("first install: state created, files copied, detail tells the user to enable it", async () => {
    vaultDir = mkdtempSync(join(tmpdir(), "vl-plugin-vault-"));
    const result = await installPlugin(vaultDir);

    expect(result.step).toBe("plugin");
    expect(result.state).toBe("created");
    expect(result.detail).toContain("Enable it");
    expect(result.detail).toContain("Community plugins");

    const dest = destDir(vaultDir);
    expect(existsSync(join(dest, "manifest.json"))).toBe(true);
    expect(existsSync(join(dest, "main.js"))).toBe(true);
  });

  test("second install with same version: state already", async () => {
    vaultDir = mkdtempSync(join(tmpdir(), "vl-plugin-vault-"));
    await installPlugin(vaultDir);
    const result = await installPlugin(vaultDir);

    expect(result.state).toBe("already");
    expect(result.detail).toContain("already current");
  });

  test("stale installed version: state updated, detail shows old -> new", async () => {
    vaultDir = mkdtempSync(join(tmpdir(), "vl-plugin-vault-"));
    await installPlugin(vaultDir);

    // Hand-edit the installed manifest to simulate an older installed version.
    const destManifest = join(destDir(vaultDir), "manifest.json");
    const manifest = JSON.parse(readFileSync(destManifest, "utf8"));
    const realVersion = manifest.version as string;
    manifest.version = "0.0.1";
    writeFileSync(destManifest, JSON.stringify(manifest, null, 2));

    const result = await installPlugin(vaultDir);
    expect(result.state).toBe("updated");
    expect(result.detail).toContain("0.0.1");
    expect(result.detail).toContain(realVersion);

    // The copy actually happened: dest manifest is back to the real version.
    const after = JSON.parse(readFileSync(destManifest, "utf8"));
    expect(after.version).toBe(realVersion);
  });

  test("resolvePluginRoot resolves the real package root (not dist/)", () => {
    const root = resolvePluginRoot();
    expect(root).not.toBeNull();
    if (root === null) return;
    expect(existsSync(join(root, "manifest.json"))).toBe(true);
    expect(existsSync(join(root, "main.js"))).toBe(true);
    expect(dirname(root)).not.toMatch(/dist$/);
  });
});

describe("installPlugin — guards via injectable resolveRoot", () => {
  test("package not found: resolveRoot returns null -> state failed", async () => {
    vaultDir = mkdtempSync(join(tmpdir(), "vl-plugin-vault-"));
    const result = await installPlugin(vaultDir, () => null);

    expect(result.state).toBe("failed");
    expect(result.detail).toContain("not found");
    expect(existsSync(destDir(vaultDir))).toBe(false);
  });

  test("not built: main.js missing at the resolved root -> state failed, never a half-install", async () => {
    vaultDir = mkdtempSync(join(tmpdir(), "vl-plugin-vault-"));
    fixtureDir = mkdtempSync(join(tmpdir(), "vl-plugin-fixture-"));
    writeFileSync(join(fixtureDir, "manifest.json"), JSON.stringify({ version: "1.0.0" }));
    // No main.js written.

    const result = await installPlugin(vaultDir, () => fixtureDir);

    expect(result.state).toBe("failed");
    expect(result.detail).toContain("pnpm -C packages/obsidian-plugin build");
    expect(existsSync(destDir(vaultDir))).toBe(false);
  });

  test("styles.css copied only when present at the plugin root", async () => {
    vaultDir = mkdtempSync(join(tmpdir(), "vl-plugin-vault-"));
    fixtureDir = mkdtempSync(join(tmpdir(), "vl-plugin-fixture-"));
    writeFileSync(join(fixtureDir, "manifest.json"), JSON.stringify({ version: "1.0.0" }));
    writeFileSync(join(fixtureDir, "main.js"), "// fake bundle");
    writeFileSync(join(fixtureDir, "styles.css"), "/* fake styles */");

    const result = await installPlugin(vaultDir, () => fixtureDir);

    expect(result.state).toBe("created");
    expect(existsSync(join(destDir(vaultDir), "styles.css"))).toBe(true);
  });

  test("styles.css absent at plugin root: no styles.css copied (matches real package today)", async () => {
    vaultDir = mkdtempSync(join(tmpdir(), "vl-plugin-vault-"));
    fixtureDir = mkdtempSync(join(tmpdir(), "vl-plugin-fixture-"));
    writeFileSync(join(fixtureDir, "manifest.json"), JSON.stringify({ version: "1.0.0" }));
    writeFileSync(join(fixtureDir, "main.js"), "// fake bundle");

    const result = await installPlugin(vaultDir, () => fixtureDir);

    expect(result.state).toBe("created");
    expect(existsSync(join(destDir(vaultDir), "styles.css"))).toBe(false);
  });

  test("malformed source manifest: failed, does not throw", async () => {
    vaultDir = mkdtempSync(join(tmpdir(), "vl-plugin-vault-"));
    fixtureDir = mkdtempSync(join(tmpdir(), "vl-plugin-fixture-"));
    writeFileSync(join(fixtureDir, "manifest.json"), "{ not valid json");
    writeFileSync(join(fixtureDir, "main.js"), "// fake bundle");

    const result = await installPlugin(vaultDir, () => fixtureDir);

    expect(result.state).toBe("failed");
    expect(existsSync(destDir(vaultDir))).toBe(false);
  });
});
