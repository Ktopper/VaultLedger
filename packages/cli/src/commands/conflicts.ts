import { BrokerError, Conflicts, checkContradictions, type EnrichedConflict } from "@vaultledger/core";
import { loadContext, type LoadContextDeps } from "../context.js";

// Statuses a memory can hold that mean it's dead — forgotten/reverted/retired
// (mirrors core's Conflicts DEAD_STATUSES). A rescan must not run detection
// off a dead memory: it wastes I/O and, worse, can insert a zombie conflict
// row (one side dead) that the both-sides-live view will always hide but that
// still sits as dead weight in the table. So iterate LIVE memories only.
const DEAD_STATUSES = new Set(["forgotten", "reverted", "retired"]);

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
      // Mirror the bridge route: an unconditional setConflictState is a 0-row
      // no-op on an unknown id, which would let us print a false "resolved
      // <id>" and exit 0 — a false success report. Check existence first and
      // surface a NOT_FOUND so the commander wrapper prints it and exits
      // non-zero (CLAUDE.md: choose auditability over convenience).
      if (!conflicts.get(opts.id)) {
        throw new BrokerError("NOT_FOUND", `conflict ${opts.id} not found`);
      }
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
        // Skip dead memories: running detection off a forgotten/reverted/
        // retired memory can only ever insert a zombie conflict row (its own
        // side is dead) that the both-sides-live view will always hide.
        if (DEAD_STATUSES.has(mem.status)) continue;
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
