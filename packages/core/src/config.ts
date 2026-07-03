import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BrokerError } from "./errors.js";

/** A vaultId is used as a directory name under app-support; keep it to a
 * traversal-safe character set so a tampered config.json can't escape via
 * path.join (e.g. "../../etc" or "vault/evil"). */
const VAULT_ID_RE = /^[A-Za-z0-9_-]+$/;

function assertValidVaultId(vaultId: string): void {
  if (!VAULT_ID_RE.test(vaultId)) {
    throw new BrokerError("FORBIDDEN_ZONE", `invalid vault id: ${JSON.stringify(vaultId)}`);
  }
}

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
  // Fall back to os.homedir() (an absolute path) rather than "" when the env
  // var is missing, so the journal location is never cwd-dependent/relative.
  if (platform === "darwin") {
    const home = env.HOME ?? homedir();
    return join(home, "Library", "Application Support", "VaultLedger");
  }
  if (platform === "win32") {
    const appData = env.APPDATA ?? join(env.HOME ?? homedir(), "AppData", "Roaming");
    return join(appData, "VaultLedger");
  }
  const xdg = env.XDG_DATA_HOME ?? join(env.HOME ?? homedir(), ".local", "share");
  return join(xdg, "VaultLedger");
}

/** Absolute path to the journal database for a given vaultId. */
export function journalPath(
  vaultId: string,
  env: EnvLike = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  assertValidVaultId(vaultId);
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
  try {
    return JSON.parse(raw) as LedgerConfig;
  } catch (e) {
    // Preserve the typed-rejection contract: a corrupted config.json must not
    // surface as a raw SyntaxError to callers that only handle BrokerError.
    throw new BrokerError(
      "NOT_FOUND",
      `config unreadable at ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Write `.ledger/config.json`, creating the `.ledger/` directory if needed.
 * The write is atomic: content goes to a temp file first, then renameSync
 * swaps it into place, so a crash mid-write can never leave a truncated
 * config.json (a rename is atomic on the same filesystem).
 */
export function writeConfig(vaultRoot: string, config: LedgerConfig): void {
  const path = configPath(vaultRoot);
  const dir = join(vaultRoot, ".ledger");
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.config.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}
