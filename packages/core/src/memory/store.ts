import { basename, join } from "node:path";
import { readFileSync } from "node:fs";
import matter from "gray-matter";
import { createPatch } from "diff";
import type { z } from "zod";
import { Broker } from "../broker/broker.js";
import { hashFile } from "../broker/hash.js";
import { BrokerError } from "../errors.js";
import { checkContradictions } from "../contradiction/check.js";
import { checkSourceStaleness, flagCitingDistillations } from "../contradiction/staleness.js";
import type { Journal, MemoryRow } from "../journal/journal.js";
import type { PermissionsManifest } from "../schemas/manifest.js";
import type { Confidence, MemoryStatus } from "../schemas/provenance.js";

type ConfidenceValue = z.infer<typeof Confidence>;
type MemoryStatusValue = z.infer<typeof MemoryStatus>;

const DEFAULT_AGENT_DIR = "Agent/Memory";
const ARCHIVE_DIR = "Agent/Archive";

/**
 * The lineage-citable status allowlist, shared by `distill` (validating its
 * `sources`) and `retire` (validating its `superseded_by`). A memory is
 * citable iff its status is in here: `forgotten` (tombstoned to
 * Agent/Archive) and `reverted` (an undone create — its FILE is DELETED from
 * the vault, only the journal row survives) are BOTH excluded because a
 * lineage pointer must never reference content that no longer exists in the
 * vault. `retired` stays allowed — retiring is a metadata flip that leaves
 * the file in place, so a live-or-retired target is a valid citation. Kept as
 * ONE constant so the two validators can never drift apart (they did once:
 * retire's original one-status denylist accepted `reverted`, a dangling
 * pointer to deleted content).
 */
const CITABLE_SOURCE_STATUSES = ["scratch", "working", "canonical", "retired"] as const;

export interface MemoryStoreOptions {
  broker: Broker;
  journal: Journal;
  now: () => string;
  genId: (prefix: string) => string;
  /** Absolute path to the vault root (needed to hashFile the current note). */
  vaultRoot: string;
  /** The vault's current permissions manifest (VL-SEC-S3-01/S7-02) — threaded
   * straight into every `checkContradictions` call this store makes
   * (remember/distill/revise), which requires it to containment/zone-gate
   * the memory-file reads it performs post-commit. */
  manifest: PermissionsManifest;
  /** Vault-relative directory new memory notes are created under. */
  agentDir?: string;
}

export interface RememberInput {
  content: string;
  entity?: string;
  reason: string;
  session: string;
  tags?: string[];
  confidence?: ConfidenceValue;
  /**
   * Id of the memory this new one supersedes (an updated belief on the same
   * entity). Wired into BOTH the file's `ledger.supersedes` frontmatter and
   * the journal `memories.supersedes` column, which is what the
   * contradiction matcher's lineage exclusion (contradiction/matcher.ts)
   * reads to exclude this pair from comparison — the single biggest
   * false-positive guard only fires if a caller actually sets this. No hard
   * validation: if it points at a nonexistent id, the matcher simply won't
   * find it in the same-entity set (harmless).
   */
  supersedes?: string;
  /**
   * Optional numeric evidence (e.g. a confidence/relevance score from
   * whatever produced this memory) recorded verbatim into the file's
   * `ledger.score`. Guarded like every other `ledger:` field
   * (governedProvenanceChanged rejects an unapproved revise that adds or
   * changes it — see broker/lint.ts) but otherwise INERT: no promotion,
   * gate, or transition in this file reads `score`. It is evidence for a
   * human or a future policy to consult, never a live gate input — see the
   * mirrored field on `DistillInput` for the sibling write path.
   */
  score?: number;
}

export interface RememberResult {
  id: string;
  path: string;
  /** The create transaction's id, linked to this memory (for undo/audit). */
  txnId: string;
}

export interface DistillInput {
  content: string;
  /** Ids of the memories this distillation is derived from. Every id must
   * name an EXISTING memory whose status is not `forgotten` (a `retired`
   * source IS allowed — retiring a memory means "superseded, don't cite it
   * as current truth", not "erased", and distillation is exactly the
   * mechanism that supersedes it). Must be non-empty: a distillation with no
   * sources is indistinguishable from a plain `remember` and would create an
   * uncited "derived" note, defeating the point of the derivation record. */
  sources: string[];
  reason: string;
  session: string;
  entity?: string;
  confidence?: ConfidenceValue;
  score?: number;
}

/** Mirrors `RememberResult` exactly — a distillation IS a memory note, just
 * one with a `derivation` block and relation edges alongside it. */
export interface DistillResult {
  id: string;
  path: string;
  /** The create transaction's id, linked to this memory (for undo/audit). */
  txnId: string;
}

export interface ReviseInput {
  id: string;
  patch: string;
  reason: string;
  session: string;
}

