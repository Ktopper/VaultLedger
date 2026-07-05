import type { Journal, MemoryRow } from "../journal/journal.js";

const LIVE_STATUSES = new Set(["canonical", "working"]);

export interface EntityMatcher {
  comparisonSet(mem: MemoryRow, journal: Journal): MemoryRow[];
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

  // Explicit high limit: the lineage walk must see every same-entity row,
  // not just the default page (queryMemories defaults to 100).
  const sameEntity = journal.queryMemories({ entity: mem.entity, limit: 10000 });

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

    // Down: any same-entity memory whose supersedes points at a member.
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
 */
export class DefaultEntityMatcher implements EntityMatcher {
  comparisonSet(mem: MemoryRow, journal: Journal): MemoryRow[] {
    if (!mem.entity) return [];

    const candidates = journal.queryMemories({ entity: mem.entity, limit: 10000 });
    const lineage = lineageIds(mem, journal);

    return candidates.filter(
      (c) => c.id !== mem.id && LIVE_STATUSES.has(c.status) && !lineage.has(c.id),
    );
  }
}
