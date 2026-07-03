import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrokerError } from "./errors.js";

/**
 * VaultLedger's only in-vault footprint is `.ledger/` (design §3.1).
 * `.ledger/config.json` holds a generated vaultId + this config. The SQLite
 * journal itself lives OUTSIDE the vault, in the OS app-support dir, in a
 * subdirectory keyed by vaultId (see `journalPath`) — never a path hash, so
 * the vault can move/rename on disk without losing its journal.
 */
export interface LedgerConfig {
  vaultId: string;
  ttlDays: number;
  patchThreshold: number;
  mode: "safe" | "assisted" | "autonomous";
  stalenessDays: number;
}

export const DEFAULT_LEDGER_CONFIG: Omit<LedgerConfig, "vaultId"> = {
  ttlDays: 14,
  patchThreshold: 0.5,
  mode: "assisted",
  stalenessDays: 30,
};

/**
 * Mint a new vault id, e.g. `vault_<rand()>`. `rand` is injected (never
 * Math.random directly) so callers can pass a crypto-random hex generator in
 * production and a deterministic stub in tests.
 */
export function mintVaultId(rand: () => string): string {
  return `vault_${rand()}`;
}

type EnvLike = Record<string, string | undefined>;

/**
 * Resolve the OS app-support base directory VaultLedger stores its journals
 * under. Takes env + platform as parameters (rather than reading
 * process.env/process.platform directly) so this is testable across all
 * three branches from a single process.
 */
export function appSupportBase(
  env: EnvLike = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "darwin") {
    const home = env.HOME ?? "";
    return join(home, "Library", "Application Support", "VaultLedger");
  }
  if (platform === "win32") {
    const appData = env.APPDATA ?? join(env.HOME ?? "", "AppData", "Roaming");
    return join(appData, "VaultLedger");
  }
  const xdg = env.XDG_DATA_HOME ?? join(env.HOME ?? "", ".local", "share");
  return join(xdg, "VaultLedger");
}

/** Absolute path to the journal database for a given vaultId. */
export function journalPath(
  vaultId: string,
  env: EnvLike = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(appSupportBase(env, platform), vaultId, "journal.db");
}

/** Absolute path to `.ledger/config.json` under a vault root. */
export function configPath(vaultRoot: string): string {
  return join(vaultRoot, ".ledger", "config.json");
}

/** Absolute path to `.ledger/permissions.yaml` under a vault root. */
export function permissionsPath(vaultRoot: string): string {
  return join(vaultRoot, ".ledger", "permissions.yaml");
}

/** Read and parse `.ledger/config.json`. Throws NOT_FOUND if absent. */
export function readConfig(vaultRoot: string): LedgerConfig {
  const path = configPath(vaultRoot);
  if (!existsSync(path)) {
    throw new BrokerError("NOT_FOUND", `no config found at ${path}`);
  }
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as LedgerConfig;
}

/** Write `.ledger/config.json`, creating the `.ledger/` directory if needed. */
export function writeConfig(vaultRoot: string, config: LedgerConfig): void {
  const path = configPath(vaultRoot);
  mkdirSync(join(vaultRoot, ".ledger"), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}
