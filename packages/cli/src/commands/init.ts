import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import * as YAML from "yaml";
import {
  DEFAULT_LEDGER_CONFIG,
  LedgerGit,
  configPath,
  mintVaultId,
  permissionsPath,
  readConfig,
  scanVault,
  writeConfig,
  type PermissionsManifest,
  type VaultProfile,
} from "@vault-ledger/core";

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

function writePermissions(vaultDir: string, manifest: PermissionsManifest): void {
  const path = permissionsPath(vaultDir);
  // Ensure `.ledger/` exists: since permissions.yaml is now written BEFORE
  // config.json (whose writeConfig used to create the dir), nothing else has
  // made `.ledger/` yet on a fresh init.
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, YAML.stringify(manifest), "utf8");
}

/**
 * Onboard a vault directory into VaultLedger. Read-only (no writes at all)
 * unless `opts.confirm` is true, in which case it writes ONLY inside
 * `.ledger/` (permissions.yaml, config.json) and `.git/` — user notes are
 * never touched. Idempotent: if `.ledger/config.json` already exists, does
 * NOT re-mint a vaultId.
 *
 * Write ordering is deliberate: permissions.yaml FIRST, config.json LAST, so
 * that the config.json sentinel (which every later `init` short-circuits on)
 * can only exist once permissions.yaml already does. A crash between the two
 * writes leaves config.json absent — a subsequent init re-runs cleanly. And
 * if config.json somehow exists WITHOUT permissions.yaml (older layout, or a
 * deleted permissions file), init repairs it by rewriting permissions.yaml
 * from the scan without touching the existing vaultId.
 */
export async function initCommand(vaultDir: string, opts: InitOptions): Promise<InitResult> {
  const out = opts.out ?? console.log;
  const { profile, proposedManifest } = scanVault(vaultDir);

  describeProfile(profile, proposedManifest, out);

  // Disclose the one in-vault footprint the zone manifest doesn't cover: if the
  // vault isn't already a Git repo, init will create `.git/`. For a product
  // whose whole pitch is "nothing happens to your vault without you knowing,"
  // the tool must say this itself (before the confirm prompt), not only the docs.
  if (!existsSync(join(vaultDir, ".git"))) {
    out("Git: not a repository yet — setup will run `git init` here (this is what powers `ledger undo` rollback).");
  }

  if (!opts.confirm) {
    return { created: false, profile, manifest: proposedManifest };
  }

  // TOCTOU note: this existsSync → later write is a check-then-act race, but
  // VaultLedger is single-user-local in v0.1 so a concurrent initializer
  // racing this process is an accepted (non-)risk.
  if (existsSync(configPath(vaultDir))) {
    // Already initialized — but a missing permissions.yaml means a
    // half-initialized (or partially-deleted) vault. Repair it in place from
    // the scan, preserving the existing vaultId (never re-mint).
    if (!existsSync(permissionsPath(vaultDir))) {
      writePermissions(vaultDir, proposedManifest);
      const existing = readConfig(vaultDir);
      out(`repaired permissions.yaml for vault ${existing.vaultId}`);
      return { created: false, profile, manifest: proposedManifest };
    }
    out("already initialized");
    return { created: false, profile, manifest: proposedManifest };
  }

  const git = new LedgerGit(vaultDir);
  await git.init();

  const rand = opts.rand ?? defaultRand;
  const vaultId = mintVaultId(rand);
  // permissions.yaml FIRST, config.json LAST (see the write-ordering note above).
  writePermissions(vaultDir, proposedManifest);
  writeConfig(vaultDir, { ...DEFAULT_LEDGER_CONFIG, vaultId });

  out(`Initialized vault ${vaultId}`);
  return { created: true, profile, manifest: proposedManifest };
}
