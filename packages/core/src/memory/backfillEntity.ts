import { basename } from "node:path";
import { readFileSync } from "node:fs";
import matter from "gray-matter";
import { createPatch } from "diff";
import type { Broker } from "../broker/broker.js";
import { assertContainedAndReadable } from "../broker/containment.js";
import { hashFile } from "../broker/hash.js";
import type { Journal } from "../journal/journal.js";
import type { PermissionsManifest } from "../schemas/manifest.js";

// v0.1 has no pagination need for a one-shot maintenance backfill — a single
// generously-sized LIMIT keeps this a plain queryMemories call instead of a
// paging loop (mirrors ttl.ts's SWEEP_QUERY_LIMIT / conflicts.ts's
// RESCAN_MEMORY_CAP).
const BACKFILL_QUERY_LIMIT = 1_000_000;

export interface BackfillEntityDeps {
  broker: Broker;
  journal: Journal;
  /** Absolute path to the vault root (needed to read + hashFile each note). */
  vaultRoot: string;
  /** The vault's current permissions manifest — the per-note read below is
   * gated through `assertContainedAndReadable` (containment + excluded-zone)
   * rather than a raw `readFileSync(join(...))`. Defense-in-depth: this is a
   * human-run maintenance command today, but its `fileEntity` result reaches
   * CLI output for a mismatched note, so an excluded note's frontmatter
   * entity would otherwise be readable/printable — gate it so a future
   * automation wrapper can't turn that into an agent-reachable disclosure. */
  manifest: PermissionsManifest;
  now: () => string;
  genId: (prefix: string) => string;
}

export interface BackfillEntityOptions {
  reason?: string;
  session?: string;
}

/** A note whose FILE entity differs from its JOURNAL row's entity. Recorded
 * for a human to act on — the backfill deliberately does NOT overwrite
 * either side here (see `backfillEntity`'s doc comment). */
export interface BackfillEntityMismatch {
  path: string;
  fileEntity: string | null;
  journalEntity: string;
}

/** A memory the backfill could not process (missing/unreadable/corrupt
 * file, or a failed write) — non-fatal; recorded so the run can continue. */
export interface BackfillEntityError {
  path: string;
  reason: string;
}

export interface BackfillEntityResult {
  /** Notes whose file had NO top-level entity and now do (journal's entity
   * was written into the file via an approved revise). */
  backfilled: number;
  /** Notes whose file entity already equaled the journal's — already
   * self-describing; left untouched. */
  skipped: number;
  /** Notes whose file entity DIFFERED from the journal's — a drift or
   * forgery-era residue surfaced for a human, not silently resolved either
   * way. */
  mismatched: BackfillEntityMismatch[];
  /** Notes that could not be processed at all (see `BackfillEntityError`). */
  errors: BackfillEntityError[];
}

/**
 * One-shot maintenance command (design v0.3a §9 residual): `remember()` now
 * writes `entity` into a note's TOP-LEVEL frontmatter, and an INCREMENTAL
 * reindex preserves a journal-only entity onto an already-existing row (see
 * reindex.ts's `upsertMemory` entity-durability fallback) — but neither of
 * those helps a PRE-FIX legacy note survive a FULL rebuild from an EMPTY
 * journal: the file never had `entity` written into it, so there is nothing
 * on disk to recover, and the note silently drops out of every same-entity
 * contradiction comparison set. This walks every journal row that has a
 * known entity, reads the note's current on-disk entity, and three-way
 * branches:
 *
 *  - file has none, journal has one  -> BACKFILL (write it into the file).
 *  - file equals journal             -> SKIP (already self-describing).
 *  - file differs from journal       -> MISMATCH (recorded, NOT overwritten
 *    either direction — a human should see this, not have it silently
 *    resolved by whichever side happened to run this command).
 *
 * A memory whose file is missing/unreadable/corrupt is recorded in `errors`
 * and the run continues — one bad note must not abort the whole backfill
 * (mirrors reindex's `skipped` / sweep's `failed` non-fatal-continue shape).
 *
 * The write itself MIRRORS `MemoryStore`'s private `flipFrontmatterStatus`
 * exactly: read the file's current bytes, compute the after-content via
 * `matter.stringify` (here adding/setting the top-level `entity` key rather
 * than `ledger.status`), `createPatch`, and dispatch through
 * `broker.apply({op:"revise",...}, {approved:true})`. `{approved:true}` is
 * REQUIRED — `entity` is a governed provenance field (see
 * `governedProvenanceChanged` in broker/lint.ts), so an unapproved revise
 * touching it would be rejected by the ledger-guard — and it also triggers
 * the broker's pre-image baseline commit for any still-untracked note
 * (broker.ts's `applyRevise` DATA-LOSS GUARD), same as every other
 * provenance-writing path in this codebase.
 */
