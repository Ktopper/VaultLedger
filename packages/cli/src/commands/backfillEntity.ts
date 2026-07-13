import { backfillEntity, type BackfillEntityResult } from "@vaultledger/core";
import { loadContext, type LoadContextDeps } from "../context.js";

export interface BackfillEntityOptions {
  out?: (s: string) => void;
}

/**
 * One-shot maintenance command: `ledger memory backfill-entity <vaultDir>`.
 * Thin wrapper over core's `backfillEntity` (see its doc comment for the
 * three-way backfill/skip/mismatch design) — loads context (which auto-heals
 * an empty journal via `ensureJournal`, same as any other CLI command), runs
 * the backfill, and prints a summary line plus one line per mismatch/error.
 */
export async function backfillEntityCommand(
  vaultDir: string,
  deps?: LoadContextDeps,
  opts: BackfillEntityOptions = {},
): Promise<BackfillEntityResult> {
  const out = opts.out ?? console.log;
  const ctx = await loadContext(vaultDir, deps);
  try {
    const result = await backfillEntity({
      broker: ctx.broker,
      journal: ctx.journal,
      vaultRoot: ctx.vaultRoot,
      manifest: ctx.manifest,
      now: ctx.now,
      genId: ctx.genId,
    });

    out(`backfilled=${result.backfilled} skipped=${result.skipped}`);
    for (const m of result.mismatched) {
      out(`  mismatch: ${m.path} file=${m.fileEntity ?? "(none)"} journal=${m.journalEntity}`);
    }
    for (const e of result.errors) {
      out(`  error: ${e.path}: ${e.reason}`);
    }

    return result;
  } finally {
    ctx.db.close();
  }
}
