import { BrokerError } from "../errors.js";
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

  // Deliberately skips the both-sides-live filter (it's keyed by a specific
  // conflict id, not a browse view) — do NOT use this to render fields to a
  // UI. A future `GET /conflicts/:id` detail route must NOT call this
  // directly for display, or it reintroduces a zombie-display path; it
  // should apply the same live-check `enrich` does, or call `list()` and
  // filter by id.
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
    this.transition(id, "resolved", nowIso);
  }

  dismiss(id: string, nowIso: string): void {
    this.transition(id, "dismissed", nowIso);
  }

  // Guards the open -> resolved/dismissed transition: only a conflict
  // currently in state 'open' may move. A non-existent id throws NOT_FOUND
  // (consistent with get() signaling "no such conflict" rather than a silent
  // no-op that would look like success). A conflict that's already
  // resolved/dismissed throws ALREADY_CLOSED instead of letting a second
  // resolve/dismiss silently overwrite its terminal state -- e.g. a
  // dismissed conflict flipping to resolved (or vice-versa) is an
  // audit-integrity hole, not a legitimate transition.
  private transition(id: string, nextState: "resolved" | "dismissed", nowIso: string): void {
    const row = this.journal.getConflict(id);
    if (!row) {
      throw new BrokerError("NOT_FOUND", `no conflict with id ${id}`);
    }
    if (row.state !== "open") {
      throw new BrokerError("ALREADY_CLOSED", `conflict ${id} is already ${row.state}`);
    }
    this.journal.setConflictState(id, nextState, nowIso);
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
