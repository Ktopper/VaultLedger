import { hashBytes } from "../broker/hash.js";

/**
 * Deterministic hash of a conflict's `detail` string — the single source of
 * truth for the `value_hash` folded into the `conflicts` table's unique
 * dedup key (pair_lo, pair_hi, kind, fact_key, value_hash; see
 * journal/db.ts). Used by BOTH the live check.ts insert path AND the
 * migration backfill (journal/db.ts's migrateConflictsValueHash), so the two
 * can never drift: a migrated legacy row and a freshly re-detected identical
 * conflict hash to the SAME value by construction, which is what makes a
 * dismissed conflict survive re-detection instead of being resurrected.
 *
 * `detail` is exactly "what makes this contradiction specific" — for a
 * value-conflict it embeds the fact_key plus BOTH conflicting values
 * (`deadline: "2026-08-15" vs "2026-09-01"`); for a negation-conflict it
 * embeds the contradicted statement. So folding hash(detail) into the unique
 * key gives the desired behavior: a DIFFERENT value/statement produces a
 * different `detail`, hence a different hash and a new (separately
 * dismissable) row; the SAME contradiction re-detected (from either
 * direction — `detail` is already built in id-sorted order by check.ts)
 * produces the identical `detail` and dedups to one row.
 *
 * Null/empty `detail` is coerced to "" (mirroring the migration's own
 * `detail ?? ""`), so a row with no detail still gets a stable, non-null
 * hash rather than violating the value_hash NOT NULL invariant.
 */
export function conflictValueHash(detail: string | null): string {
  return hashBytes(Buffer.from(detail ?? "", "utf8"));
}
