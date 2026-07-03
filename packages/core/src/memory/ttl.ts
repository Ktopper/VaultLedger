import type { Journal, MemoryRow } from "../journal/journal.js";
import type { MemoryStore } from "./store.js";

const MS_PER_DAY = 86_400_000;
// v0.1 has no pagination need for a TTL sweep — a single generously-sized
// LIMIT keeps this a plain queryMemories call instead of a paging loop.
const SWEEP_QUERY_LIMIT = 1_000_000;

export interface SweepOptions {
  store: MemoryStore;
  journal: Journal;
  now: () => string;
  ttlDays: number;
  stalenessDays: number;
  session?: string;
}

export interface SweepResult {
  /** Scratch memories archived (forgotten) because they exceeded ttlDays. */
  archived: string[];
  /** Working memories not referenced within stalenessDays. Advisory only —
   * v0.1 does not mutate these; staleness is surfaced on demand by whatever
   * review layer calls `sweep`/`findStale` (design §3.3/§staleness). */
  staleFlagged: string[];
}

/**
 * Pure staleness predicate over an already-loaded set of memories, reusable
 * outside of `sweep` (e.g. by a CLI `review` command that wants to compute
 * staleness against a filtered/paginated set it already has in hand). Only
 * `working` memories are subject to staleness in v0.1 — scratch memories are
 * governed by the TTL sweep instead, and canonical/forgotten/reverted
 * memories are terminal statuses that staleness doesn't apply to.
 */
export function findStale(memories: MemoryRow[], now: () => string, stalenessDays: number): string[] {
  const nowMs = Date.parse(now());
  const thresholdMs = stalenessDays * MS_PER_DAY;
  const stale: string[] = [];
  for (const m of memories) {
    if (m.status !== "working") continue;
    const referenceIso = m.last_referenced ?? m.created;
    const referenceMs = Date.parse(referenceIso);
    if (nowMs - referenceMs > thresholdMs) {
      stale.push(m.id);
    }
  }
  return stale;
}

/**
 * TTL sweep (design §3.3 / memory lifecycle). Two independent passes:
 *
 *  1. Scratch memories older than `ttlDays` (by `created`) are archived via
 *     `store.forget` — a REAL mutation (file moved to Agent/Archive, journal
 *     row set to status "forgotten"). This is naturally idempotent: once a
 *     memory is forgotten it no longer matches the scratch-status query, so
 *     a second sweep run archives nothing further for it.
 *  2. Working memories not referenced within `stalenessDays` are computed
 *     via `findStale` and returned, but NOT mutated — v0.1 has no schema
 *     column to record "flagged as stale", and staleness is meant to be
 *     advisory/queryable on demand (surfaced by a later review layer) rather
 *     than a state transition in its own right.
 */
export async function sweep(opts: SweepOptions): Promise<SweepResult> {
  const { store, journal, now, ttlDays, stalenessDays, session } = opts;
  const nowMs = Date.parse(now());
  const ttlThresholdMs = ttlDays * MS_PER_DAY;

  const scratchMemories = journal.queryMemories({ status: "scratch", limit: SWEEP_QUERY_LIMIT });
  const archived: string[] = [];
  for (const m of scratchMemories) {
    const createdMs = Date.parse(m.created);
    if (nowMs - createdMs > ttlThresholdMs) {
      await store.forget({ id: m.id, reason: "ttl-expired", session: session ?? "ttl-sweep" });
      archived.push(m.id);
    }
  }

  const workingMemories = journal.queryMemories({ status: "working", limit: SWEEP_QUERY_LIMIT });
  const staleFlagged = findStale(workingMemories, now, stalenessDays);

  return { archived, staleFlagged };
}