export interface ReviseOptions {
  /** Bypass the canonical-revise approval gate (set by Approvals.approve's
   * dispatchApply when applying a previously-held revise via
   * broker.apply(op, {approved:true}) -- see the EXECUTION CONTRACT note on
   * `revise()` below). Harmless on scratch/working memories, which never hit
   * the gate anyway. */
  approved?: boolean;
}

/**
 * Discriminated union (mirrors `ForgetResult`): a scratch/working revise (or
 * an approved canonical one) lands immediately and returns
 * `{ revised: true, id }`; an unapproved canonical revise is held for
 * approval and returns `{ queued: true, approvalId }` instead of patching
 * anything.
 */
export type ReviseResult = { revised: true; id: string } | { queued: true; approvalId: string };

export interface PromoteInput {
  id: string;
  target_status: MemoryStatusValue;
  reason: string;
  session: string;
}

export interface PromoteResult {
  promoted: boolean;
  approvalId?: string;
}

export interface ForgetInput {
  id: string;
  reason: string;
  session: string;
}

export interface ForgetOptions {
  /** Bypass the canonical-forget approval gate (set by Approvals.approve when
   * applying a previously-held forget). Harmless on scratch/working memories,
   * which never hit the gate anyway. */
  approved?: boolean;
}

/**
 * Discriminated union (mirrors `PromoteResult`'s applied-vs-queued split):
 * a scratch/working forget (or an approved canonical one) lands immediately
 * and returns `{ forgotten: true, id }`; an unapproved canonical forget is
 * held for approval and returns `{ queued: true, approvalId }` instead of
 * archiving anything.
 */
export type ForgetResult = { forgotten: true; id: string } | { queued: true; approvalId: string };

export interface RetireInput {
  id: string;
  reason: string;
  /**
   * Id of the memory that supersedes this one going forward. OPTIONAL —
   * a retire with no successor is still a valid "no longer current, no
   * replacement yet" state. When provided it must reference an EXISTING
   * memory whose status is CITABLE (not `forgotten`, not `reverted` — both
   * mean the content is gone from the vault; a `retired` or live target is
   * fine, since you can be superseded by a historical belief). Validated
   * BEFORE any write or enqueue (an unvalidated pointer is a forgeable
   * lineage claim, same family as `distill`'s source validation, and shares
   * its `CITABLE_SOURCE_STATUSES` allowlist).
   */
  superseded_by?: string;
  session: string;
}

export interface RetireOptions {
  /** Bypass the canonical-retire approval gate (set by Approvals.approve when
   * applying a previously-held retire). Harmless on working memories, which
   * never hit the gate anyway. */
  approved?: boolean;
}

/**
 * Discriminated union (mirrors `ForgetResult` exactly): a working retire (or
 * an approved canonical one) lands immediately and returns
 * `{ retired: true, id }`; an unapproved canonical retire is held for
 * approval and returns `{ queued: true, approvalId }` instead of patching
 * anything.
 */
export type RetireResult = { retired: true; id: string } | { queued: true; approvalId: string };

/**
 * Memory lifecycle on top of the Broker (design §memory lifecycle). Every
 * mutation still routes through the broker (or `broker.archive`) so the
 * zone/hash/patch-safety gates from Phase 2 apply uniformly to memory notes;
 * this class is only responsible for the memory-specific bookkeeping (the
 * `memories` journal table + gray-matter provenance frontmatter) that sits
 * on top of that.
 */
export class MemoryStore {
  private readonly broker: Broker;
  private readonly journal: Journal;
  private readonly now: () => string;
  private readonly genId: (prefix: string) => string;
  private readonly vaultRoot: string;
  private readonly manifest: PermissionsManifest;
  private readonly agentDir: string;

  constructor(opts: MemoryStoreOptions) {
    this.broker = opts.broker;
    this.journal = opts.journal;
    this.now = opts.now;
    this.genId = opts.genId;
    this.vaultRoot = opts.vaultRoot;
    this.manifest = opts.manifest;
    this.agentDir = opts.agentDir ?? DEFAULT_AGENT_DIR;
  }

