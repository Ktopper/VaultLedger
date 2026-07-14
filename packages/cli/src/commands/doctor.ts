import {
  readConfig,
  journalPath,
  permissionsPath,
  PermissionsManifest,
  probeGitRepo,
  probeJournal,
  findPrivateFolders,
  resolveZone,
  vaultLockDir,
  LOCK_CONFIG,
  type GitProbe,
  type JournalProbe,
} from "@vaultledger/core";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import YAML from "yaml";
import type { CheckResult } from "./doctorReport.js";
import { resolveMcpServerEntry } from "../setup/mcpConfig.js";
import { checkPluginFreshness } from "../setup/plugin.js";
import { isPidAlive } from "./pid.js";
import type { StepResult } from "../setup/types.js";

export interface DoctorOptions {
  json: boolean;
  strict: boolean;
}

export interface DoctorDeps {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
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

/**
 * Zone-integrity: assert every filesystem folder the human means to keep
 * Private actually resolves to the `excluded` zone under the CURRENT manifest,
 * plus the constant-guard that `.ledger/**` is hard-excluded (a regression
 * there would be a code bug, not a config one). Read-only: it only probes the
 * resolver with synthetic paths, never touching the vault.
 */
export function checkZoneIntegrity(vaultDir: string, manifest: PermissionsManifest): CheckResult {
  const privateFolders = findPrivateFolders(vaultDir);
  const violations: string[] = [];
  for (const p of privateFolders) {
    if (resolveZone(`${p}/__vaultledger_doctor_probe__.md`, manifest) !== "excluded") {
      violations.push(p);
    }
  }
  // Constant-guard: `.ledger/**` is hard-excluded BEFORE the manifest, so this
  // is always true; a violation here means a resolver regression — treat as fail.
  if (resolveZone(".ledger/__probe__.md", manifest) !== "excluded") {
    violations.push(".ledger/**");
  }
  if (violations.length > 0) {
    return {
      name: "zone-integrity",
      status: "fail",
      detail: `not excluded: ${violations.join(", ")}`,
      remediation: "re-run `ledger setup <vault>` or fix permissions.yaml so 'Private' folders are excluded",
    };
  }
  const n = privateFolders.length;
  return {
    name: "zone-integrity",
    status: "ok",
    detail:
      n > 0
        ? `${n} Private folder(s) all excluded; .ledger/** excluded`
        : "no Private folders present; .ledger/** excluded",
  };
}

export interface LockCheck {
  result: CheckResult;
  /** True while a writer is (apparently) holding a fresh lock — the journal
   * check cross-references this to distinguish "busy" from "corrupt". */
  live: boolean;
}

/**
 * Inspect the mutation lock's mtime WITHOUT acquiring it. Absent → no writer;
 * fresh (within LOCK_CONFIG.stale) → a writer holds it; older → a stale lock
 * left by a crashed writer.
 */
export function checkLock(vaultId: string, env: NodeJS.ProcessEnv, now: () => number): LockCheck {
  const lockPath = join(vaultLockDir(vaultId, env), "vault.lock");
  let mtimeMs: number;
  try {
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch {
    return { result: { name: "lock", status: "ok", detail: "no mutation lock held" }, live: false };
  }
  if (now() - mtimeMs <= LOCK_CONFIG.stale) {
    return {
      result: { name: "lock", status: "ok", detail: "a writer holds the mutation lock" },
      live: true,
    };
  }
  return {
    result: {
      name: "lock",
      status: "warn",
      detail: `stale mutation lock (older than ${LOCK_CONFIG.stale}ms) — likely a crashed writer`,
      remediation: `remove ${lockPath} if no ledger process is running`,
    },
    live: false,
  };
}

/** Pure: map a journal probe (+ whether a live writer holds the lock) to a
 * CheckResult. An `unreadable` probe is benign IF a writer is active (a torn
 * copy of a mid-transaction DB), but a real problem otherwise. */
export function mapJournalProbe(probe: JournalProbe, lockLive: boolean): CheckResult {
  switch (probe.status) {
    case "absent":
      return {
        name: "journal",
        status: "warn",
        detail: "journal not built yet",
        remediation: "run `ledger reindex`",
      };
    case "ok":
      return {
        name: "journal",
        status: "ok",
        detail: `${probe.count} memories indexed (run \`ledger reindex\` if you suspect drift)`,
      };
    case "unreadable":
      return lockLive
        ? {
            name: "journal",
            status: "info",
            detail: "journal busy — possibly held by an active writer",
          }
        : {
            name: "journal",
            status: "warn",
            detail: "journal present but unreadable",
            remediation: "run `ledger reindex` to rebuild it",
          };
  }
}

/** Read the bridge discovery file (never acquiring anything) and report
 * whether a live `ledger serve` is behind it. Parses defensively — a missing
 * or malformed file is simply "not running". */
function checkBridge(vaultId: string, env: NodeJS.ProcessEnv): CheckResult {
  const notRunning: CheckResult = {
    name: "bridge",
    status: "info",
    detail: "bridge not running — start it with `ledger serve`",
  };
  const bridgePath = join(vaultLockDir(vaultId, env), "bridge.json");
  let pid: number;
  let port: number;
  try {
    const parsed = JSON.parse(readFileSync(bridgePath, "utf8")) as {
      pid?: unknown;
      port?: unknown;
    };
    if (typeof parsed.pid !== "number" || typeof parsed.port !== "number") return notRunning;
    pid = parsed.pid;
    port = parsed.port;
  } catch {
    return notRunning;
  }
  if (isPidAlive(pid)) {
    return { name: "bridge", status: "ok", detail: `bridge running (port ${port}, pid ${pid})` };
  }
  return {
    name: "bridge",
    status: "warn",
    detail: `stale bridge.json — pid ${pid} not running`,
    remediation: "re-run `ledger serve`",
  };
}

/** Pure: map the plugin-freshness probe to a CheckResult. */
export function mapPluginFreshness(step: StepResult | null): CheckResult {
  if (step === null) {
    return {
      name: "plugin",
      status: "info",
      detail: "review plugin not installed (optional)",
      remediation: "`ledger setup --install-plugin` to add it",
    };
  }
  if (step.state === "already") {
    return { name: "plugin", status: "ok", detail: "review plugin installed and current" };
  }
  return {
    name: "plugin",
    status: "warn",
    detail: step.detail,
    remediation: "re-run `ledger setup --install-plugin`",
  };
}

export async function runDoctor(
  vaultDir: string,
  opts: DoctorOptions,
  deps: DoctorDeps,
): Promise<DoctorResult> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date().getTime());
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
  //    Parse the manifest ONCE here and thread it into zone-integrity below,
  //    so it isn't parsed twice. On parse failure the manifest stays null and
  //    zone-integrity is skipped (can't probe zones without a manifest).
  let manifest: PermissionsManifest | null = null;
  if (vaultId === null) {
    checks.push(skip("permissions"));
  } else {
    try {
      manifest = PermissionsManifest.parse(YAML.parse(readFileSync(permissionsPath(vaultDir), "utf8")));
      checks.push({ name: "permissions", status: "ok", detail: "permissions.yaml valid" });
    } catch (e) {
      checks.push({
        name: "permissions",
        status: "fail",
        detail: e instanceof Error ? e.message : String(e),
        remediation: `run \`ledger setup ${vaultDir}\``,
      });
    }
  }

