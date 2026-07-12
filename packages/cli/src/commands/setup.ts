import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { configPath, readConfig } from "@vaultledger/core";
import { buildMcpConfig, mergeMcpConfig, resolveMcpServerEntry, writeMcpConfig } from "../setup/mcpConfig.js";
import { installPlugin } from "../setup/plugin.js";
import { promptYesNo } from "../prompt.js";
import { renderReport } from "../setup/report.js";
import { smokeCheck } from "../setup/smoke.js";
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
  const env = deps.env ?? process.env;
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
  const smokeResult = await steps.smoke(vaultDir, entry, env);
  results.push(smokeResult);

  // plugin step
  if (opts.installPlugin) {
    const pluginResult = await steps.installPlugin(vaultDir);
    results.push(pluginResult);
  }

  renderResults(results, opts, out);
  return results;
}

/** Human-facing block for the print-by-default MCP step: a one-line pointer
 * plus the pretty-printed config JSON the user pastes into their Claude Code
 * `.mcp.json`. Pulled out of `defaultSteps` so both the print-by-default path
 * and the `--write-mcp`-refused-to-merge path (which also prints the block as
 * a fallback) render identically. */
export function printableBlock(vault: string, entry: string): string {
  const config = buildMcpConfig(vault, entry);
  return [
    "Paste this into your Claude Code MCP config (.mcp.json):",
    "",
    JSON.stringify(config, null, 2),
  ].join("\n");
}

/**
 * The real (non-fake) `SetupSteps` used by `ledger setup` in production:
 * resolves the built mcp-server entry, prints-or-writes the MCP config,
 * forwards to the real `smokeCheck`/`installPlugin`. WU-1..4 built the
 * underlying units; this is the glue `setupCommand` was built against fakes
 * for.
 */
export function defaultSteps(): SetupSteps {
  return {
    async configureMcp(vault, opts, out) {
      const entry = resolveMcpServerEntry();
      if (!entry) {
        return {
          entry: null,
          result: { step: "mcp", state: "failed", detail: "mcp-server not built — run: pnpm bootstrap" },
        };
      }
      if (opts.writeMcp) {
        const existing = existsSync(opts.writeMcp) ? readFileSync(opts.writeMcp, "utf8") : null;
        const merged = mergeMcpConfig(existing, vault, entry);
        if (!merged.ok) {
          out(printableBlock(vault, entry));
          const reason =
            merged.reason === "unparseable"
              ? "is not valid JSON (unparseable)"
              : "does not contain a top-level JSON object (not-an-object)";
          return {
            entry,
            result: {
              step: "mcp",
              state: "failed",
              detail: `${opts.writeMcp} ${reason} — pasted block above, merge manually`,
            },
          };
        }
        writeMcpConfig(opts.writeMcp, merged.text);
        return { entry, result: { step: "mcp", state: merged.state, detail: `${merged.state} ${opts.writeMcp}` } };
      }
      out(printableBlock(vault, entry)); // print-by-default
      return {
        entry,
        result: { step: "mcp", state: "created", detail: "printed config block (use --write-mcp <path> to write)" },
      };
    },
    smoke: (vault, entry, env) => smokeCheck(vault, entry, env), // forward the env seam
    installPlugin,
  };
}