  async remember(input: RememberInput): Promise<RememberResult> {
    const id = this.genId("mem");
    const path = `${this.agentDir}/${id}.md`;
    const created = this.now();
    const supersedes = input.supersedes ?? null;

    // Neutralize a smuggled leading frontmatter block: `matter.stringify`
    // MERGES a `---...---` block at the START of `content` into the emitted
    // frontmatter (verified), so unstripped agent content could inject a forged
    // top-level `entity`/`tags` (or any field) into the note's REAL provenance
    // — the journal row would say entity=null while the file says the forged
    // value, and a reindex would adopt it, poisoning comparison sets (the same
    // detonate-on-reindex class as the ledger-guard). Provenance is set ONLY by
    // the store (the ledger block) and the trusted entity/tags params, never by
    // body text. `matter(content).content` drops a leading block; on malformed
    // YAML (matter throws) we prefix a newline so `stringify` can't treat the
    // `---` as frontmatter (a block must sit at byte 0).
    let body: string;
    try {
      body = matter(input.content).content;
    } catch {
      body = input.content.startsWith("---") ? `\n${input.content}` : input.content;
    }

    // Persist `entity` and `tags` as TOP-LEVEL frontmatter (siblings of
    // `ledger:`), not only to the journal. reindex recovers them FROM the file
    // (parseMemoryNote reads data.entity / data.tags); if they lived only in
    // the journal, a plain journal rebuild would null every agent-created
    // memory's entity, silently emptying every same-entity contradiction
    // comparison set (detection off vault-wide, no adversary required). `entity`
    // is a governed field — the ledger-guard (governedProvenanceChanged) blocks
    // unapproved edits of it once it is file-resident.
    const frontmatter: Record<string, unknown> = {
      ledger: {
        id,
        status: "scratch",
        created,
        source: input.session,
        reason: input.reason,
        confidence: input.confidence ?? "medium",
        supersedes,
        expires: null,
        ...(input.score !== undefined ? { score: input.score } : {}),
      },
    };
    if (typeof input.entity === "string") {
      frontmatter.entity = input.entity;
    }
    if (Array.isArray(input.tags) && input.tags.length > 0) {
      frontmatter.tags = input.tags;
    }
    const noteBody = matter.stringify(body, frontmatter);

    const result = await this.broker.apply({
      op: "create",
      path,
      content: noteBody,
      entity: input.entity,
      tags: input.tags,
      reason: input.reason,
      session: input.session,
    });
    // create always lands immediately (never queued), so a txnId is present.
    if ("queued" in result || result.txnId === undefined) {
      throw new BrokerError("NOT_FOUND", `create did not record a transaction for ${path}`);
    }
    const txnId = result.txnId;

    const row: MemoryRow = {
      id,
      path,
      entity: input.entity ?? null,
      status: "scratch",
      confidence: input.confidence ?? "medium",
      created,
      source: input.session,
      supersedes,
      expires: null,
      last_referenced: null,
    };
    this.journal.insertMemory(row);
    if (input.tags && input.tags.length > 0) {
      this.journal.addTags(id, input.tags);
    }
    // Link the create transaction to this memory so undo can reach the memory
    // row (mark it 'reverted') and listTransactions({entity}) can join.
    this.journal.setTransactionMemoryId(txnId, id);

    // Post-commit, non-blocking contradiction check (design v0.3a §5): runs
    // AFTER the write is fully committed (broker + journal), never before —
    // it reads the just-written file back off disk. Lock-free and
    // self-swallowing; see checkContradictions' own doc comment.
    checkContradictions(
      {
        journal: this.journal,
        vaultRoot: this.vaultRoot,
        manifest: this.manifest,
        now: this.now,
        genId: this.genId,
      },
      id,
    );

    return { id, path, txnId };
  }

