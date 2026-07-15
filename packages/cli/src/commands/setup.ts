import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { configPath, readConfig } from "@vault-ledger/core";
import {
  buildMcpConfig,
  isEphemeralEntry,
  mergeMcpConfig,
  resolveMcpServerEntry,
  writeMcpConfig,
} from "../setup/mcpConfig.js";
import { checkPluginFreshness, installPlugin } from "../setup/plugin.js";
import { promptYesNo } from "../prompt.js";
import { renderReport } from "../setup/report.js";
import { smokeCheck } from "../setup/smoke.js";
import type { SetupDeps, SetupOptions, SetupSteps, StepResult } from "../setup/types.js";
import { initCommand } from "./init.js";

function renderResults(
  results: StepResult[],
  opts: SetupOptions,
  humanOut: (s: string) => void,
  jsonOut: (s: string) => void,
): void {
  if (opts.json) {
    jsonOut(JSON.stringify(results));
  } else {
    humanOut(renderReport(results));
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
 *
 * `--json` output must be PURE JSON on stdout (so `ledger setup --json | jq`
 * works): every human-facing line (the init scan/profile print, the
 * printable MCP block, the rendered report) is routed to `humanOut` — which
 * in json mode writes to stderr instead of the injected `deps.out` sink —
 * while only the final `JSON.stringify(results)` goes through `jsonOut`
 * (`deps.out ?? console.log`, same seam tests have always used). In non-json
 * mode both sinks collapse back to the single `deps.out ?? console.log`
 * behavior this always had.
 */
export async function setupCommand(
  vault: string,
  opts: SetupOptions,
  steps: SetupSteps,
  deps: SetupDeps = {},
): Promise<StepResult[]> {
  const jsonOut = deps.out ?? console.log;
  const humanOut = opts.json ? (s: string) => process.stderr.write(s + "\n") : (deps.out ?? console.log);
  const env = deps.env ?? process.env;
  const vaultDir = resolve(vault);
  const results: StepResult[] = [];

  // init step: always scan+print via a dry-run initCommand first (mirrors
  // `ledger init`'s own dry-run UX), then decide already-vs-prompt from the
  // sentinel file, exactly as init.ts itself does before writing.
  await initCommand(vaultDir, { confirm: false, out: humanOut });

  if (existsSync(configPath(vaultDir))) {
    results.push({ step: "init", state: "already", detail: "already initialized" });
  } else {
    const proceed =
      opts.yes || (await promptYesNo("Write this zone manifest?", { input: deps.promptInput, out: humanOut }));
    if (!proceed) {
      results.push({ step: "init", state: "skipped", detail: "aborted — nothing written" });
      renderResults(results, opts, humanOut, jsonOut);
      return results;
    }
    // Silent: the profile was already shown by the confirm:false scan above
    // — reprinting it here would double-print on every fresh `--yes` run.
    await initCommand(vaultDir, { confirm: true, out: () => {} });
    const { vaultId } = readConfig(vaultDir);
    results.push({ step: "init", state: "created", detail: `Initialized vault ${vaultId}` });
  }

  // mcp step
  const { result: mcpResult, entry } = await steps.configureMcp(vaultDir, opts, humanOut);
  results.push(mcpResult);
  if (mcpResult.state === "failed" || entry === null) {
    renderResults(results, opts, humanOut, jsonOut);
    return results;
  }

  // smoke step
  const smokeResult = await steps.smoke(vaultDir, entry, env);
  results.push(smokeResult);

  // plugin step: --install-plugin actually installs/updates; otherwise this
  // is a read-only diagnostic probe that only reports something when the
  // plugin is ALREADY installed (never nags a user who never opted in).
  if (opts.installPlugin) {
    const pluginResult = await steps.installPlugin(vaultDir);
    results.push(pluginResult);
  } else {
    const freshness = checkPluginFreshness(vaultDir);
    if (freshness) results.push(freshness);
  }

  renderResults(results, opts, humanOut, jsonOut);
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
      if (isEphemeralEntry(entry)) {
        // Disclosure: the emitted block deliberately differs from the resolved
        // path. Placed here — not in printableBlock — because the --write-mcp
        // success path never calls printableBlock, and that's the path the
        // Claude Code guide recommends.
        out("· emitted the npx form — this run resolved from an ephemeral npx/dlx cache path that can be pruned");
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
        if (merged.state === "already") {
          // True no-op: skip the rewrite entirely so mtime is untouched —
          // an idempotent re-run must not perturb the file at all.
          return {
            entry,
            result: { step: "mcp", state: "already", detail: `${opts.writeMcp} already current` },
          };
        }
        writeMcpConfig(opts.writeMcp, merged.text);
        // `merged.state === "created"` means "the vaultledger entry didn't
        // exist yet" — which is true both when the target FILE was brand new
        // AND when an existing file (holding other MCP servers) simply had
        // no vaultledger entry to update. Only the former is honestly
        // "created"; the latter merged our entry into a pre-existing file,
        // so it reads as "merged into <path>" rather than falsely implying
        // the file itself was just created. `state` (created/updated/already)
        // is unchanged — only this human-facing `detail` wording differs.
        const fileExisted = existing !== null;
        const detail =
          merged.state === "created"
            ? fileExisted
              ? `merged into ${opts.writeMcp}`
              : `created ${opts.writeMcp}`
            : `${merged.state} ${opts.writeMcp}`;
        return { entry, result: { step: "mcp", state: merged.state, detail } };
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
