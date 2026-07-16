import { readFileSync } from "node:fs";
import matter from "gray-matter";
import type { Journal, QueryMemoriesFilters } from "../journal/journal.js";
import type { PermissionsManifest } from "../schemas/manifest.js";
import { assertContainedAndReadable } from "../broker/containment.js";
import { resolveZone } from "../zones.js";

export type RecallFilters = QueryMemoriesFilters;

/** Per-memory content byte cap (§2.4). A belief needing more than this is a
 * document, not a belief — truncate and let the agent open the note. */
const CONTENT_MAX_BYTES = 4096;
/** Total-response content byte budget (§2.4). ~8 full-size memories' worth;
 * exhausting it omits the least-authoritative content first. */
const CONTENT_TOTAL_BUDGET_BYTES = 32768;

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
  /** Frontmatter-stripped note body — present only on a content-reading recall
   * (opts.vaultRoot supplied). `null` when the body could not be attached. */
  content?: string | null;
  /** Why `content` is what it is — present only on a content-reading recall.
   * See spec §2.3. */
  contentState?: "full" | "truncated" | "missing" | "omitted";
}

/** Truncate `s` to at most `capBytes` UTF-8 bytes WITHOUT splitting a multibyte
 * character. A naive Buffer.subarray().toString() yields U+FFFD at a split; this
 * backs off trailing UTF-8 continuation bytes (0x80–0xBF) so the cut lands on a
 * char boundary at or below capBytes. */
export function byteSafeTruncate(s: string, capBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= capBytes) return { text: s, truncated: false };
  let end = capBytes;
  while (end > 0) {
    const b = buf[end];
    if (b === undefined || (b & 0xc0) !== 0x80) break;
    end--;
  }
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

/** Content-budget priority: canonical > working > everything else. Lower = higher. */
export function authorityRank(status: string): number {
  if (status === "canonical") return 0;
  if (status === "working") return 1;
  return 2;
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
  opts?: { vaultRoot?: string; contentCap?: number; contentBudget?: number },
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

  if (opts?.vaultRoot) {
    const vaultRoot = opts.vaultRoot;
    const cap = opts.contentCap ?? CONTENT_MAX_BYTES;
    const budget = opts.contentBudget ?? CONTENT_TOTAL_BUDGET_BYTES;
    // Decide content in AUTHORITY order (canonical>working>rest; then created
    // DESC; then id) — NOT the returned created-DESC order — so the budget
    // sheds least-authoritative content first (spec §2.4).
    const authorityOrder = [...filtered].sort(
      (a, b) =>
        authorityRank(a.status) - authorityRank(b.status) ||
        b.created.localeCompare(a.created) ||
        a.id.localeCompare(b.id),
    );
    const decision = new Map<string, { content: string | null; state: RecallResult["contentState"] }>();
    let spent = 0;
    let omitMode = false; // first-overflow-stops: once true, everything after is omitted, UNREAD
    for (const row of authorityOrder) {
      if (omitMode) {
        decision.set(row.id, { content: null, state: "omitted" }); // budget beats missing: no read
        continue;
      }
      let body: string;
      try {
        const abs = assertContainedAndReadable(vaultRoot, manifest, row.path);
        body = matter(readFileSync(abs, "utf8")).content.trim();
      } catch {
        decision.set(row.id, { content: null, state: "missing" }); // absent/unreadable/parse-fail — degrade
        continue;
      }
      const { text, truncated } = byteSafeTruncate(body, cap);
      const bytes = Buffer.byteLength(text, "utf8");
      if (spent + bytes > budget) {
        decision.set(row.id, { content: null, state: "omitted" }); // boundary; stop here
        omitMode = true;
        continue;
      }
      spent += bytes;
      decision.set(row.id, { content: text, state: truncated ? "truncated" : "full" });
    }
    for (const r of results) {
      const d = decision.get(r.id);
      if (d) {
        r.content = d.content;
        r.contentState = d.state;
      }
    }
  }
  return results;
}