  /**
   * Create a DISTILLATION: a memory note derived from other memories,
   * mirroring `remember` (same leading-frontmatter strip, same top-level
   * entity/tags handling, same `broker.apply({op:"create", ...})` create
   * path) but with two additions: (1) every cited source is validated BEFORE
   * any write, and (2) the note's `ledger:` block carries a `derivation`
   * record and a `memory_relations` edge is inserted per source.
   *
   * `distill` is NOT a raw broker op — like `promote`/`forget`, `broker.apply`
   * rejects it outright (op.op === "distill" hits the same reject arm); this
   * store method is what resolves it into the underlying `create`.
   */
  async distill(input: DistillInput): Promise<DistillResult> {
    // Dedupe source ids up front (order-preserving) so the FILE's
    // `derivation.sources` array and the memory_relations edge set can never
    // desync: insertRelation is ON CONFLICT DO NOTHING (one edge per unique
    // source), so an un-deduped `[a, a]` would write a 2-element frontmatter
    // array but only 1 edge. Dedupe once here and use `sources` everywhere
    // below.
    const sources = [...new Set(input.sources)];

    // Validate sources BEFORE any write (design: a bad citation must never
    // produce a half-written note or a dangling memory_relations row).
    // Empty sources is rejected too: a distillation with nothing to cite is
    // just a remember wearing a derivation label.
    if (sources.length === 0) {
      throw new BrokerError(
        "INVALID_SOURCE",
        "a distillation must cite at least one source",
        false,
      );
    }
    // A source is citable iff its status is in the shared
    // CITABLE_SOURCE_STATUSES allowlist (see its doc comment): both
    // `forgotten` and `reverted` are excluded because a distillation must not
    // cite content that no longer exists in the vault. `retired` stays
    // allowed: distillation is exactly the mechanism that supersedes a
    // retired belief, so citing its own retired inputs is the expected shape.
    for (const sourceId of sources) {
      const source = this.journal.getMemory(sourceId);
      if (!source) {
        throw new BrokerError(
          "INVALID_SOURCE",
          `distill source not found: ${sourceId}`,
          false,
        );
      }
      if (!CITABLE_SOURCE_STATUSES.includes(source.status as (typeof CITABLE_SOURCE_STATUSES)[number])) {
        throw new BrokerError(
          "INVALID_SOURCE",
          `distill source '${sourceId}' has non-citable status '${source.status}' ` +
            `(citable: ${CITABLE_SOURCE_STATUSES.join(", ")})`,
          false,
        );
      }
    }

    const id = this.genId("mem");
    const path = `${this.agentDir}/${id}.md`;
    const created = this.now();

    // Neutralize a smuggled leading frontmatter block — see the matching
    // comment in `remember` for the full rationale (matter.stringify would
    // otherwise merge a `---...---` block at the START of `content` into the
    // emitted frontmatter, letting body text forge provenance).
    let body: string;
    try {
      body = matter(input.content).content;
    } catch {
      body = input.content.startsWith("---") ? `\n${input.content}` : input.content;
    }

    const frontmatter: Record<string, unknown> = {
      ledger: {
        id,
        status: "scratch",
        created,
        source: input.session,
        reason: input.reason,
        confidence: input.confidence ?? "medium",
        supersedes: null,
        expires: null,
        derivation: { kind: "distilled", sources },
        ...(input.score !== undefined ? { score: input.score } : {}),
      },
    };
    if (typeof input.entity === "string") {
      frontmatter.entity = input.entity;
    }
    const noteBody = matter.stringify(body, frontmatter);

    const result = await this.broker.apply({
      op: "create",
      path,
      content: noteBody,
      entity: input.entity,
      reason: input.reason,
      session: input.session,
    });
    // create always lands immediately (never queued), so a txnId is present.
    if ("queued" in result || result.txnId === undefined) {
      throw new BrokerError("NOT_FOUND", `create did not record a transaction for ${path}`);
    }
    const txnId = result.txnId;

    const row: MemoryRow = {
      id,
      path,
      entity: input.entity ?? null,
      status: "scratch",
      confidence: input.confidence ?? "medium",
      created,
      source: input.session,
      supersedes: null,
      expires: null,
      last_referenced: null,
    };
    this.journal.insertMemory(row);
    this.journal.setTransactionMemoryId(txnId, id);

    // CRASH GAP (same shape as the v0.1 commit->journal gap documented on
    // `remember`): the note is committed to disk/git by `broker.apply` above
    // BEFORE these relation rows are inserted. A crash between the create
    // commit and this loop leaves the note on disk (WITH its `derivation`
    // block already naming its sources) but zero `memory_relations` rows.
    // This self-heals: reindex rebuilds a memory's relations from its file's
    // `ledger.derivation.sources` (v0.3b reindex change), so the edges
    // reappear on the next reindex rather than staying permanently dangling.
    for (const sourceId of sources) {
      this.journal.insertRelation({ memory_id: id, source_id: sourceId, kind: "distilled" });
    }

    // Post-commit, non-blocking contradiction check (design v0.3a §5) — see
    // the matching call in `remember` for rationale.
    checkContradictions(
      {
        journal: this.journal,
        vaultRoot: this.vaultRoot,
        manifest: this.manifest,
        now: this.now,
        genId: this.genId,
      },
      id,
    );

    return { id, path, txnId };
  }

