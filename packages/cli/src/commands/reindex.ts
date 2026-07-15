import { reindex, type ReindexResult } from "@vault-ledger/core";
import { loadContext, type LoadContextDeps } from "../context.js";

export interface ReindexOptions {
  out?: (s: string) => void;
}

export async function reindexCommand(
  vaultDir: string,
  deps?: LoadContextDeps,
  opts: ReindexOptions = {},
): Promise<ReindexResult> {
  const out = opts.out ?? console.log;
  // Reindex does its own full disk+git walk below, so skip loadContext's
  // ensureJournal auto-heal (which would walk the vault a second time).
  const ctx = await loadContext(vaultDir, { ...deps, skipEnsure: true });
  try {
    const result = await reindex({
      vaultRoot: ctx.vaultRoot,
      git: ctx.git,
      journal: ctx.journal,
      manifest: ctx.manifest,
      now: ctx.now,
      genId: ctx.genId,
    });

    out(
      `Reindexed: memories=${result.memories} transactions=${result.transactions} ` +
        `skipped=${result.skipped.length} conflicts=${result.conflicts.length}`,
    );
    for (const s of result.skipped) out(`  skipped: ${s}`);
    for (const c of result.conflicts) out(`  conflict: ${c}`);
    for (const e of result.excludedZone) {
      out(`  excluded-zone (not indexed): ${e}`);
    }

    // Belt-and-braces recovery tripwire (v0.3a): flag loudly, never fail --
    // reindex above already adopted the file's canonical status regardless
    // (the journal must fully rebuild from the vault). This is a signal to
    // go verify the elevation was legitimately approved, not a rejection.
    if (result.elevatedToCanonical.length > 0) {
      out(
        `warning: ${result.elevatedToCanonical.length} belief(s) were elevated to canonical ` +
          `outside the broker (verify these were legitimately approved): ` +
          `${result.elevatedToCanonical.join(", ")}`,
      );
    }

    return result;
  } finally {
    ctx.db.close();
  }
}
