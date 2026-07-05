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

    // v0.1 limitation: if `content` itself begins with its own `---`
    // frontmatter block, matter.stringify does not merge/relocate it — the
    // ledger block is prepended and the caller's leading `---` ends up in the
    // body. Callers pass plain content in v0.1.
    const noteBody = matter.stringify(input.content, {
      ledger: {
        id,
        status: "scratch",
        created,
        source: input.session,
        reason: input.reason,
        confidence: input.confidence ?? "medium",
        supersedes: null,
        expires: null,
      },
    });

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
      supersedes: null,
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
    // the matching call in `remember` for rationale. Runs even if the write
    // was queued for approval (harmless: the file on disk hasn't changed
    // yet in that case, so the check just re-examines the pre-patch note).
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
   * Archive the memory's file (tombstone) and mark its journal row forgotten.
   *
   * Concurrency note (design §12, accepted v0.2 limitation): forget is TWO
   * broker calls — `flipFrontmatterStatus` (a locked revise commit) then
   * `broker.archive` (a locked move commit). Each individually acquires and
   * holds the cross-process vault lock, so neither races another process's
   * git/journal writes; but the two are NOT jointly atomic — a concurrent
   * reader can observe the intermediate state (status=forgotten in the file,
   * note not yet moved to Agent/Archive). That intermediate state is
   * transient and self-heals: the next reindex recovers the correct
   * status/path from disk. NOT wrapped in a single outer lock on purpose —
   * the inner broker calls already take the lock and proper-lockfile is
   * non-reentrant, so an outer acquire would deadlock; single-commit atomic
   * forget is left to a future milestone.
   */
  async forget(input: ForgetInput): Promise<void> {
    const mem = this.journal.getMemory(input.id);
    if (!mem) {
      throw new BrokerError("NOT_FOUND", `no memory with id ${input.id}`);
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
    // The memory is no longer live, so any open conflict naming it is no
    // longer actionable — moot it (see Journal.markConflictsMoot).
    this.journal.markConflictsMoot(input.id, this.now());
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