export async function backfillEntity(
  deps: BackfillEntityDeps,
  opts: BackfillEntityOptions = {},
): Promise<BackfillEntityResult> {
  const { broker, journal, vaultRoot, manifest } = deps;
  const reason = opts.reason ?? "backfill-entity";
  const session = opts.session ?? "backfill-entity";

  let backfilled = 0;
  let skipped = 0;
  const mismatched: BackfillEntityMismatch[] = [];
  const errors: BackfillEntityError[] = [];

  const rows = journal.queryMemories({ limit: BACKFILL_QUERY_LIMIT });
  for (const mem of rows) {
    if (mem.entity == null) continue; // nothing in the journal to backfill from

    // Gate through the shared containment/zone boundary (not a raw
    // readFileSync(join(...))): an excluded/traversal path is refused here
    // and recorded as an error, so its content is never read into memory or
    // surfaced. `assertContainedAndReadable` returns the same verified
    // absolute path hashFile uses below on the backfill branch.
    let abs: string;
    let raw: string;
    let parsed: ReturnType<typeof matter>;
    try {
      abs = assertContainedAndReadable(vaultRoot, manifest, mem.path);
      raw = readFileSync(abs, "utf8");
      parsed = matter(raw);
    } catch (e) {
      errors.push({ path: mem.path, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }

    const rawEntity = (parsed.data as Record<string, unknown>).entity;
    const fileEntity = typeof rawEntity === "string" ? rawEntity : null;

    if (fileEntity === mem.entity) {
      skipped += 1;
      continue;
    }

    if (fileEntity !== null) {
      // File and journal both have an entity, but they disagree. Do NOT
      // silently overwrite either side -- this divergence (drift, or
      // forgery-era residue) is exactly what a human should see, and this
      // backfill run is the one moment it's visible.
      mismatched.push({ path: mem.path, fileEntity, journalEntity: mem.entity });
      continue;
    }

    // fileEntity === null, journal has one -> BACKFILL.
    // NOTE (source-linked staleness): this approved revise adds only a top-level
    // `entity` — which `extract()` deliberately does NOT treat as a body fact
    // (see extract.ts) — so it changes no facts and correctly triggers no
    // staleness flag even though it doesn't run the hook. (It is also a
    // human-run maintenance command writing the already-authoritative journal
    // entity, never agent-reachable.)
    try {
      const after = matter.stringify(parsed.content, {
        ...parsed.data,
        entity: mem.entity,
      });
      const patch = createPatch(basename(mem.path), raw, after);
      const result = await broker.apply(
        {
          op: "revise",
          path: mem.path,
          expected_hash: hashFile(abs),
          patch,
          entity: mem.entity,
          reason,
          session,
        },
        { approved: true },
      );
      if (!("queued" in result) && result.txnId !== undefined) {
        journal.setTransactionMemoryId(result.txnId, mem.id);
      }
      backfilled += 1;
    } catch (e) {
      errors.push({ path: mem.path, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  return { backfilled, skipped, mismatched, errors };
}
