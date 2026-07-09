import { hashBytes } from "../broker/hash.js";
import type { Journal } from "../journal/journal.js";
import { extract, type MemoryFacts } from "./extract.js";
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

/**
 * Shared deps for the event-driven staleness hooks below. Deliberately
 * narrower than `checkContradictions`' deps (no `vaultRoot`/matcher/detector)
 * -- these two functions never read a file off disk themselves; every
 * caller (store.retire/forget/revise, Approvals.dispatchApply) resolves the
 * relevant content/hash itself and passes it in, exactly like
 * `flagStaleSource` already does for `contentId`.
 */
export interface StalenessDeps {
  journal: Journal;
  now: () => string;
  genId: (prefix: string) => string;
}

/**
 * Flag every distillation citing `sourceId` as stale (one `stale-source`
 * conflict row per citing distillation, via `flagStaleSource`). Called by
 * every event that makes a source no longer trustworthy as cited:
 * `store.retire` (always, both the working and approved-canonical paths),
 * `store.forget` (always), and `checkSourceStaleness` below (revise, only on
 * a fact change).
 *
 * POST-COMMIT, NON-BLOCKING (mirrors `checkContradictions`): called AFTER
 * the source's own status/content change has already landed (broker +
 * journal committed). Never throws -- any failure (a bad journal read, a
 * `flagStaleSource` insert error) is logged and swallowed so a staleness-
 * detection bug can never fail the retire/forget/revise it's attached to.
 */
export function flagCitingDistillations(
  deps: StalenessDeps,
  sourceId: string,
  sourceStatus: string,
  contentId: string,
): void {
  try {
    const { journal, now, genId } = deps;
    const edges = journal.getDistillationsCitingSource(sourceId);
    for (const edge of edges) {
      const distillation = journal.getMemory(edge.memory_id);
      flagStaleSource(
        journal,
        {
          distillationId: edge.memory_id,
          sourceId,
          sourceStatus,
          contentId,
          entity: distillation?.entity ?? null,
        },
        now,
        genId,
      );
    }
  } catch (err) {
    console.error(`flagCitingDistillations failed for source ${sourceId}:`, err);
  }
}

/** Deep-equal two canonicalized fact maps (same keys, same canonical
 * values). `CanonicalValue` is a small plain-data union (type + a
 * primitive), so JSON-stringifying each value is a safe, order-independent
 * equality check -- we compare key-by-key rather than stringifying the
 * whole map, since Map iteration order must not matter here. */
function factsEqual(a: MemoryFacts, b: MemoryFacts): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const other = b.get(key);
    if (other === undefined) return false;
    if (JSON.stringify(value) !== JSON.stringify(other)) return false;
  }
  return true;
}

/**
 * The REVISE path (v0.3b-2): given a memory's content before and after an
 * applied revise, flag every citing distillation stale IFF the revise
 * actually changed a canonicalized FACT (not just prose). Cheap guard
 * FIRST -- `getDistillationsCitingSource` is an indexed lookup, so the
 * overwhelming common case (a revise of a memory nobody cites) returns
 * before either `extract()` call runs.
 *
 * ONE helper wired to BOTH content-changing revise surfaces (design v0.3b-2
 * hook-point pin): `MemoryStore.revise`'s own immediate-apply path, AND
 * `Approvals.dispatchApply` (the approved-canonical-revise path, which
 * applies via `Broker.apply` directly and never re-enters `store.revise` --
 * see that method's EXECUTION CONTRACT doc comment). A future revise
 * surface that forgets to call this is a staleness-detection gap, the same
 * class of bug `supersedes` once had before the matcher's lineage
 * exclusion existed.
 *
 * POST-COMMIT, NON-BLOCKING: called AFTER the revise has already landed
 * (`afterContent` is the on-disk post-revise text). Never throws.
 */
export function checkSourceStaleness(
  deps: StalenessDeps,
  sourceId: string,
  beforeContent: string,
  afterContent: string,
): void {
  try {
    const { journal } = deps;
    if (journal.getDistillationsCitingSource(sourceId).length === 0) return;

    const beforeFacts = extract(beforeContent);
    const afterFacts = extract(afterContent);
    if (factsEqual(beforeFacts, afterFacts)) return;

    const source = journal.getMemory(sourceId);
    // The revise already landed by the time this runs, so the source's
    // CURRENT status is whatever it is post-revise (a content revise never
    // changes status -- see MemoryStore.revise's doc comment -- but reading
    // it fresh rather than assuming keeps this correct if that ever
    // changes). A missing row is defensive-only: every caller derives
    // `sourceId` from a memory that is (by construction) cited by at least
    // one distillation edge, so `getMemory` returning null here would
    // itself indicate a journal-integrity bug, not a normal path.
    const sourceStatus = source?.status ?? "unknown";
    const contentId = hashBytes(Buffer.from(afterContent, "utf8"));
    flagCitingDistillations(deps, sourceId, sourceStatus, contentId);
  } catch (err) {
    console.error(`checkSourceStaleness failed for source ${sourceId}:`, err);
  }
}
