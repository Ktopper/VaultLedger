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

  /**
   * Enrich + apply the both-sides-live filter; null if either side is
   * dead/missing. `kind` branches the liveness rule (see
   * `isStaleSourceLive`'s doc comment for why `stale-source` differs from
   * `value-conflict`/`negation-conflict`).
   */
  private enrich(row: ConflictRow): EnrichedConflict | null {
    const memoryA = row.memory_a ? this.journal.getMemory(row.memory_a) : null;
    const memoryB = row.memory_b ? this.journal.getMemory(row.memory_b) : null;

    // stale-source is evaluated BEFORE the both-sides-exist guard below: its
    // source side is EXPECTED to be dead OR GONE (a missing journal row after
    // undo/wipe), so requiring both rows to exist would hide exactly the flags
    // this kind exists to surface (audit's "missing source" + post-rebuild
    // recovery). It has its own rule (see `staleSourceShowable`).
    if (row.kind === "stale-source") {
      return this.staleSourceShowable(row, memoryA, memoryB) ? { row, memoryA, memoryB } : null;
    }

    if (!memoryA || !memoryB) return null;
    if (DEAD_STATUSES.has(memoryA.status) || DEAD_STATUSES.has(memoryB.status)) return null;
    return { row, memoryA, memoryB };
  }

  /**
   * A `stale-source` flag is browsable iff BOTH hold:
   *  (1) the DISTILLATION side exists AND is live — a forgotten/reverted/retired
   *      distillation, or a missing one, moots the flag (nothing to act on); and
   *  (2) the SOURCE side is still dead-or-gone — a dead status OR a missing
   *      journal row. If the source came back to life (e.g. an undo of the
   *      retire made it live again), the staleness no longer holds, so the row
   *      is HIDDEN even though it stays `open` in the table.
   *
   * The distillation side is identified PER-PAIR via the memory_relations edge
   * (NOT by memory_a/pair_lo position — ids sort arbitrarily — and NOT by "is a
   * distillation of anything": chains (D2 cites D1, D1 cites S) make both sides
   * "a distillation" in general, so only the specific edge identifies THIS
   * pair's distillation). The pair's IDS come from the row, which are present
   * even when a side's journal row is missing.
   */
  private staleSourceShowable(
    row: ConflictRow,
    memoryA: MemoryRow | null,
    memoryB: MemoryRow | null,
  ): boolean {
    const idA = row.memory_a;
    const idB = row.memory_b;
    if (!idA || !idB) return false;

    const aIsDistillation = this.journal
      .getRelationsForMemory(idA)
      .some((e) => e.source_id === idB && e.kind === "distilled");
    const bIsDistillation =
      !aIsDistillation &&
      this.journal
        .getRelationsForMemory(idB)
        .some((e) => e.source_id === idA && e.kind === "distilled");

    let distillation: MemoryRow | null;
    let source: MemoryRow | null;
    if (aIsDistillation) {
      distillation = memoryA;
      source = memoryB;
    } else if (bIsDistillation) {
      distillation = memoryB;
      source = memoryA;
    } else {
      // No edge in either direction: the citation was deleted out from under
      // the flag (undo of the distill, or a reindex that dropped it). Moot —
      // no discoverable distillation, so nobody can act on it.
      return false;
    }

    // (1) distillation must exist and be live.
    if (!distillation || DEAD_STATUSES.has(distillation.status)) return false;
    // (2) source must still be dead-or-gone; a resurrected (live) source hides
    //     the flag (the staleness premise no longer holds).
    return source === null || DEAD_STATUSES.has(source.status);
  }
}
