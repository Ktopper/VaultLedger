import { BrokerError } from "../errors.js";
import type { Broker } from "../broker/broker.js";
import type { ApprovalRow, Journal } from "../journal/journal.js";
import type { MemoryStore } from "../memory/store.js";
import type { ProposedOperation } from "../schemas/operation.js";

export interface ApprovalsOptions {
  broker: Broker;
  store: MemoryStore;
  journal: Journal;
  now: () => string;
}

export type ApproveResult = { applied: true } | { stale: true };

/**
 * The pending-approval queue (design §5.2/§approvals). This is the general
 * enqueue/resolve surface used by callers that hold an operation pending
 * human review — `propose_edit` (queued by the Broker itself) and
 * `promote` working->canonical (queued by `MemoryStore.promote`) both land
 * rows here via their own call sites; `Approvals.enqueue` is the same
 * primitive exposed for any other caller that needs to hold an op.
 *
 * `approve()` DISPATCHES on the held operation's `op` field rather than
 * blindly forwarding to `Broker.apply`:
 *   - `create` / `revise`: these apply via `Broker.apply(op, {approved:true})`
 *     unchanged.
 *   - `propose_edit`: `Broker.apply` never applies a `propose_edit` directly
 *     (it always re-queues one — that's how it lands in this queue in the
 *     first place). To actually apply the held edit, approve() re-shapes it
 *     into the equivalent `revise` op (same fields; only the `op` literal
 *     differs) and calls `Broker.apply({...op, op:"revise"}, {approved:true})`,
 *     which runs the real hash-check + patch + commit path.
 *   - `promote`: a canonical promotion is not a path-based broker op at all
 *     (`Broker.apply` rejects `promote` with NOT_FOUND by design — see
 *     broker.ts). It is applied via `MemoryStore.setStatus`, which writes the
 *     new status into the note's FILE frontmatter (design §6.0, durable
 *     status) AND mirrors it onto the journal row — NOT a bare
 *     `journal.setMemoryStatus`, which would leave the file stale and lose the
 *     promotion on the next reindex.
 *   - `forget`: a canonical-belief forget (queued by `MemoryStore.forget`,
 *     mirroring the `promote` gate) is likewise not a path-based broker op.
 *     It is applied via `MemoryStore.forget(input, {approved:true})`, which
 *     bypasses the gate and runs the real tombstone (frontmatter flip +
 *     archive move + journal update).
 *   - `retire`: a canonical-belief retire (queued by `MemoryStore.retire`,
 *     mirroring the `forget` gate exactly) is likewise not a path-based
 *     broker op. It is applied via `MemoryStore.retire(input, {approved:true})`,
 *     which bypasses the gate and runs the real metadata patch (frontmatter
 *     status/retired_reason/superseded_by flip).
 *   - anything else: INVALID_TRANSITION (an unrecognized held op is a
 *     journal-integrity problem, not a normal rejection path).
 */
export class Approvals {
  private readonly broker: Broker;
  private readonly store: MemoryStore;
  private readonly journal: Journal;
  private readonly now: () => string;

  constructor(opts: ApprovalsOptions) {
    this.broker = opts.broker;
    this.store = opts.store;
    this.journal = opts.journal;
    this.now = opts.now;
  }

  /** Enqueue an arbitrary held operation for later approval. Returns the new approval id. */
  enqueue(
    op: ProposedOperation,
    zone: string,
    reason: string,
    session: string,
    genId: (prefix: string) => string,
  ): string {
    const id = genId("apr");
    const row: ApprovalRow = {
      id,
      held_operation: JSON.stringify(op),
      zone,
      reason,
      session,
      state: "pending",
      created_at: this.now(),
      resolved_at: null,
    };
    this.journal.insertApproval(row);
    return id;
  }

  /** Every currently-pending approval. */
  list(): ApprovalRow[] {
    return this.journal.listApprovals("pending");
  }

