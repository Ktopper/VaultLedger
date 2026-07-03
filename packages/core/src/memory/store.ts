import { join } from "node:path";
import matter from "gray-matter";
import type { z } from "zod";
import { Broker } from "../broker/broker.js";
import { hashFile } from "../broker/hash.js";
import { BrokerError } from "../errors.js";
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
      this.journal.updateMemory(input.id, { status: "working" });
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

  /** Archive the memory's file (tombstone) and mark its journal row forgotten. */
  async forget(input: ForgetInput): Promise<void> {
    const mem = this.journal.getMemory(input.id);
    if (!mem) {
      throw new BrokerError("NOT_FOUND", `no memory with id ${input.id}`);
    }

    const archivePath = `${ARCHIVE_DIR}/${input.id}.md`;
    const result = await this.broker.archive(mem.path, archivePath, input.session, input.reason);

    this.journal.updateMemory(input.id, { status: "forgotten", path: archivePath });
    // Link the forget (archive) transaction to this memory for undo/audit.
    if (result.txnId !== undefined) {
      this.journal.setTransactionMemoryId(result.txnId, input.id);
    }
  }
}