  /**
   * Route a content patch through the broker with a correct expected_hash
   * computed from the note's current on-disk bytes. This is the mutation;
   * bumping the in-file `ledger:` provenance block (e.g. a new `created` or
   * `supersedes`) is the caller's responsibility via the patch itself in
   * v0.1 — the store does not parse/rewrite frontmatter on revise.
   *
   * CANONICAL GATE (v0.3a, mirrors `promote`/`forget`): a content revise of
   * a CANONICAL belief is held for human approval instead of applying
   * immediately. Rationale — the ledger-guard (governedProvenanceChanged)
   * already blocks an unapproved revise from touching the `ledger:` block or
   * top-level `entity`, but says nothing about the note BODY: an agent could
   * still invert a canonical belief's content across 2-3 unapproved revises
   * (the ~50% patch-size cap is iterable). Gating canonical content-revises
   * closes that hole. Scratch/working stay immediate — those are provisional
   * beliefs; gating them would put approvals on the agent's normal
   * course-correction loop, the fatigue the zone model is built to avoid.
   *
   * LOAD-BEARING CONSEQUENCE: an APPROVED canonical-revise dispatches via
   * `broker.apply(op, {approved:true})` (see Approvals.approve's `revise`
   * case), which — by design — BYPASSES the ledger-guard too. That means the
   * approval diff is the human's ONE chance to catch a status/entity change
   * smuggled into what looks like a content-only revise. The approval
   * renderer (`renderApprovalDiff`) showing the FULL diff is what makes this
   * acceptable — that diff must NEVER be summarized or truncated in a way
   * that could hide a smuggled provenance change.
   *
   * EXECUTION CONTRACT: the held op below is a plain `{op:"revise",...}` —
   * unlike `promote`/`forget`, `revise` IS a path-based broker op, so
   * `Approvals.approve()` does NOT need a new case for it: the existing
   * `case "revise": return this.dispatchApply(id, op)` already re-dispatches
   * the held op straight to `Broker.apply(op, {approved:true})`, which both
   * applies the patch and (intentionally) bypasses the ledger-guard per the
   * note above.
   */
  async revise(input: ReviseInput, opts?: ReviseOptions): Promise<ReviseResult> {
    const mem = this.journal.getMemory(input.id);
    if (!mem) {
      throw new BrokerError("NOT_FOUND", `no memory with id ${input.id}`);
    }

    const expectedHash = hashFile(join(this.vaultRoot, mem.path));

    if (mem.status === "canonical" && !opts?.approved) {
      const approvalId = this.genId("apr");
      this.journal.insertApproval({
        id: approvalId,
        held_operation: JSON.stringify({
          op: "revise",
          path: mem.path,
          expected_hash: expectedHash,
          patch: input.patch,
          entity: mem.entity ?? undefined,
          reason: input.reason,
          session: input.session,
        }),
        zone: "canonical-revise",
        reason: input.reason,
        session: input.session,
        state: "pending",
        created_at: this.now(),
        resolved_at: null,
        stale_reason: null,
      });
      return { queued: true, approvalId };
    }

    // Pre-image for the source-linked staleness fact-diff (design v0.3b-2)
    // -- MUST be read BEFORE broker.apply below mutates the file.
    const beforeContent = readFileSync(join(this.vaultRoot, mem.path), "utf8");

    const result = await this.broker.apply(
      {
        op: "revise",
        path: mem.path,
        expected_hash: expectedHash,
        patch: input.patch,
        entity: mem.entity ?? undefined,
        reason: input.reason,
        session: input.session,
      },
      opts?.approved ? { approved: true } : undefined,
    );
    // A direct revise into an agent-zone note always lands immediately.
    if (!("queued" in result) && result.txnId !== undefined) {
      this.journal.setTransactionMemoryId(result.txnId, input.id);
    }

    // Post-commit, non-blocking contradiction check (design v0.3a §5) — see
    // the matching call in `remember` for rationale. A direct agent-zone
    // revise always lands immediately (broker.apply never queues a revise —
    // only propose_edit re-queues), so by here the patch is committed on disk
    // and the check reads the just-written note.
    checkContradictions(
      {
        journal: this.journal,
        vaultRoot: this.vaultRoot,
        manifest: this.manifest,
        now: this.now,
        genId: this.genId,
      },
      input.id,
    );

    // Post-commit, non-blocking source-linked staleness (design v0.3b-2):
    // the ONE `checkSourceStaleness` helper (contradiction/staleness.ts),
    // wired to BOTH content-changing revise surfaces -- this is the other
    // one being `Approvals.dispatchApply` (the approved-canonical-revise
    // apply path, which never re-enters this method — see this method's
    // EXECUTION CONTRACT doc comment above). Its own cheap guard skips the
    // fact-diff entirely when `input.id` is cited by nobody.
    // The read+hash of the after-content is INSIDE this try so a file-unreadable
    // race in the sub-ms window after the commit can never fail the (already
    // committed) write — the non-blocking contract covers the arg evaluation,
    // not just the helper body.
    try {
      checkSourceStaleness(
        { journal: this.journal, now: this.now, genId: this.genId },
        input.id,
        beforeContent,
        readFileSync(join(this.vaultRoot, mem.path), "utf8"),
      );
    } catch (err) {
      console.error(`revise: source-linked staleness failed for ${input.id}:`, err);
    }

    return { revised: true, id: input.id };
  }

