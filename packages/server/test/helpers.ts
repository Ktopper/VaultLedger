import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as YAML from "yaml";
import {
  DEFAULT_LEDGER_CONFIG,
  LedgerGit,
  PermissionsManifest,
  mintVaultId,
  openVault,
  permissionsPath,
  writeConfig,
  type OpenVaultDeps,
  type VaultContext,
} from "@vaultledger/core";

export interface TestVault {
  vaultDir: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

/** Build a minimal but real VaultLedger vault on disk + a temp HOME (so the
 * journal, kept under the OS app-support dir keyed by vaultId, never touches
 * the real ~/Library/Application Support/VaultLedger) — the same shape core's
 * own openVault.test.ts uses, reused here so the server's tests exercise a
 * genuine vault rather than a stub. `Private/**` is excluded, matching the
 * zone-check tests in Task 2.3. */
export async function makeTestVault(rand: () => string = () => "test1234"): Promise<TestVault> {
  const vaultDir = mkdtempSync(join(tmpdir(), "vl-server-vault-"));
  const homeDir = mkdtempSync(join(tmpdir(), "vl-server-home-"));

  mkdirSync(join(vaultDir, "Notes"), { recursive: true });
  writeFileSync(join(vaultDir, "Notes", "trusted.md"), "# Trusted note\n\nSome content.\n", "utf8");

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

  const git = new LedgerGit(vaultDir);
  await git.init();

  mkdirSync(join(vaultDir, ".ledger"), { recursive: true });
  writeFileSync(permissionsPath(vaultDir), YAML.stringify(manifest), "utf8");
  writeConfig(vaultDir, { ...DEFAULT_LEDGER_CONFIG, vaultId: mintVaultId(rand) });

  const env = { HOME: homeDir } as NodeJS.ProcessEnv;
  return {
    vaultDir,
    homeDir,
    env,
    cleanup: () => {
      rmSync(vaultDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

/** Deterministic clock + id generator for tests (never Date.now/Math.random
 * in src, and tests want reproducible ids/timestamps too). */
export function makeClock(): { now: () => string; genId: (prefix: string) => string } {
  let tick = 0;
  let counter = 0;
  return {
    now: () => {
      tick += 1;
      return new Date(2026, 0, 1, 0, 0, tick).toISOString();
    },
    genId: (prefix: string) => {
      counter += 1;
      return `${prefix}_${counter}`;
    },
  };
}

/** Open a real VaultContext over a test vault with the given deps. */
export async function openTestVault(vault: TestVault, deps: OpenVaultDeps = {}): Promise<VaultContext> {
  const clock = makeClock();
  return openVault(vault.vaultDir, {
    now: clock.now,
    genId: clock.genId,
    env: vault.env,
    session: "test-session",
    ...deps,
  });
}
