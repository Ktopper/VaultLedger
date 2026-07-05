import { Conflicts, checkContradictions, type EnrichedConflict } from "@vaultledger/core";
import { loadContext, type LoadContextDeps } from "../context.js";

export interface ConflictsOptions extends LoadContextDeps {
  action?: "resolve" | "dismiss";
  id?: string;
  /** Re-run contradiction detection against every memory in the journal
   * before listing (respects the detector's dedupe key, so re-running is
   * idempotent — no duplicate/resurrected conflicts). */
  rescan?: boolean;
  out?: (s: string) => void;
}

function renderConflictLine(c: EnrichedConflict): string {
  const a = c.memoryA ? c.memoryA.path : "?";
  const b = c.memoryB ? c.memoryB.path : "?";
  return `[${c.row.id}] entity=${c.row.entity ?? "?"} kind=${c.row.kind ?? "?"} detail=${c.row.detail ?? "?"} | A:${a} vs B:${b}`;
}

/**
 * Thin adapter over core's `Conflicts` (+ `checkContradictions` for
 * `--rescan`):
 *  - `action` ("resolve"/"dismiss") + `id`: resolve/dismiss that conflict,
 *    print a confirmation, and return (no list).
 *  - `rescan`: re-run `checkContradictions` against every memory currently in
 *    the journal (re-detects; the detector's own dedupe key means this never
 *    creates a duplicate or resurrects a dismissed/resolved conflict), then
 *    fall through to the default listing.
 *  - default: list every open (enriched, both-sides-live) conflict.
 */
export async function conflictsCommand(
  vaultDir: string,
  opts: ConflictsOptions = {},
): Promise<EnrichedConflict[] | void> {
  const out = opts.out ?? console.log;
  const ctx = await loadContext(vaultDir, { now: opts.now, genId: opts.genId, env: opts.env });
  try {
    const conflicts = new Conflicts(ctx.journal);

    if (opts.action && opts.id) {
      if (opts.action === "resolve") {
        conflicts.resolve(opts.id, ctx.now());
      } else {
        conflicts.dismiss(opts.id, ctx.now());
      }
      out(`${opts.action === "resolve" ? "resolved" : "dismissed"} ${opts.id}`);
      return;
    }

    if (opts.rescan) {
      const all = ctx.journal.queryMemories({ limit: 100000 });
      for (const mem of all) {
        checkContradictions(
          { journal: ctx.journal, vaultRoot: ctx.vaultRoot, now: ctx.now, genId: ctx.genId },
          mem.id,
        );
      }
    }

    const open = conflicts.list("open");
    if (open.length === 0) {
      out("(no open conflicts)");
    }
    for (const c of open) {
      out(renderConflictLine(c));
    }
    return open;
  } finally {
    ctx.db.close();
  }
}