  /**
   * Only two transitions are supported in v0.1: scratch->working (applied
   * immediately; a memory that's been referenced/reasoned about enough to
   * trust) and working->canonical (held for approval; canonical is a
   * high-trust status so promoting into it always goes through the
   * approval queue, same as a trusted-zone edit). Any other transition is
   * rejected with INVALID_TRANSITION rather than silently no-opping.
   */
  async promote(input: PromoteInput): Promise<PromoteResult> {
    const mem = this.journal.getMemory(input.id);
    if (!mem) {
      throw new BrokerError("NOT_FOUND", `no memory with id ${input.id}`);
    }

    if (mem.status === "scratch" && input.target_status === "working") {
      // Durable status (design §6.0): the note's `ledger:` frontmatter is the
      // source of truth for status, so the transition must be written into the
      // FILE (one audited revise commit) — not just the journal — or a reindex
      // after a journal loss would silently revert the promotion.
      await this.setStatus(input.id, "working", input.reason, input.session);
      return { promoted: true };
    }

    if (mem.status === "working" && input.target_status === "canonical") {
      const approvalId = this.genId("apr");
      // EXECUTION CONTRACT FOR WU3b (approve()): the held op below is an
      // op:"promote", which broker.apply() rejects by design (it operates on
      // a memory id, not a path). approve() MUST DISPATCH on the held op — a
      // held `promote` is executed by applying the canonical status change
      // directly (journal.setMemoryStatus(id, "canonical")), NOT via
      // broker.apply. Only create/revise/propose_edit held ops go through
      // broker.apply(op, { approved: true }).
      this.journal.insertApproval({
        id: approvalId,
        held_operation: JSON.stringify({
          op: "promote",
          id: input.id,
          target_status: "canonical",
          reason: input.reason,
          session: input.session,
        }),
        zone: "canonical-promotion",
        reason: input.reason,
        session: input.session,
        state: "pending",
        created_at: this.now(),
        resolved_at: null,
        stale_reason: null,
      });
      return { promoted: false, approvalId };
    }

    throw new BrokerError(
      "INVALID_TRANSITION",
      `unsupported promotion ${mem.status} -> ${input.target_status}; only scratch->working ` +
        `(auto) and working->canonical (approval) are supported in v0.1`,
    );
  }

  /**
   * Archive the memory's file (tombstone) and mark its journal row forgotten
   * — UNLESS the memory is `canonical`, in which case forget is gated behind
   * human approval, mirroring the working->canonical promotion gate in
   * `promote()` (design: canonical-forget evasion closure). Rationale: an
   * agent calling `memory_forget` on a canonical belief is an approval-free
   * way to make it disappear (e.g. to dodge the contradiction matcher's
   * comparison set) — the same evasion class already closed for
   * `supersedes`. Scratch/working forgets stay immediate (provisional
   * beliefs don't need a human gate).
   *
   * Concurrency note (design §12, accepted v0.2 limitation): the APPLIED path
   * is TWO broker calls — `flipFrontmatterStatus` (a locked revise commit)
   * then `broker.archive` (a locked move commit). Each individually acquires
   * and holds the cross-process vault lock, so neither races another
   * process's git/journal writes; but the two are NOT jointly atomic — a
   * concurrent reader can observe the intermediate state (status=forgotten in
   * the file, note not yet moved to Agent/Archive). That intermediate state
   * is transient and self-heals: the next reindex recovers the correct
   * status/path from disk. NOT wrapped in a single outer lock on purpose —
   * the inner broker calls already take the lock and proper-lockfile is
   * non-reentrant, so an outer acquire would deadlock; single-commit atomic
   * forget is left to a future milestone.
   */
  async forget(input: ForgetInput, opts?: ForgetOptions): Promise<ForgetResult> {
    const mem = this.journal.getMemory(input.id);
    if (!mem) {
      throw new BrokerError("NOT_FOUND", `no memory with id ${input.id}`);
    }

    // Idempotent re-apply (mirrors promote's setStatus early-return). If the
    // memory is already forgotten, treat this as a no-op success rather than
    // re-running the tombstone: the second broker.archive would throw
    // TARGET_EXISTS on the already-moved note. This matters for the crash gap
    // in Approvals.approve() — if the process dies after store.forget applied
    // but before the approval was marked 'approved', the approval stays
    // pending and a human re-approves, re-entering here on the now-forgotten
    // memory. Without this guard that re-approve would wedge (throw) and leave
    // the approval stuck pending.
    if (mem.status === "forgotten") {
      return { forgotten: true, id: input.id };
    }

    if (mem.status === "canonical" && !opts?.approved) {
      // EXECUTION CONTRACT FOR Approvals.approve(): the held op below is an
      // op:"forget" (schemas/operation.ts ForgetOp shape), which
      // Broker.apply() rejects by design (it operates on a memory id, not a
      // path — see broker.ts). approve() MUST DISPATCH on the held op — a
      // held `forget` is executed by calling `store.forget(..., {approved:
      // true})` directly, NOT via broker.apply. Mirrors the `promote` held
      // op exactly.
      const approvalId = this.genId("apr");
      this.journal.insertApproval({
        id: approvalId,
        held_operation: JSON.stringify({
          op: "forget",
          id: input.id,
          reason: input.reason,
          session: input.session,
        }),
        zone: "canonical-forget",
        reason: input.reason,
        session: input.session,
        state: "pending",
        created_at: this.now(),
        resolved_at: null,
        stale_reason: null,
      });
      return { queued: true, approvalId };
    }

    // Durable status (design §6.0): flip the note's `ledger.status` to
    // "forgotten" in the FILE before archiving, so the archived note is
    // self-describing and a reindex recovers status "forgotten" from the file
    // rather than whatever status it last carried on disk. This is a separate
    // audited revise commit ahead of the archive move.
    await this.flipFrontmatterStatus(mem, "forgotten", input.reason, input.session);

    const archivePath = `${ARCHIVE_DIR}/${input.id}.md`;
    const result = await this.broker.archive(mem.path, archivePath, input.session, input.reason);

    this.journal.updateMemory(input.id, { status: "forgotten", path: archivePath });
    // Link the forget (archive) transaction to this memory for undo/audit.
    if (result.txnId !== undefined) {
      this.journal.setTransactionMemoryId(result.txnId, input.id);
    }
    // Conflicts naming this memory are NOT proactively touched here (design
    // §4.3): the both-sides-live filter in Conflicts.list() is the SOLE
    // mechanism for hiding them, now that the memory's status is
    // 'forgotten' — and it un-hides them again if the forget is later
    // undone (the memory goes live again), rather than permanently baking
    // in a 'moot' state that a re-detect could never reopen.

    // Post-commit, non-blocking source-linked staleness (design v0.3b-2):
    // ALWAYS flags every citing distillation, on both the immediate
    // (working) and approved-canonical (store.forget(..., {approved:true}))
    // paths -- both fall through to this exact code. `contentId` hashes the
    // note at its NEW archived path (the move already landed above), not
    // "GONE": the file still exists on disk, it just moved.
    // read+hash inside the try (see revise's note): the non-blocking contract
    // must cover the arg evaluation too, so a post-commit file race never fails
    // an already-committed forget.
    try {
      flagCitingDistillations(
        { journal: this.journal, now: this.now, genId: this.genId },
        input.id,
        "forgotten",
        hashFile(join(this.vaultRoot, archivePath)),
      );
    } catch (err) {
      console.error(`forget: source-linked staleness failed for ${input.id}:`, err);
    }

    return { forgotten: true, id: input.id };
  }

