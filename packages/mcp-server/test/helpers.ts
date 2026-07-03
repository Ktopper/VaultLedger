import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as YAML from "yaml";
import {
  DEFAULT_LEDGER_CONFIG,
  LedgerGit,
  PermissionsManifest,
  mintVaultId,
  permissionsPath,
  writeConfig,
} from "@vaultledger/core";
import type { LoadServerContextDeps } from "../src/context.js";

export interface TestVault {
  vaultDir: string;
  homeDir: string;
  deps: LoadServerContextDeps;
  cleanup: () => void;
}

/**
 * Build a minimal but real VaultLedger vault on disk: a trusted note (used by
 * the vault_propose_edit happy-path test), an excluded note (used by the
 * vault_propose_edit FORBIDDEN_ZONE test), a manifest with all four zones,
 * `.ledger/config.json`, and an initialized git repo. Also mints a temp HOME
 * so the journal (which lives under the OS app-support dir keyed by vaultId)
 * is isolated per test and never touches the real app-support dir.
 */
export async function makeTestVault(opts?: { rand?: () => string }): Promise<TestVault> {
  const vaultDir = mkdtempSync(join(tmpdir(), "vl-mcp-vault-"));
  const homeDir = mkdtempSync(join(tmpdir(), "vl-mcp-home-"));

  mkdirSync(join(vaultDir, "Notes"), { recursive: true });
  writeFileSync(join(vaultDir, "Notes", "trusted.md"), "# Trusted note\n\nSome content.\n", "utf8");
  mkdirSync(join(vaultDir, "Private"), { recursive: true });
  writeFileSync(join(vaultDir, "Private", "secret.md"), "# secret\n", "utf8");

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
  const rand = opts?.rand ?? (() => "test1234");
  writeConfig(vaultDir, { ...DEFAULT_LEDGER_CONFIG, vaultId: mintVaultId(rand) });

  const deps: LoadServerContextDeps = { env: { HOME: homeDir } as NodeJS.ProcessEnv };
  return {
    vaultDir,
    homeDir,
    deps,
    cleanup: () => {
      rmSync(vaultDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    },
  };
}
