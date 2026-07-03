import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCommand } from "../src/commands/init.js";
import type { LoadContextDeps } from "../src/context.js";

export interface TestVault {
  vaultDir: string;
  homeDir: string;
  deps: LoadContextDeps;
  cleanup: () => void;
}

/** Create a temp vault dir + a temp HOME (so the journal, which lives under
 * the OS app-support dir keyed by vaultId, is isolated per test and never
 * touches the real ~/Library/Application Support/VaultLedger), initialize
 * the vault, and return everything a test needs to load its context. */
export async function makeInitializedVault(rand: () => string = () => "test1234"): Promise<TestVault> {
  const vaultDir = mkdtempSync(join(tmpdir(), "vl-vault-"));
  const homeDir = mkdtempSync(join(tmpdir(), "vl-home-"));
  await initCommand(vaultDir, { confirm: true, rand, out: () => {} });
  const deps: LoadContextDeps = { env: { HOME: homeDir } as NodeJS.ProcessEnv };
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
