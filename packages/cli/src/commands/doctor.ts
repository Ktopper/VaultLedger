import {
  readConfig,
  journalPath,
  permissionsPath,
  PermissionsManifest,
  probeGitRepo,
  type GitProbe,
} from "@vaultledger/core";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import YAML from "yaml";
import type { CheckResult } from "./doctorReport.js";
import { resolveMcpServerEntry } from "../setup/mcpConfig.js";

export interface DoctorOptions {
  json: boolean;
  strict: boolean;
}

export interface DoctorDeps {
  env?: NodeJS.ProcessEnv;
}

export interface DoctorResult {
  checks: CheckResult[];
  exitCode: number;
}

/**
 * Exit 1 if any check `fail`s, or (when `strict`) any check `warn`s; else 0.
 */
export function deriveExitCode(checks: CheckResult[], strict: boolean): number {
  const bad = checks.some((c) => c.status === "fail" || (strict && c.status === "warn"));
  return bad ? 1 : 0;
}

/** Validate `.ledger/permissions.yaml` against the manifest schema. */
function checkPermissions(vaultDir: string): CheckResult {
  try {
    const raw = readFileSync(permissionsPath(vaultDir), "utf8");
    PermissionsManifest.parse(YAML.parse(raw));
    return { name: "permissions", status: "ok", detail: "permissions.yaml valid" };
  } catch (e) {
    return {
      name: "permissions",
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
      remediation: `run \`ledger setup ${vaultDir}\``,
    };
  }
}

/** Pure: map a git probe to a doctor CheckResult. */
export function mapGitProbe(p: GitProbe): CheckResult {
  if (!p.gitWorks) {
    return {
      name: "git",
      status: "fail",
      detail: "git isn't working (binary missing or PATH broken)",
      remediation: "install git / check your PATH",
    };
  }
  if (!p.isRepo) {
    return {
      name: "git",
      status: "fail",
      detail: "not a git repo — `ledger undo` rollback needs one",
      remediation: "run `ledger setup <vaultDir>` (runs git init)",
    };
  }
  if (p.head === null) {
    return { name: "git", status: "ok", detail: "git repo present, no commits yet" };
  }
  return { name: "git", status: "ok", detail: `git repo present, HEAD ${p.head.slice(0, 7)}` };
}

/** Read-only git health check. */
async function checkGit(vaultDir: string): Promise<CheckResult> {
  return mapGitProbe(await probeGitRepo(vaultDir));
}

/** Pure: map an mcp-server entry resolution to a doctor CheckResult. */
export function mapMcpProbe(entry: string | null): CheckResult {
  if (entry === null) {
    return {
      name: "mcp",
      status: "fail",
      detail: "@vaultledger/mcp-server is not resolvable — the cli install itself looks broken",
      remediation: "reinstall `@vaultledger/cli`, or from a source clone run `pnpm bootstrap`",
    };
  }
  return {
    name: "mcp",
    status: "ok",
    detail: "mcp-server entry resolves; an `.mcp.json` using the npx server form doesn't depend on this",
  };
}

function checkMcp(): CheckResult {
  return mapMcpProbe(resolveMcpServerEntry());
}

/** Pure: compare cli vs mcp-server versions (skew is a warning). */
export function compareVersions(input: {
  cliVersion: string;
  mcpVersion: string;
  nodeVersion: string;
}): CheckResult {
  const { cliVersion, mcpVersion, nodeVersion } = input;
  if (cliVersion !== mcpVersion) {
    return {
      name: "versions",
      status: "warn",
      detail: `cli v${cliVersion} vs mcp-server v${mcpVersion} — version skew`,
      remediation: "reinstall so cli and mcp-server match",
    };
  }
  return {
    name: "versions",
    status: "info",
    detail: `cli v${cliVersion}, mcp-server v${mcpVersion}, node ${nodeVersion}`,
  };
}

/**
 * Read the cli's own version and the mcp-server's version, then compare.
 * NOTE: the mcp-server version is resolved by walking up from the resolved
 * bare entry — NOT `require.resolve("@vaultledger/mcp-server/package.json")`,
 * which throws ERR_PACKAGE_PATH_NOT_EXPORTED (no `./package.json` exports entry).
 */
