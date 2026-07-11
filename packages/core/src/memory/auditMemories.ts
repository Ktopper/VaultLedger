import { existsSync } from "node:fs";
import { join } from "node:path";
import { hashFile } from "../broker/hash.js";
import { flagStaleSource } from "../contradiction/staleness.js";
import type { Journal } from "../journal/journal.js";

export interface AuditMemoriesDeps {
  journal: Journal;
  /** Absolute path to the vault root (needed to hashFile a source's current
   * on-disk content, if any). */
  vaultRoot: string;
  now: () => string;
  genId: (prefix: string) => string;
}

/** A distillation->source pair whose source is dead-or-gone. */
export interface AuditPair {
  distillation: string;
  source: string;
  /** Why the source is dead-or-gone: "missing" (no journal row at all), or
   * the source's own status ("retired" | "forgotten" | "reverted"). */
  reason: string;
}

/** An edge the audit could not process (a bad journal read, a
 * `flagStaleSource` insert error) -- non-fatal; recorded so the scan can
 * continue past a single bad edge. */
export interface AuditMemoriesError {
  distillation: string;
  source: string;
  reason: string;
}

export interface AuditResult {
  /** Total dead-or-gone distillation->source pairs found this run (== the
   * length of `pairs`). Stable across re-runs even though the underlying
   * `flagStaleSource` insert dedupes -- this counts what the SCAN found, not
   * what was newly inserted. */
  staleFlagged: number;
  pairs: AuditPair[];
  errors: AuditMemoriesError[];
}

/** Statuses that make a source no longer trustworthy as a citation. Mirrors
 * `flagCitingDistillations`' event-driven callers (retire/forget/revise-
 * lineage) plus `reverted` (undo), which none of those event hooks cover --
 * that gap is exactly what this STATE-BASED scan exists to close. */
const DEAD_STATUSES = new Set(["retired", "forgotten", "reverted"]);

/**
 * State-based companion to the event-driven staleness hooks in
 * `contradiction/staleness.ts`. Those hooks fire when a source DIES (retire/
 * forget/a fact-changing revise) and flag every distillation citing it at
 * that moment -- but they can never catch a source that was ALREADY dead
 * before this code existed, or a source that goes dead via a path with no
 * hook (`undoTransaction`, which reverts a create with no staleness call of
 * its own). This walks EVERY distillation->source edge in the journal
 * (`journal.getAllRelations()`) and re-derives, from CURRENT state, which
 * ones cite a dead-or-gone source:
 *
 *  - the source's journal row is missing entirely -> reason "missing",
 *    contentId "GONE".
 *  - the source's row exists but its status is retired/forgotten/reverted ->
 *    reason = that status; contentId = a sha256 of the file currently at the
 *    source's journal `path` if it exists on disk, else "GONE" (retired: the
 *    file is in place; forgotten: the row's `path` already points at
 *    Agent/Archive/<id>.md, since `store.forget` updates it there; reverted:
 *    the file was deleted by undo).
 *  - any other status (scratch/working/canonical) -> live, skipped.
 *
 * Every dead-or-gone pair is flagged via `flagStaleSource`, which is
 * deduped against the `conflicts` table's unique key -- re-running this scan
 * never duplicates a row, whether the flag already exists from an
 * event-driven hook or from a prior run of this same scan.
 *
 * Non-fatal per edge: one bad edge (e.g. `getMemory` throwing) is recorded
 * in `errors` and the scan continues, mirroring `backfillEntity`'s
 * per-item-non-fatal shape.
 */
export function auditMemories(deps: AuditMemoriesDeps): AuditResult {
  const { journal, vaultRoot, now, genId } = deps;

  const pairs: AuditPair[] = [];
  const errors: AuditMemoriesError[] = [];

  for (const edge of journal.getAllRelations()) {
    if (edge.kind !== "distilled") continue; // LOW-5: only distillation edges
    const distillationId = edge.memory_id;
    const sourceId = edge.source_id;
    try {
      // LOW-4: skip an edge whose DISTILLATION side is itself dead-or-gone
      // (missing, or a dead status). Its staleness flag would be mooted +
      // permanently hidden by the kind-aware liveness filter (which requires a
      // live distillation), so flagging it only inflates the count and inserts
      // a row nobody can ever see or act on.
      const distillation = journal.getMemory(distillationId);
      if (!distillation || DEAD_STATUSES.has(distillation.status)) continue;

      const source = journal.getMemory(sourceId);

      let reason: string;
      let contentId: string;
      if (!source) {
        reason = "missing";
        contentId = "GONE";
      } else if (DEAD_STATUSES.has(source.status)) {
        reason = source.status;
        const abs = join(vaultRoot, source.path);
        contentId = existsSync(abs) ? hashFile(abs) : "GONE";
      } else {
        continue; // live source (scratch/working/canonical) -- not stale.
      }

      flagStaleSource(
        journal,
        {
          distillationId,
          sourceId,
          sourceStatus: reason,
          contentId,
          entity: distillation.entity ?? null,
        },
        now,
        genId,
      );
      pairs.push({ distillation: distillationId, source: sourceId, reason });
    } catch (e) {
      errors.push({
        distillation: distillationId,
        source: sourceId,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { staleFlagged: pairs.length, pairs, errors };
}
