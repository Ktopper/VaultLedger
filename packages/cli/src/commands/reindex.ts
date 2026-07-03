import { reindex, type ReindexResult } from "@vaultledger/core";
import { loadContext, type LoadContextDeps } from "../context.js";

export async function reindexCommand(
  vaultDir: string,
  deps?: LoadContextDeps,
): Promise<ReindexResult> {
  const out = console.log;
  // Reindex rebuilds the journal itself, so skip the startup sweep — running
  // it against a journal loadContext just (re)populated would be redundant.
  const ctx = await loadContext(vaultDir, { ...deps, skipSweep: true });
  try {
    const result = await reindex({
      vaultRoot: ctx.vaultRoot,
      git: ctx.git,
      journal: ctx.journal,
      now: ctx.now,
      genId: ctx.genId,
    });

    out(
      `Reindexed: memories=${result.memories} transactions=${result.transactions} ` +
        `skipped=${result.skipped.length} conflicts=${result.conflicts.length}`,
    );
    for (const s of result.skipped) out(`  skipped: ${s}`);
    for (const c of result.conflicts) out(`  conflict: ${c}`);

    return result;
  } finally {
    ctx.db.close();
  }
}
