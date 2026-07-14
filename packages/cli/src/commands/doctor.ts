import { readConfig, journalPath, permissionsPath, PermissionsManifest } from "@vaultledger/core";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import type { CheckResult } from "./doctorReport.js";

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
