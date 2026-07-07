import { basename, join } from "node:path";
import { readFileSync } from "node:fs";
import matter from "gray-matter";
import { createPatch } from "diff";
import type { z } from "zod";
import { Broker } from "../broker/broker.js";
import { hashFile } from "../broker/hash.js";
import { BrokerError } from "../errors.js";
import { checkContradictions } from "../contradiction/check.js";
import type { Journal, MemoryRow } from "../journal/journal.js";
import type { Confidence, MemoryStatus } from "../schemas/provenance.js";

type ConfidenceValue = z.infer<typeof Confidence>;
type MemoryStatusValue = z.infer<typeof MemoryStatus>;

const DEFAULT_AGENT_DIR = "Agent/Memory";
const ARCHIVE_DIR = "Agent/Archive";

export interface MemoryStoreOptions {
  broker: Broker;
  journal: Journal;
  now: () => string;
  genId: (prefix: string) => string;
  /** Absolute path to the vault root (needed to hashFile the current note). */
  vaultRoot: string;
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
}

export interface RememberResult {
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
  private readonly agentDir: string;

  constructor(opts: MemoryStoreOptions) {
    this.broker = opts.broker;
    this.journal = opts.journal;
    this.now = opts.now;
    this.genId = opts.genId;
    this.vaultRoot = opts.vaultRoot;
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
      { journal: this.journal, vaultRoot: this.vaultRoot, now: this.now, genId: this.genId },
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
   */
  async revise(input: ReviseInput): Promise<void> {
    const mem = this.journal.getMemory(input.id);
    if (!mem) {
      throw new BrokerError("NOT_FOUND", `no memory with id ${input.id}`);
    }

    const expectedHash = hashFile(join(this.vaultRoot, mem.path));

    const result = await this.broker.apply({
      op: "revise",
      path: mem.path,
      expected_hash: expectedHash,
      patch: input.patch,
      entity: mem.entity ?? undefined,
      reason: input.reason,
      session: input.session,
    });
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
      { journal: this.journal, vaultRoot: this.vaultRoot, now: this.now, genId: this.genId },
      input.id,
    );
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
    return { forgotten: true, id: input.id };
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
   * Rewrite only the `ledger.status` field of a note's frontmatter and route
   * the resulting minimal unified diff through the broker as an (approved)
   * revise. Reads the current on-disk bytes so the patch's expected_hash and
   * context match exactly. Does not touch the journal — callers decide what
   * journal bookkeeping to pair with the file change (setStatus mirrors the
   * status; forget updates status + path together).
   */
  private async flipFrontmatterStatus(
    mem: MemoryRow,
    newStatus: MemoryStatusValue,
    reason: string,
    session: string,
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
      ledger: { ...currentLedger, status: newStatus },
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
