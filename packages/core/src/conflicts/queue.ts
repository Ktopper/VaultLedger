import type { ConflictRow, Journal, MemoryRow } from "../journal/journal.js";

// A memory in any of these statuses is not "live" and its conflicts are
// suppressed from the browse view. `retired` is not in the current
// MemoryStatus enum — it's a planned v0.3b status included here as deliberate
// forward-compat (the journal stores status as free text, so guarding against
// it now is harmless and avoids a future omission).
const DEAD_STATUSES = new Set(["forgotten", "reverted", "retired"]);

export interface EnrichedConflict {
  row: ConflictRow;
  memoryA: MemoryRow | null;
  memoryB: MemoryRow | null;
}

/**
 * Read/resolve surface over the `conflicts` journal table (design v0.3a
 * phase 4). `list()` enforces the both-sides-live guarantee: a conflict is
 * only ever surfaced to a human if BOTH memories it names still exist and
 * are still live (not forgotten/reverted/retired) — otherwise it's a zombie
 * (one side was undone/forgotten out from under it) and would be noise.
 * `get()` intentionally skips that filter since it's keyed by a specific
 * conflict id, not a browse view.
 */
export class Conflicts {
  constructor(private readonly journal: Journal) {}

  list(state = "open"): EnrichedConflict[] {
    return this.journal
      .listConflicts(state)
      .map((row) => this.enrich(row))
      .filter((c): c is EnrichedConflict => c !== null);
  }

  get(id: string): EnrichedConflict | null {
    const row = this.journal.getConflict(id);
    if (!row) return null;
    return {
      row,
      memoryA: row.memory_a ? this.journal.getMemory(row.memory_a) : null,
      memoryB: row.memory_b ? this.journal.getMemory(row.memory_b) : null,
    };
  }

  resolve(id: string, nowIso: string): void {
    this.journal.setConflictState(id, "resolved", nowIso);
  }

  dismiss(id: string, nowIso: string): void {
    this.journal.setConflictState(id, "dismissed", nowIso);
  }

  /** Enrich + apply the both-sides-live filter; null if either side is dead/missing. */
  private enrich(row: ConflictRow): EnrichedConflict | null {
    const memoryA = row.memory_a ? this.journal.getMemory(row.memory_a) : null;
    const memoryB = row.memory_b ? this.journal.getMemory(row.memory_b) : null;
    if (!memoryA || !memoryB) return null;
    if (DEAD_STATUSES.has(memoryA.status) || DEAD_STATUSES.has(memoryB.status)) return null;
    return { row, memoryA, memoryB };
  }
}
