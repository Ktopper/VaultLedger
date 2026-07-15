#!/usr/bin/env node
import { resolvesToThisModule, explainNativeBindingError } from "@vault-ledger/core";
import { Command } from "commander";
// Re-exported so the committed bin launcher (bin/ledger.mjs) can use it in its
// own `main().catch` backstop — the launcher is the real entrypoint.
export { explainNativeBindingError };
import { approveCommand } from "./commands/approve.js";
import { auditCommand } from "./commands/audit.js";
import { backfillEntityCommand } from "./commands/backfillEntity.js";
import { conflictsCommand } from "./commands/conflicts.js";
import { runDoctor } from "./commands/doctor.js";
import { renderDoctorReport } from "./commands/doctorReport.js";
import { initCommand } from "./commands/init.js";
import { logCommand } from "./commands/log.js";
import { reindexCommand } from "./commands/reindex.js";
import { serveCommand } from "./commands/serve.js";
import { defaultSteps, setupCommand } from "./commands/setup.js";
import { statusCommand } from "./commands/status.js";
import { undoCommand } from "./commands/undo.js";

// Re-exported so the testable command functions (and their option/result
// types) are part of this package's public surface — not just reachable via
// relative imports from within this package's own tests. Lets other
// workspace packages (e.g. the mcp-server v0.1 gate test, which drives the
// real `initCommand`/`undoCommand` rather than reaching into CLI internals)
// import the exact same functions `buildProgram` wires up above.
export { approveCommand, type ApproveOptions, type ApproveCommandResult } from "./commands/approve.js";
export { auditCommand, type AuditOptions } from "./commands/audit.js";
export { backfillEntityCommand, type BackfillEntityOptions } from "./commands/backfillEntity.js";
export { conflictsCommand, type ConflictsOptions } from "./commands/conflicts.js";
export { runDoctor, type DoctorOptions, type DoctorResult } from "./commands/doctor.js";
export { renderDoctorReport, type CheckResult, type CheckStatus } from "./commands/doctorReport.js";
export { initCommand, type InitOptions, type InitResult } from "./commands/init.js";
export { logCommand, type LogFilters } from "./commands/log.js";
export { reindexCommand } from "./commands/reindex.js";
export { serveCommand, type ServeOptions, type ServeHandle } from "./commands/serve.js";
export { defaultSteps, setupCommand } from "./commands/setup.js";
export { statusCommand, type StatusResult } from "./commands/status.js";
export { undoCommand, type UndoOptions, type UndoCommandResult } from "./commands/undo.js";
export { loadContext, type LedgerContext, type LoadContextDeps } from "./context.js";