  async approve(id: string): Promise<ApproveResult> {
    const approval = this.loadPending(id);
    const op = JSON.parse(approval.held_operation) as { op: string; [key: string]: unknown };

    switch (op.op) {
      case "create":
      case "revise": {
        return this.dispatchApply(id, op as unknown as ProposedOperation);
      }
      case "propose_edit": {
        // Broker.apply never applies a propose_edit directly — re-shape it
        // into the equivalent revise op so the real write path runs.
        const reviseOp = { ...op, op: "revise" } as unknown as ProposedOperation;
        return this.dispatchApply(id, reviseOp);
      }
      case "promote": {
        // Durable status (design §6.0): flip the FILE frontmatter (and the
        // journal row) to canonical via the store, not a bare
        // journal.setMemoryStatus — otherwise the promotion is lost on the
        // next reindex.
        const memoryId = op.id as string;
        const reason = typeof op.reason === "string" ? op.reason : "approved canonical promotion";
        const session = typeof op.session === "string" ? op.session : "approval";
        await this.store.setStatus(memoryId, "canonical", reason, session);
        this.journal.setApprovalState(id, "approved", this.now());
        return { applied: true };
      }
      case "forget": {
        // A canonical-forget is not a path-based broker op at all
        // (Broker.apply rejects `forget` with NOT_FOUND by design, same as
        // `promote` — see broker.ts). It is applied via
        // MemoryStore.forget(..., {approved:true}), which bypasses the
        // canonical gate and runs the real tombstone (frontmatter flip +
        // archive move + journal update) — mirrors the `promote` case above.
        const memoryId = op.id as string;
        const reason = typeof op.reason === "string" ? op.reason : "approved canonical forget";
        const session = typeof op.session === "string" ? op.session : "approval";
        await this.store.forget({ id: memoryId, reason, session }, { approved: true });
        this.journal.setApprovalState(id, "approved", this.now());
        return { applied: true };
      }
      case "retire": {
        // A canonical-retire (queued by `MemoryStore.retire`, mirroring the
        // `forget` gate exactly) is likewise not a path-based broker op. It
        // is applied via MemoryStore.retire(..., {approved:true}), which
        // bypasses the canonical gate and runs the real metadata patch
        // (frontmatter status/retired_reason/superseded_by flip) — mirrors
        // the `forget` case above.
        const memoryId = op.id as string;
        const reason = typeof op.reason === "string" ? op.reason : "approved canonical retire";
        const session = typeof op.session === "string" ? op.session : "approval";
        const supersededBy = typeof op.superseded_by === "string" ? op.superseded_by : undefined;
        await this.store.retire(
          { id: memoryId, reason, superseded_by: supersededBy, session },
          { approved: true },
        );
        this.journal.setApprovalState(id, "approved", this.now());
        return { applied: true };
      }
      default:
        throw new BrokerError(
          "INVALID_TRANSITION",
          `unknown held operation in approval ${id}: ${String(op.op)}`,
        );
    }
  }

  reject(id: string): void {
    this.loadPending(id);
    this.journal.setApprovalState(id, "rejected", this.now());
  }

  private loadPending(id: string): ApprovalRow {
    const approval = this.journal.getApproval(id);
    if (!approval || approval.state !== "pending") {
      throw new BrokerError("NOT_FOUND", `no pending approval with id ${id}`);
    }
    return approval;
  }

  private async dispatchApply(id: string, op: ProposedOperation): Promise<ApproveResult> {
    try {
      // Pass approvalId so the transaction the broker records carries this
      // approval's id — the SOUND link reconcile.closeStaleApprovals uses to
      // close a stale pending approval by exact id-match after a crash in the
      // gap below (see that function). The promote-canonical branch of
      // approve() does NOT route through here (it calls store.setStatus, which
      // records no approval_id-tagged transaction) — a crash there just leaves
      // the approval pending, which is safe: no false-close, a human re-acts.
      await this.broker.apply(op, { approved: true, approvalId: id });
    } catch (e) {
      if (e instanceof BrokerError && e.code === "STALE_HASH") {
        this.journal.setApprovalState(id, "stale", this.now());
        return { stale: true };
      }
      // Any OTHER BrokerError (FORBIDDEN_ZONE, PATCH_TOO_LARGE, SYNTAX_BREAK,
      // NOT_FOUND, ...) propagates and INTENTIONALLY leaves the approval row
      // pending: the write did not happen, and a human can inspect and
      // reject() it. Only STALE_HASH auto-resolves the row (to "stale").
      throw e;
    }
    // Crash gap: the process can die between the broker's write (file + commit
    // + transaction row all landing) and this setApprovalState, leaving the
    // edit applied but the approval row still "pending". reconcile's
    // closeStaleApprovals repairs exactly this: it closes any pending approval
    // that has an APPLIED transaction tagged with its approval_id (the sound
    // id-link stamped above via broker.apply's approvalId), so the recovery is
    // exact — never a path/time heuristic that could false-close an unrelated
    // same-path op.
    this.journal.setApprovalState(id, "approved", this.now());
    return { applied: true };
  }
}
