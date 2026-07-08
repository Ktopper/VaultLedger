import type { Journal, QueryMemoriesFilters } from "../journal/journal.js";

export type RecallFilters = QueryMemoriesFilters;

/** A memory as returned by `recall`, with its tags attached. */
export interface RecallResult {
  id: string;
  path: string;
  entity: string | null;
  status: string;
  confidence: string | null;
  created: string;
  source: string | null;
  reason?: string;
  supersedes: string | null;
  expires: string | null;
  tags: string[];
}

// v0.3b: "retired" joins forgotten/reverted here — it's a terminal,
// non-live status (see schemas/provenance.ts's MemoryStatus comment), so a
// bare recall should not surface it by default any more than a forgotten or
// reverted memory.
const EXCLUDED_BY_DEFAULT = new Set(["forgotten", "reverted", "retired"]);

/**
 * Journal-indexed recall (design §recall). Queries memories via
 * `journal.queryMemories`, attaches tags, and "touches" (updates
 * last_referenced on) every memory returned — recall counts as a reference,
 * which staleness/promotion rules key off of.
 *
 * When the caller does not explicitly filter on `status`, forgotten,
 * reverted, and retired memories are excluded by default (they're
 * tombstoned, not something an agent should stumble back into via a bare
 * recall). An explicit `status: "forgotten"` (or "reverted"/"retired")
 * filter is honored as-is.
 */
export function recall(
  journal: Journal,
  filters: RecallFilters,
  now: () => string,
): RecallResult[] {
  const rows = journal.queryMemories(filters);
  const filtered =
    filters.status === undefined
      ? rows.filter((r) => !EXCLUDED_BY_DEFAULT.has(r.status))
      : rows;

  const nowIso = now();
  const results: RecallResult[] = [];
  for (const row of filtered) {
    journal.touchMemory(row.id, nowIso);
    results.push({
      id: row.id,
      path: row.path,
      entity: row.entity,
      status: row.status,
      confidence: row.confidence,
      created: row.created,
      source: row.source,
      supersedes: row.supersedes,
      expires: row.expires,
      tags: journal.getTags(row.id),
    });
  }
  return results;
}