  // 3. VAULT-INDEPENDENT checks: git, mcp, versions, sync-artifacts.
  //    These run unconditionally — they do NOT depend on an initialized vault.
  checks.push(await checkGit(vaultDir));
  checks.push(checkMcp());
  checks.push(checkVersions());
  checks.push(scanSyncArtifacts(vaultDir));

  // 4. VAULT-DEPENDENT checks: zone-integrity, journal, lock, bridge, plugin.
  //    Cascade-skipped when there's no initialized vault; zone-integrity is
  //    ADDITIONALLY skipped when the manifest failed to parse.
  if (vaultId === null) {
    checks.push(skip("zone-integrity"));
    checks.push(skip("journal"));
    checks.push(skip("lock"));
    checks.push(skip("bridge"));
    checks.push(skip("plugin"));
  } else {
    checks.push(manifest === null ? skip("zone-integrity") : checkZoneIntegrity(vaultDir, manifest));
    // Compute lock before journal so journal can cross-reference `live`.
    const lock = checkLock(vaultId, env, now);
    checks.push(mapJournalProbe(probeJournal(journalPath(vaultId, env)), lock.live));
    checks.push(lock.result);
    checks.push(checkBridge(vaultId, env));
    checks.push(mapPluginFreshness(checkPluginFreshness(vaultDir)));
  }

  const exitCode = deriveExitCode(checks, opts.strict);
  return { checks, exitCode };
}
