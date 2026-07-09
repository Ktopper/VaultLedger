import type { Journal } from "../journal/journal.js";
import { conflictValueHash } from "./valueHash.js";

export interface StaleSourceDetailArgs {
  distillationId: string;
  sourceId: string;
  /** The source memory's CURRENT status (e.g. "retired", "forgotten",
   * "reverted") -- whatever made it stale. */
  sourceStatus: string;
  /** The source note's content identity: a `sha256:...` digest of its
   * current file contents, or the literal string `"GONE"` when the file no
   * longer exists on disk. */
  contentId: string;
}

/**
 * Build the `detail` string for a `stale-source` conflict row.
 *
 * THIS STRING IS A `conflictValueHash` PREIMAGE -- it is HASH-STABLE. The
 * `value_hash` folded into the `conflicts` table's unique dedup key (see
 * journal/db.ts and contradiction/valueHash.ts) is `conflictValueHash(this
 * string)`, so any change to this format is a MIGRATION event, not a
 * copyedit: it silently changes every stale-source value_hash, which means
 * every previously-dismissed stale-source flag stops deduping against its
 * freshly re-detected twin and the conflicts queue re-floods with rows a
 * human already triaged. If this format ever needs to change, it must ship
 * with a value_hash backfill migration (mirroring
 * journal/db.ts's migrateConflictsValueHash), not a silent edit here.
 *
 * Deterministic components ONLY: distillationId, sourceId, sourceStatus, and
 * contentId (a content-addressed identity, not a mtime/size). No
 * timestamps, counters, or locale-formatted text -- the SAME stale-source
 * situation must always hash to the SAME value_hash.
 */
export function staleSourceDetail(args: StaleSourceDetailArgs): string {
  const { distillationId, sourceId, sourceStatus, contentId } = args;
  return `stale-source: ${distillationId} cites ${sourceId} now ${sourceStatus} (content ${contentId})`;
}

export interface FlagStaleSourceArgs {
  distillationId: string;
  sourceId: string;
  sourceStatus: string;
  contentId: string;
  entity: string | null;
}

/**
 * Insert a `stale-source` conflict row flagging that `distillationId` cites
 * `sourceId`, which is no longer live. Mirrors check.ts's row-building
 * convention: the pair is id-sorted (`pair_lo`/`pair_hi`, and correspondingly
 * `memory_a`/`memory_b`) purely for the UNIQUE dedup key's benefit -- do NOT
 * read memory_a/memory_b as "the distillation is always memory_a"; which
 * side is the distillation is a semantic fact recorded via the
 * memory_relations edge, not row position (see queue.ts's kind-aware
 * both-sides-live filter, which resolves the distillation side with a
 * per-pair edge lookup for exactly this reason).
 *
 * `insertConflict` is `ON CONFLICT DO NOTHING` against
 * (pair_lo, pair_hi, kind, fact_key, value_hash), so calling this twice with
 * identical arguments is a no-op the second time (dedup), while a different
 * `sourceStatus` or `contentId` changes `detail` (and hence `value_hash`)
 * and produces a distinct, separately-dismissable row.
 */
export function flagStaleSource(
  journal: Journal,
  args: FlagStaleSourceArgs,
  now: () => string,
  genId: (prefix: string) => string,
): void {
  const { distillationId, sourceId, sourceStatus, contentId, entity } = args;
  const lo = distillationId < sourceId ? distillationId : sourceId;
  const hi = distillationId < sourceId ? sourceId : distillationId;
  const detail = staleSourceDetail({ distillationId, sourceId, sourceStatus, contentId });

  journal.insertConflict({
    id: genId("cf"),
    memory_a: lo,
    memory_b: hi,
    pair_lo: lo,
    pair_hi: hi,
    kind: "stale-source",
    fact_key: "source",
    value_hash: conflictValueHash(detail),
    entity,
    detail,
    created_at: now(),
    state: "open",
    resolved_at: null,
  });
}
