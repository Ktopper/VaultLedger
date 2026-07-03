import { reindex, type ReindexResult } from "@vaultledger/core";
import { loadContext, type LoadContextDeps } from "../context.js";

export async function reindexCommand(
  vaultDir: string,
  deps?: LoadContextDeps,
): Promise<ReindexResult> {
  const out = console.log;
  // Reindex does its own full disk+git walk below, so skip loadContext's
  // ensureJournal auto-heal (which would walk the vault a second time).
  const ctx = await loadContext(vaultDir, { ...deps, skipEnsure: true });
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
