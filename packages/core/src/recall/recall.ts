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

const EXCLUDED_BY_DEFAULT = new Set(["forgotten", "reverted"]);

/**
 * Journal-indexed recall (design §recall). Queries memories via
 * `journal.queryMemories`, attaches tags, and "touches" (updates
 * last_referenced on) every memory returned — recall counts as a reference,
 * which staleness/promotion rules key off of.
 *
 * When the caller does not explicitly filter on `status`, forgotten and
 * reverted memories are excluded by default (they're tombstoned, not
 * something an agent should stumble back into via a bare recall). An
 * explicit `status: "forgotten"` (or "reverted") filter is honored as-is.
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
