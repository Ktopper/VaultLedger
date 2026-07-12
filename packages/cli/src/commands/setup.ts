import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { configPath, readConfig } from "@vaultledger/core";
import { promptYesNo } from "../prompt.js";
import { renderReport } from "../setup/report.js";
import type { SetupDeps, SetupOptions, SetupSteps, StepResult } from "../setup/types.js";
import { initCommand } from "./init.js";

function renderResults(results: StepResult[], opts: SetupOptions, out: (s: string) => void): void {
  if (opts.json) {
    out(JSON.stringify(results));
  } else {
    out(renderReport(results));
  }
}

/**
 * `ledger setup <vault>` orchestrator: runs the interactive init step, then
 * hands off to the injected `SetupSteps` collaborators (mcp config, smoke
 * check, plugin install — the real implementations land in later WUs; WU-1
 * drives this with fakes). Returns the full StepResult sequence so callers
 * (and tests) can assert exactly what ran; a `failed` step anywhere in the
 * returned array signals overall failure (WU-5's `index.ts` wiring maps that
 * to a non-zero exit code).
 */
export async function setupCommand(
  vault: string,
  opts: SetupOptions,
  steps: SetupSteps,
  deps: SetupDeps = {},
): Promise<StepResult[]> {
  const out = deps.out ?? console.log;
  const vaultDir = resolve(vault);
  const results: StepResult[] = [];

  // init step: always scan+print via a dry-run initCommand first (mirrors
  // `ledger init`'s own dry-run UX), then decide already-vs-prompt from the
  // sentinel file, exactly as init.ts itself does before writing.
  await initCommand(vaultDir, { confirm: false, out });

  if (existsSync(configPath(vaultDir))) {
    results.push({ step: "init", state: "already", detail: "already initialized" });
  } else {
    const proceed =
      opts.yes || (await promptYesNo("Write this zone manifest?", { input: deps.promptInput, out }));
    if (!proceed) {
      results.push({ step: "init", state: "skipped", detail: "aborted — nothing written" });
      renderResults(results, opts, out);
      return results;
    }
    await initCommand(vaultDir, { confirm: true, out });
    const { vaultId } = readConfig(vaultDir);
    results.push({ step: "init", state: "created", detail: `Initialized vault ${vaultId}` });
  }

  // mcp step
  const { result: mcpResult, entry } = await steps.configureMcp(vaultDir, opts, out);
  results.push(mcpResult);
  if (mcpResult.state === "failed" || entry === null) {
    renderResults(results, opts, out);
    return results;
  }

  // smoke step
  const smokeResult = await steps.smoke(vaultDir, entry, deps.env);
  results.push(smokeResult);

  // plugin step
  if (opts.installPlugin) {
    const pluginResult = await steps.installPlugin(vaultDir);
    results.push(pluginResult);
  }

  renderResults(results, opts, out);
  return results;
}
