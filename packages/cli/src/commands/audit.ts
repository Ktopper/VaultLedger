import { auditMemories, type AuditResult } from "@vault-ledger/core";
import { loadContext, type LoadContextDeps } from "../context.js";

export interface AuditOptions {
  out?: (s: string) => void;
}

/**
 * One-shot maintenance command: `ledger memory audit <vaultDir>`. Thin
 * wrapper over core's `auditMemories` (see its doc comment for why this is
 * a STATE-BASED companion to the event-driven staleness hooks — it catches
 * a source that died AFTER it was cited, which no retire/forget/revise hook
 * was around to see) — loads context (which auto-heals an empty journal via
 * `ensureJournal`, same as any other CLI command), runs the scan, and
 * prints a summary line plus one line per stale pair.
 */
export async function auditCommand(
  vaultDir: string,
  deps?: LoadContextDeps,
  opts: AuditOptions = {},
): Promise<AuditResult> {
  const out = opts.out ?? console.log;
  const ctx = await loadContext(vaultDir, deps);
  try {
    const result = auditMemories({
      journal: ctx.journal,
      vaultRoot: ctx.vaultRoot,
      now: ctx.now,
      genId: ctx.genId,
    });

    out(`stale distillations: ${result.staleFlagged}`);
    for (const p of result.pairs) {
      out(`  ${p.distillation} cites ${p.source} (${p.reason})`);
    }
    for (const e of result.errors) {
      out(`  error: ${e.distillation} cites ${e.source}: ${e.reason}`);
    }

    // Mismatches/flags are a report, not a run failure — mirrors
    // backfill-entity's result.ok-driven exitCode convention: only an
    // outright per-edge processing error fails the exit code.
    return result;
  } finally {
    ctx.db.close();
  }
}
