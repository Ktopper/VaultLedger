import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import * as YAML from "yaml";
import {
  DEFAULT_LEDGER_CONFIG,
  LedgerGit,
  PermissionsManifest,
  journalPath,
  mintVaultId,
  permissionsPath,
  writeConfig,
} from "@vaultledger/core";
import { resolveMcpServerEntry } from "../../src/setup/mcpConfig.js";
import { smokeCheck } from "../../src/setup/smoke.js";

/**
 * Real end-to-end proof that `smokeCheck` drives the ACTUAL emitted server
 * command (the same `node <entry> --vault <vault> --no-sweep` that
 * `buildMcpConfig` would write into `.mcp.json`), over real stdio, via the
 * real MCP SDK client — not a mock. Requires `pnpm -C packages/mcp-server
 * build` to have produced `dist/index.js`.
 */
let vaultDir: string;
let homeDir: string;

afterEach(() => {
  if (vaultDir) rmSync(vaultDir, { recursive: true, force: true });
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
});

async function makeSmokeVault(): Promise<{ vaultDir: string; vaultId: string }> {
  const dir = mkdtempSync(join(tmpdir(), "vl-smoke-vault-"));
  const manifest = PermissionsManifest.parse({
    mode: "assisted",
    zones: {
      trusted: ["**"],
      agent: ["Agent/**"],
      scratch: ["Agent/Scratch/**"],
      excluded: ["Private/**"],
    },
    overrides: [],
  });
  const git = new LedgerGit(dir);
  await git.init();
  mkdirSync(join(dir, ".ledger"), { recursive: true });
  writeFileSync(permissionsPath(dir), YAML.stringify(manifest), "utf8");
  const vaultId = mintVaultId(() => "smoketest1");
  writeConfig(dir, { ...DEFAULT_LEDGER_CONFIG, vaultId });
  return { vaultDir: dir, vaultId };
}

const entry = resolveMcpServerEntry();
const distBuilt = entry !== null;

describe.skipIf(!distBuilt)("smokeCheck (real subprocess, real MCP client)", () => {
  test(
    "a good entry verifies over the temp-HOME-isolated journal",
    async () => {
      const seeded = await makeSmokeVault();
      vaultDir = seeded.vaultDir;
      homeDir = mkdtempSync(join(tmpdir(), "vl-smoke-home-"));
      const env = { ...process.env, HOME: homeDir };

      const dbPath = journalPath(seeded.vaultId, env);
      expect(existsSync(dirname(dbPath))).toBe(false);

      const result = await smokeCheck(vaultDir, entry!, env);

      expect(result.step).toBe("smoke");
      expect(result.state).toBe("verified");
      expect(result.detail).toMatch(/\d+ zone globs, journal healthy, \d+ pending/);

      // Proves the child actually opened the TEMP-HOME journal, not the real
      // developer app-support dir: the app-support directory for this
      // vaultId now exists under the temp HOME.
      expect(existsSync(dirname(dbPath))).toBe(true);
    },
    20_000,
  );

  test(
    "a bad entry fails with a detail naming the entry path",
    async () => {
      vaultDir = mkdtempSync(join(tmpdir(), "vl-smoke-vault-bad-"));
      homeDir = mkdtempSync(join(tmpdir(), "vl-smoke-home-bad-"));
      const env = { ...process.env, HOME: homeDir };
      const badEntry = "/nonexistent/index.js";

      const result = await smokeCheck(vaultDir, badEntry, env);

      expect(result.step).toBe("smoke");
      expect(result.state).toBe("failed");
      expect(result.detail).toContain(badEntry);
    },
    20_000,
  );
});

test.skipIf(distBuilt)("smoke test skipped: mcp-server dist not built (run `pnpm build` first)", () => {
  expect(distBuilt).toBe(false);
});
