import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import * as YAML from "yaml";
import {
  DEFAULT_LEDGER_CONFIG,
  LedgerGit,
  configPath,
  mintVaultId,
  permissionsPath,
  scanVault,
  writeConfig,
  type PermissionsManifest,
  type VaultProfile,
} from "@vaultledger/core";

export interface InitOptions {
  confirm: boolean;
  now?: () => string;
  genId?: (prefix: string) => string;
  rand?: () => string;
  env?: NodeJS.ProcessEnv;
  out?: (s: string) => void;
}

export interface InitResult {
  created: boolean;
  profile: VaultProfile;
  manifest: PermissionsManifest;
}

function defaultRand(): string {
  return randomBytes(4).toString("hex");
}

function describeProfile(profile: VaultProfile, manifest: PermissionsManifest, out: (s: string) => void): void {
  out(`Vault: ${profile.root}`);
  out(`Notes: ${profile.noteCount}  Links: ${profile.linkCount}`);
  out(`Folders: ${profile.folders.join(", ") || "(none)"}`);
  out(
    `Detected: dailyNotes=${profile.detected.dailyNotes} templates=${profile.detected.templates} ` +
      `attachments=${profile.detected.attachments}`,
  );
  if (profile.detected.likelyProjects.length > 0) {
    out(`Likely projects: ${profile.detected.likelyProjects.join(", ")}`);
  }
  out(
    `Proposed zones: trusted=[${manifest.zones.trusted.join(",")}] agent=[${manifest.zones.agent.join(",")}] ` +
      `scratch=[${manifest.zones.scratch.join(",")}] excluded=[${manifest.zones.excluded.join(",")}]`,
  );
}

/**
 * Onboard a vault directory into VaultLedger. Read-only (no writes at all)
 * unless `opts.confirm` is true, in which case it writes ONLY inside
 * `.ledger/` (config.json, permissions.yaml) and `.git/` — user notes are
 * never touched. Idempotent: if `.ledger/config.json` already exists, does
 * NOT re-mint a vaultId or overwrite anything.
 */
export async function initCommand(vaultDir: string, opts: InitOptions): Promise<InitResult> {
  const out = opts.out ?? console.log;
  const { profile, proposedManifest } = scanVault(vaultDir);

  describeProfile(profile, proposedManifest, out);

  if (!opts.confirm) {
    return { created: false, profile, manifest: proposedManifest };
  }

  if (existsSync(configPath(vaultDir))) {
    out("already initialized");
    return { created: false, profile, manifest: proposedManifest };
  }

  const git = new LedgerGit(vaultDir);
  await git.init();

  const rand = opts.rand ?? defaultRand;
  const vaultId = mintVaultId(rand);
  writeConfig(vaultDir, { ...DEFAULT_LEDGER_CONFIG, vaultId });
  writeFileSync(permissionsPath(vaultDir), YAML.stringify(proposedManifest), "utf8");

  out(`Initialized vault ${vaultId}`);
  return { created: true, profile, manifest: proposedManifest };
}