  /**
   * Mark a memory `retired` — "no longer current knowledge, but still
   * history" (design v0.3b lifecycle-ops) — via a governed metadata patch
   * into the note's `ledger:` block. Mirrors `forget` EXACTLY: same
   * idempotency guard, same canonical-approval gate, same
   * queued-vs-applied `RetireResult` union. The only additions are (1) a
   * transition table that REJECTS scratch/forgotten/reverted rather than
   * silently no-opping (retire is only meaningful for current-knowledge
   * states) and (2) `superseded_by` validation.
   *
   * NEVER appends prose to the body — this writes `ledger.status`,
   * `ledger.retired_reason`, and (optionally) `ledger.superseded_by` only,
   * via `flipFrontmatterStatus`'s minimal unified diff, same as every other
   * durable status transition in this file.
   */
  async retire(input: RetireInput, opts?: RetireOptions): Promise<RetireResult> {
    const mem = this.journal.getMemory(input.id);
    if (!mem) {
      throw new BrokerError("NOT_FOUND", `no memory with id ${input.id}`);
    }

    // Idempotent re-apply (mirrors forget's already-forgotten guard): the
    // ONLY no-op transition. This matters for the same crash-gap reason
    // forget's guard does — a human re-approving a canonical-retire after a
    // crash between apply and setApprovalState must not wedge here.
    if (mem.status === "retired") {
      return { retired: true, id: input.id };
    }

    // Transition table (mirrors forget + promote): retire only applies to
    // current-knowledge states. scratch/forgotten/reverted are NOT silent
    // no-ops — an agent calling retire on one of those is a caller error
    // that must surface, not disappear.
    if (mem.status === "scratch" || mem.status === "forgotten" || mem.status === "reverted") {
      throw new BrokerError(
        "INVALID_TRANSITION",
        `cannot retire a memory with status '${mem.status}'; retire only applies to ` +
          `current-knowledge states (working/canonical)`,
      );
    }

    // superseded_by validation BEFORE applying AND before enqueue — a bad
    // pointer must never even enter the approval queue (same "dangling
    // citation" family as distill's source validation: an unvalidated
    // superseded_by is a forgeable lineage pointer). Uses the SAME
    // CITABLE_SOURCE_STATUSES allowlist distill does, so both reject
    // `forgotten` AND `reverted` (content gone from the vault) while allowing
    // a live OR retired target (you can be superseded by a historical
    // belief).
    if (input.superseded_by !== undefined) {
      const target = this.journal.getMemory(input.superseded_by);
      if (
        !target ||
        !CITABLE_SOURCE_STATUSES.includes(target.status as (typeof CITABLE_SOURCE_STATUSES)[number])
      ) {
        throw new BrokerError(
          "INVALID_SOURCE",
          `retire superseded_by '${input.superseded_by}' must reference an existing, ` +
            `citable memory (not forgotten, not reverted)`,
          false,
        );
      }
    }

    if (mem.status === "canonical" && !opts?.approved) {
      // EXECUTION CONTRACT FOR Approvals.approve(): the held op below is an
      // op:"retire" (schemas/operation.ts RetireOp shape), which
      // Broker.apply() rejects by design (it operates on a memory id, not a
      // path — see broker.ts). approve() MUST DISPATCH on the held op — a
      // held `retire` is executed by calling `store.retire(..., {approved:
      // true})` directly, NOT via broker.apply. Mirrors the `forget` held op
      // exactly.
      const approvalId = this.genId("apr");
      this.journal.insertApproval({
        id: approvalId,
        held_operation: JSON.stringify({
          op: "retire",
          id: input.id,
          reason: input.reason,
          ...(input.superseded_by !== undefined ? { superseded_by: input.superseded_by } : {}),
          session: input.session,
        }),
        zone: "canonical-retire",
        reason: input.reason,
        session: input.session,
        state: "pending",
        created_at: this.now(),
        resolved_at: null,
        stale_reason: null,
      });
      return { queued: true, approvalId };
    }

    const extra: Record<string, unknown> = { retired_reason: input.reason };
    if (input.superseded_by !== undefined) {
      extra.superseded_by = input.superseded_by;
    }
    await this.flipFrontmatterStatus(mem, "retired", input.reason, input.session, extra);
    this.journal.updateMemory(input.id, { status: "retired" });

    // Post-commit, non-blocking source-linked staleness (design v0.3b-2):
    // this single call site covers BOTH the working-retire path (immediate,
    // reaches here directly) and the approved-canonical-retire path
    // (Approvals.approve's `retire` arm calls `store.retire(...,
    // {approved:true})`, which skips the queue-and-return above and falls
    // through to this exact code) -- so retire ALWAYS flags, regardless of
    // which path landed it. `mem.path` is unchanged by retire (a metadata
    // flip, not a move), so it's still the note's current on-disk path.
    // read+hash inside the try (see revise's note): the non-blocking contract
    // must cover the arg evaluation too, so a post-commit file race never fails
    // an already-committed retire.
    try {
      flagCitingDistillations(
        { journal: this.journal, now: this.now, genId: this.genId },
        input.id,
        "retired",
        hashFile(join(this.vaultRoot, mem.path)),
      );
    } catch (err) {
      console.error(`retire: source-linked staleness failed for ${input.id}:`, err);
    }

    return { retired: true, id: input.id };
  }

