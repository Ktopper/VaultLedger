import { BrokerError } from "../errors.js";
import type { Broker } from "../broker/broker.js";
import type { ApprovalRow, Journal } from "../journal/journal.js";
import type { ProposedOperation } from "../schemas/operation.js";

export interface ApprovalsOptions {
  broker: Broker;
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
 *     broker.ts). It is applied directly against the journal
 *     (`setMemoryStatus(id, "canonical")`).
 *   - anything else: INVALID_TRANSITION (an unrecognized held op is a
 *     journal-integrity problem, not a normal rejection path).
 */
export class Approvals {
  private readonly broker: Broker;
  private readonly journal: Journal;
  private readonly now: () => string;

  constructor(opts: ApprovalsOptions) {
    this.broker = opts.broker;
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
        const memoryId = op.id as string;
        this.journal.setMemoryStatus(memoryId, "canonical");
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
      await this.broker.apply(op, { approved: true });
    } catch (e) {
      if (e instanceof BrokerError && e.code === "STALE_HASH") {
        this.journal.setApprovalState(id, "stale", this.now());
        return { stale: true };
      }
      throw e;
    }
    this.journal.setApprovalState(id, "approved", this.now());
    return { applied: true };
  }
}
