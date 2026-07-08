import { hashBytes } from "../broker/hash.js";
import type { ConflictKind } from "./detector.js";

// Separator between the two sorted values before hashing. A control
// character (NUL) rather than a printable one (e.g. a plain space) so two
// distinct value pairs that only differ in where a shared substring is
// split (e.g. "ab"+"c" vs "a"+"bc") can never collide into the same hash
// input — real fact values/statements essentially never contain NUL.
const SEPARATOR = "\u0000";

/**
 * Deterministic, order-normalized hash of the two conflicting sides of a
 * detected conflict — folded into the `conflicts` table's unique dedup key
 * (pair_lo, pair_hi, kind, fact_key, value_hash; see journal/db.ts) so that
 * dismissing one conflict on a given pair+fact does NOT swallow a later,
 * genuinely different-valued contradiction on that same pair+fact: without
 * this, the old 4-column key (pair_lo, pair_hi, kind, fact_key) omitted the
 * values entirely, so the new row collided on INSERT ... ON CONFLICT DO
 * NOTHING against the dismissed row and was silently dropped.
 *
 * `aValue`/`bValue` are:
 *  - value-conflict: the two canonicalized fact values (display strings).
 *  - negation-conflict: the two folded statements (subject+negation+object).
 *
 * Order-normalized (the pair is sorted before hashing) so A-vs-B and B-vs-A
 * produce the SAME hash — mirroring the existing pair_lo/pair_hi
 * normalization, so re-detecting the identical contradiction from either
 * direction still dedups to one row instead of spawning a duplicate.
 *
 * `kind` is taken as a parameter (rather than folded implicitly into the
 * hashed bytes) purely for future-proofing/documentation at call sites; the
 * hash itself only needs to distinguish VALUE pairs, since `kind` and
 * `fact_key` are already separate columns in the unique key.
 */
export function conflictValueHash(_kind: ConflictKind, aValue: string, bValue: string): string {
  const [lo, hi] = [aValue, bValue].sort();
  return hashBytes(Buffer.from(`${lo}${SEPARATOR}${hi}`, "utf8"));
}