function reportError(e: unknown): void {
  // A broken better-sqlite3 native binding otherwise dumps a raw ~14-line
  // `bindings` path list; collapse that class to one actionable line.
  console.error(explainNativeBindingError(e) ?? (e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
}

/**
 * Build the `ledger` commander program. Every subcommand is a thin wrapper:
 * parse args/opts, call the corresponding (already fully-tested) command
 * function from ./commands, and set process.exitCode on rejection. No
 * business logic lives here — orchestration only.
 */
export function buildProgram(): Command {
  const program = new Command();
  // Keep in sync with packages/cli/package.json "version".
  program.name("ledger").description("VaultLedger CLI").version("0.4.0");

  program
    .command("init <vaultDir>")
    .description("scan a vault and, with --yes, initialize VaultLedger in it")
    .option("-y, --yes", "write .ledger/config.json + permissions.yaml and git init", false)
    .action(async (vaultDir: string, opts: { yes: boolean }) => {
      try {
        await initCommand(vaultDir, { confirm: opts.yes });
      } catch (e) {
        reportError(e);
      }
    });

  program
    .command("status <vaultDir>")
    .description("show zones, pending approvals, and recent transactions")
    .action(async (vaultDir: string) => {
      try {
        await statusCommand(vaultDir);
      } catch (e) {
        reportError(e);
      }
    });

  program
    .command("doctor <vaultDir>")
    .description("read-only health check: inspect vault + runtime wiring, report issues")
    .option("--json", "emit CheckResult[] as JSON", false)
    .option("--strict", "treat warnings as failures (exit 1)", false)
    .action(async (vaultDir: string, opts: { json: boolean; strict: boolean }) => {
      try {
        const { checks, exitCode } = await runDoctor(vaultDir, opts, {});
        if (opts.json) console.log(JSON.stringify({ checks, exitCode }, null, 2));
        else console.log(renderDoctorReport(checks));
        if (exitCode !== 0) process.exitCode = exitCode;
      } catch (e) {
        reportError(e);
      }
    });

  program
    .command("log <vaultDir>")
    .description("list transactions")
    .option("--entity <entity>", "filter by memory entity")
    .option("--session <session>", "filter by session id")
    // Keep the raw string here and validate in the action — a commander
    // coercion callback can only throw a CommanderError, which is noisier than
    // the friendly one-line message we want for a bad --limit.
    .option("--limit <limit>", "max rows (default 20)")
    .action(async (vaultDir: string, opts: { entity?: string; session?: string; limit?: string }) => {
      let limit: number | undefined;
      if (opts.limit !== undefined) {
        // Reject anything that isn't a positive integer BEFORE it can reach
        // the sqlite query as NaN.
        if (!/^\d+$/.test(opts.limit) || Number.parseInt(opts.limit, 10) < 1) {
          console.error(`invalid --limit: ${opts.limit} (expected a positive integer)`);
          process.exitCode = 1;
          return;
        }
        limit = Number.parseInt(opts.limit, 10);
      }
      try {
        await logCommand(vaultDir, { entity: opts.entity, session: opts.session, limit });
      } catch (e) {
        reportError(e);
      }
    });

  program
    .command("reindex <vaultDir>")
    .description("rebuild the journal from disk + git")
    .action(async (vaultDir: string) => {
      try {
        await reindexCommand(vaultDir);
      } catch (e) {
        reportError(e);
      }
    });

  const memory = program.command("memory").description("memory maintenance commands");

  memory
    .command("backfill-entity <vaultDir>")
    .description(
      "write each journal row's entity into its note's top-level frontmatter, so a full " +
        "journal rebuild recovers it (one-shot maintenance for pre-fix legacy notes)",
    )
    .action(async (vaultDir: string) => {
      try {
        const result = await backfillEntityCommand(vaultDir);
        // Mismatches are a report for a human to act on, not a run failure —
        // only an outright processing error (missing/unreadable/corrupt
        // note) fails the exit code, mirroring `undo`/`approve`'s
        // result.ok-driven exitCode convention rather than throwing.
        if (result.errors.length > 0) {
          process.exitCode = 1;
        }
      } catch (e) {
        reportError(e);
      }
    });

  memory
    .command("audit <vaultDir>")
    .description(
      "state-based scan: flag every distillation citing a source that is dead-or-gone " +
        "(retired/forgotten/reverted/missing), catching sources that died AFTER they were cited",
    )
    .action(async (vaultDir: string) => {
      try {
        const result = await auditCommand(vaultDir);
        // Stale pairs are a report for a human to act on, not a run failure —
        // only an outright per-edge processing error fails the exit code,
        // mirroring backfill-entity's result.ok-driven exitCode convention.
        if (result.errors.length > 0) {
          process.exitCode = 1;
        }
      } catch (e) {
        reportError(e);
      }
    });

  program
    .command("approve <vaultDir>")
    .description("list pending approvals, or resolve one by id")
    .option("--id <id>", "approval id to resolve")
    .option("--reject", "reject instead of approve", false)
    .option("--color", "colorize the rendered diff", false)
    .action(async (vaultDir: string, opts: { id?: string; reject: boolean; color: boolean }) => {
      try {
        const result = await approveCommand(vaultDir, {
          id: opts.id,
          reject: opts.reject,
          color: opts.color,
        });
        if (!Array.isArray(result) && "ok" in result && result.ok === false) {
          process.exitCode = 1;
        }
      } catch (e) {
        reportError(e);
      }
    });

  program
    .command("conflicts <vaultDir> [action] [id]")
    .description("list open conflicts, or resolve/dismiss one by id")
    .option("--rescan", "re-run contradiction detection against every memory", false)
    .option("--limit <n>", "override the --rescan memory scan cap (default: RESCAN_MEMORY_CAP)")
    .action(
      async (
        vaultDir: string,
        action: string | undefined,
        id: string | undefined,
        opts: { rescan: boolean; limit?: string },
      ) => {
        if (action !== undefined && action !== "resolve" && action !== "dismiss") {
          console.error(`invalid action: ${action} (expected "resolve" or "dismiss")`);
          process.exitCode = 1;
          return;
        }
        if (action !== undefined && id === undefined) {
          console.error(`--action ${action} requires an id`);
          process.exitCode = 1;
          return;
        }
        let limit: number | undefined;
        if (opts.limit !== undefined) {
          if (!/^\d+$/.test(opts.limit) || Number.parseInt(opts.limit, 10) < 1) {
            console.error(`invalid --limit: ${opts.limit} (expected a positive integer)`);
            process.exitCode = 1;
            return;
          }
          limit = Number.parseInt(opts.limit, 10);
        }
        try {
          await conflictsCommand(vaultDir, { action, id, rescan: opts.rescan, limit });
        } catch (e) {
          reportError(e);
        }
      },
    );

  program
    .command("serve <vault>")
    .description("start the local HTTP bridge (for the Obsidian plugin) and publish its discovery file")
    .option("--port <n>", "port to listen on (default: OS-assigned)")
    .option("--rotate-token", "mint a fresh bridge token", false)
    .action(async (vault: string, opts: { port?: string; rotateToken: boolean }) => {
      let port: number | undefined;
      if (opts.port !== undefined) {
        // Accept 0 — the documented OS-assign sentinel (startBridge reads the
        // actual bound port back afterward). Reject negatives / non-integers.
        if (!/^\d+$/.test(opts.port) || Number.parseInt(opts.port, 10) < 0) {
          console.error(`invalid --port: ${opts.port} (expected a non-negative integer)`);
          process.exitCode = 1;
          return;
        }
        port = Number.parseInt(opts.port, 10);
      }
      try {
        // No process.exit here, and the returned handle's close() is never
        // called from this action: serveCommand's own SIGINT/SIGTERM
        // handlers own shutdown, and the open HTTP server keeps the process
        // alive (Node's event loop doesn't exit while a listening server
        // handle is open) until one of those signals fires.
        await serveCommand(vault, { port, rotateToken: opts.rotateToken });
      } catch (e) {
        reportError(e);
      }
    });

  program
    .command("setup <vaultDir>")
    .description("onboard a vault: init, wire Claude Code MCP, verify, (optionally) install the plugin")
    .option("-y, --yes", "auto-confirm the zone manifest (skip the prompt)", false)
    .option("--write-mcp <path>", "merge the Claude Code MCP config into <path> instead of printing it")
    .option("--install-plugin", "copy the Obsidian review plugin into <vault>/.obsidian/plugins/", false)
    .option("--json", "emit StepResult[] as JSON", false)
    .action(
      async (
        vaultDir: string,
        opts: { yes: boolean; writeMcp?: string; installPlugin: boolean; json: boolean },
      ) => {
        try {
          const results = await setupCommand(
            vaultDir,
            { yes: opts.yes, writeMcp: opts.writeMcp, installPlugin: opts.installPlugin, json: opts.json },
            defaultSteps(),
            {},
          );
          if (results.some((r) => r.state === "failed")) {
            process.exitCode = 1;
          }
        } catch (e) {
          reportError(e);
        }
      },
    );

  program
    .command("undo <vaultDir> <target>")
    .description("revert a transaction id, or every transaction for session:<id>")
    .action(async (vaultDir: string, target: string) => {
      try {
        const result = await undoCommand(vaultDir, target);
        if (!result.ok) {
          process.exitCode = 1;
        }
      } catch (e) {
        reportError(e);
      }
    });

  return program;
}

/**
 * Programmatic entry point for tests: `run(["init", dir])` parses a bare
 * user-style argv (no node/script prefix). With no argument, parses the real
 * `process.argv` (used by the shebang entry point below).
 */
export async function run(argv?: string[]): Promise<void> {
  const program = buildProgram();
  if (argv) {
    await program.parseAsync(argv, { from: "user" });
  } else {
    await program.parseAsync(process.argv);
  }
}

/**
 * Exported process entry point, invoked by the committed bin launcher
 * (`packages/cli/bin/ledger.mjs`). The launcher imports `dist/index.js` as a
 * module rather than executing it as the process's main script, so
 * `process.argv[1]` is the LAUNCHER's path, not this file's — the
 * `isMainModule` guard below is (correctly) false in that case, and `main()`
 * must be called explicitly instead. `run()` with no argument parses the
 * real `process.argv`, exactly like the direct-invocation path.
 */
export async function main(): Promise<void> {
  await run();
}

// Only auto-run when this module is the process's actual entry point (e.g.
// `node dist/index.js` invoked directly), never when imported by tests OR by
// the bin launcher (which calls the exported `main()` above instead — see its
// doc comment for why this guard is false in that case). See
// `resolvesToThisModule` in `@vault-ledger/core` (hoisted there since
// `packages/mcp-server/src/index.ts` needs the identical symlink-aware guard)
// for the pnpm-bin-shim / realpath rationale.
const isMainModule = resolvesToThisModule(process.argv[1], import.meta.url);
if (isMainModule) {
  void main();
}