function checkVersions(): CheckResult {
  const require = createRequire(import.meta.url);
  const cliVersion = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ).version as string;
  // dist/index.js → dist → package root
  const mcpPkg = join(dirname(require.resolve("@vaultledger/mcp-server")), "..", "package.json");
  const mcpVersion = JSON.parse(readFileSync(mcpPkg, "utf8")).version as string;
  return compareVersions({ cliVersion, mcpVersion, nodeVersion: process.version });
}

const SYNC_DUP_RE = / [0-9]+(\.|$)/;

/** Collect basenames matching the cloud-sync-duplicate pattern. When
 * `recursive`, descend into subdirectories (used for `.git/refs/`). Missing
 * dirs are silently skipped. Read-only. */
function collectSyncDups(dir: string, relBase: string, recursive: boolean, hits: string[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    if (SYNC_DUP_RE.test(e.name)) hits.push(rel);
    if (recursive && e.isDirectory()) {
      collectSyncDups(join(dir, e.name), rel, recursive, hits);
    }
  }
}

/**
 * Read-only scan for cloud-sync duplicate artifacts (e.g. `config 2.json`).
 * Scoped STRICTLY to `.ledger/` (top level) and `.git/refs/` (recursive) —
 * never the note space, where names like `Page 2.md` are legitimate.
 */
export function scanSyncArtifacts(vaultDir: string): CheckResult {
  const hits: string[] = [];
  collectSyncDups(join(vaultDir, ".ledger"), ".ledger", false, hits);
  collectSyncDups(join(vaultDir, ".git", "refs"), ".git/refs", true, hits);
  if (hits.length > 0) {
    return {
      name: "sync-artifacts",
      status: "warn",
      detail: `possible cloud-sync duplicates: ${hits.join(", ")}`,
      remediation:
        "looks like cloud-sync duplicates — review and remove them (a duplicated git ref can break `ledger undo`)",
    };
  }
  return {
    name: "sync-artifacts",
    status: "ok",
    detail: "no cloud-sync duplicate artifacts found",
  };
}

export async function runDoctor(
  vaultDir: string,
  opts: DoctorOptions,
  deps: DoctorDeps,
): Promise<DoctorResult> {
  const env = deps.env ?? process.env;
  const checks: CheckResult[] = [];

  // 1. config gate — resolve vaultId; its failure drives the cascade.
  let vaultId: string | null = null;
  try {
    const cfg = readConfig(vaultDir);
    journalPath(cfg.vaultId, env); // validates the id (throws on a bad id)
    vaultId = cfg.vaultId;
    checks.push({ name: "config", status: "ok", detail: `valid (${cfg.vaultId})` });
  } catch (e) {
    checks.push({
      name: "config",
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
      remediation: `run \`ledger setup ${vaultDir}\``,
    });
  }

  const skip = (name: string): CheckResult => ({
    name,
    status: "skipped",
    detail: "no initialized vault — run `ledger setup` first",
  });

  // 2. permissions (vault-dependent → cascade-skipped when config failed).
  checks.push(vaultId === null ? skip("permissions") : checkPermissions(vaultDir));

  // 3. Task 6 insertion point — VAULT-INDEPENDENT checks: git, mcp, versions, sync-artifacts.
  //    These run unconditionally — they do NOT depend on an initialized vault.
  checks.push(await checkGit(vaultDir));
  checks.push(checkMcp());
  checks.push(checkVersions());
  checks.push(scanSyncArtifacts(vaultDir));

  // 4. Task 7 insertion point — VAULT-DEPENDENT checks: zone-integrity, journal, lock, bridge, plugin.
  //    INTERIM — replace in Task 7: a journal placeholder so this task's tests pass.
  checks.push(
    vaultId === null
      ? skip("journal")
      : { name: "journal", status: "skipped", detail: "(placeholder — implemented in Task 7)" },
  );

  const exitCode = deriveExitCode(checks, opts.strict);
  return { checks, exitCode };
}
