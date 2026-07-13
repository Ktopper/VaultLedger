import type { Journal, QueryMemoriesFilters } from "../journal/journal.js";
import type { PermissionsManifest } from "../schemas/manifest.js";
import { resolveZone } from "../zones.js";

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
 *
 * Defense-in-depth zone re-check (VL-SEC-S7-05): the journal is SUPPOSED to
 * be zone-clean by construction — every producer (reindex, MemoryStore's
 * remember/distill) zone-gates before it upserts a row. This function does
 * not trust that invariant blindly: it re-resolves each row's `path`
 * against the manifest and filters out (logging as an integrity violation)
 * any row that now resolves to `excluded`. This is the SECOND, independent
 * gate — it exists to catch a future producer regression before an
 * excluded-zone note's path/metadata ever reaches an agent via
 * `memory_recall`/`GET /memories`, not to replace the producer-side gate.
 */
export function recall(
  journal: Journal,
  filters: RecallFilters,
  now: () => string,
  manifest: PermissionsManifest,
): RecallResult[] {
  const rows = journal.queryMemories(filters);
  const statusFiltered =
    filters.status === undefined
      ? rows.filter((r) => !EXCLUDED_BY_DEFAULT.has(r.status))
      : rows;

  const filtered = statusFiltered.filter((r) => {
    if (resolveZone(r.path, manifest) !== "excluded") return true;
    // Should never happen if every producer is correctly zone-gated — its
    // appearance here means a producer regressed, so this is logged loudly
    // (not silently swallowed) rather than just filtered.
    console.error(
      `recall: integrity violation — memory ${r.id} at ${r.path} resolves to the excluded ` +
        "zone; filtered out (a producer failed to zone-gate it before indexing)",
    );
    return false;
  });

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