  /**
   * Durable status transition (design §6.0): write `ledger.status = newStatus`
   * into the note's FILE frontmatter through the broker (a real revise commit),
   * then mirror the change onto the journal row. The file — not the journal —
   * is the source of truth for status, so `reindex` can rebuild the correct
   * status after a journal loss. `approved: true` is passed to the broker so a
   * (hypothetical) trusted-zone note wouldn't hit the approval gate; agent-zone
   * memory notes never hit it anyway, so this is harmless there.
   */
  async setStatus(
    id: string,
    newStatus: MemoryStatusValue,
    reason: string,
    session: string,
  ): Promise<void> {
    const mem = this.journal.getMemory(id);
    if (!mem) {
      throw new BrokerError("NOT_FOUND", `no memory with id ${id}`);
    }
    await this.flipFrontmatterStatus(mem, newStatus, reason, session);
    this.journal.setMemoryStatus(id, newStatus);
  }

  /**
   * Rewrite the `ledger.status` field (and, optionally, any additional
   * ledger-block fields passed via `extra` — e.g. `retire`'s
   * `retired_reason`/`superseded_by`) of a note's frontmatter and route the
   * resulting minimal unified diff through the broker as an (approved)
   * revise. Reads the current on-disk bytes so the patch's expected_hash and
   * context match exactly. Does not touch the journal — callers decide what
   * journal bookkeeping to pair with the file change (setStatus mirrors the
   * status; forget updates status + path together; retire mirrors forget).
   * `extra` is metadata ONLY (ledger-block fields) — this never touches the
   * note body, so no caller can use it to append prose.
   */
  private async flipFrontmatterStatus(
    mem: MemoryRow,
    newStatus: MemoryStatusValue,
    reason: string,
    session: string,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    const abs = join(this.vaultRoot, mem.path);
    const before = readFileSync(abs, "utf8");
    const parsed = matter(before);
    const currentLedger =
      typeof parsed.data.ledger === "object" && parsed.data.ledger !== null
        ? (parsed.data.ledger as Record<string, unknown>)
        : {};
    const after = matter.stringify(parsed.content, {
      ...parsed.data,
      ledger: { ...currentLedger, status: newStatus, ...(extra ?? {}) },
    });
    // Idempotent: nothing to commit if the status is already what we want.
    if (after === before) return;

    const patch = createPatch(basename(mem.path), before, after);
    const result = await this.broker.apply(
      {
        op: "revise",
        path: mem.path,
        expected_hash: hashFile(abs),
        patch,
        entity: mem.entity ?? undefined,
        reason,
        session,
      },
      { approved: true },
    );
    if (!("queued" in result) && result.txnId !== undefined) {
      this.journal.setTransactionMemoryId(result.txnId, mem.id);
    }
  }
}
