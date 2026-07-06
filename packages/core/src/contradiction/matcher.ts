import type { Journal, MemoryRow } from "../journal/journal.js";
import { foldEntity } from "./extract.js";

const LIVE_STATUSES = new Set(["canonical", "working"]);

export interface EntityMatcher {
  comparisonSet(mem: MemoryRow, journal: Journal): MemoryRow[];
}

/**
 * Same-entity candidates for `mem`, matched on the case/whitespace-folded
 * entity name. SQL folds case + surrounding whitespace (`lower(trim(...))`);
 * we JS-refilter with `foldEntity` to additionally collapse *internal*
 * whitespace runs, giving full "Nova" == " n o v a "-style parity. Returns
 * [] for a null/empty entity.
 */
function sameEntityCandidates(mem: MemoryRow, journal: Journal): MemoryRow[] {
  if (!mem.entity) return [];
  const folded = foldEntity(mem.entity);
  if (folded === "") return [];
  // Explicit high limit: the lineage walk must see every same-entity row,
  // not just the default page (queryMemories defaults to 100).
  return journal
    .queryMemoriesByEntityFolded(folded, 10000)
    .filter((c) => c.entity !== null && foldEntity(c.entity) === folded);
}

/**
 * Transitive supersedes closure for `mem`, walked in both directions:
 *  - "up" the chain: whatever `mem` (and its ancestors) supersedes
 *  - "down" the chain: whatever supersedes `mem` (and its descendants)
 * Iterates to a fixed point. Exported so a later unit (v0.3b) can union this
 * with derivation ids when building a broader comparison exclusion set.
 */
export function lineageIds(mem: MemoryRow, journal: Journal): Set<string> {
  const ids = new Set<string>([mem.id]);
  if (!mem.entity) return ids;

  const sameEntity = sameEntityCandidates(mem, journal);

  let changed = true;
  while (changed) {
    changed = false;

    // Up: each member's own supersedes pointer.
    for (const id of ids) {
      const row = id === mem.id ? mem : journal.getMemory(id);
      const supersedes = row?.supersedes;
      if (supersedes && !ids.has(supersedes)) {
        ids.add(supersedes);
        changed = true;
      }
    }

    // Down: any same-entity memory whose supersedes points at a member. This
    // inner scan can take up to O(chain depth) outer passes to reach a fixed
    // point (each pass extends the frontier by one link); always terminates
    // since `ids` only grows and is bounded by the same-entity row count.
    for (const candidate of sameEntity) {
      if (candidate.supersedes && ids.has(candidate.supersedes) && !ids.has(candidate.id)) {
        ids.add(candidate.id);
        changed = true;
      }
    }
  }

  return ids;
}

/**
 * Comparison set for contradiction detection: live (canonical/working)
 * same-entity peers, with `mem` itself and its whole supersedes lineage
 * (in both directions) excluded — a memory should never be compared against
 * its own revision history.
 *
 * SECURITY EXCEPTION (v0.3a post-merge fix): the lineage exclusion is NOT
 * honored when the excluded candidate is still-live CANONICAL. `supersedes`
 * is an unvalidated field on `remember` (memory/store.ts) — a misbehaving or
 * prompt-injected agent could otherwise write a new memory that sets
 * `supersedes` to a canonical memory's id purely to make the lineage filter
 * hide it from comparison, silently defeating detection with no approval
 * gate in between (two live contradictory beliefs, zero flags raised).
 * Canonical is a durable, human-approved belief (spec §5.4: "canonical is
 * never silently contradicted"), so a new claim that supersedes canonical
 * must still surface a conflict; a human dismisses it if the update is
 * legitimate. Superseding a WORKING/scratch (provisional) belief remains a
 * legitimate intentional update, so the lineage exclusion still applies
 * there (false-positive guard preserved).
 */
export class DefaultEntityMatcher implements EntityMatcher {
  comparisonSet(mem: MemoryRow, journal: Journal): MemoryRow[] {
    if (!mem.entity) return [];

    const candidates = sameEntityCandidates(mem, journal);
    const lineage = lineageIds(mem, journal);

    return candidates.filter(
      (c) =>
        c.id !== mem.id &&
        LIVE_STATUSES.has(c.status) &&
        (!lineage.has(c.id) || c.status === "canonical"),
    );
  }
}
