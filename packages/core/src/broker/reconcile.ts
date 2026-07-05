import type { Journal, TransactionRow } from "../journal/journal.js";
import type { LedgerGit } from "./git.js";

export interface ReconcileDeps {
  git: LedgerGit;
  journal: Journal;
  now: () => string;
  genId: (prefix: string) => string;
}

// Mirrors formatMessage's `ledger: <op> <basename> [<memoryId>] <session>`.
// Anchored on the KNOWN structure so a basename containing spaces (e.g.
// "My Note.md") still parses: op is the first token, session the LAST token,
// an optional `[memoryId]` sits immediately before session, and basename is
// everything in between (non-greedy so it doesn't swallow the [memoryId]).
// Exported so `reindex` (memory/reindex.ts) can reuse the exact same parser
// instead of drifting a second copy of this regex.
export const MESSAGE_RE = /^ledger:\s+(\S+)\s+(.+?)(?:\s+\[([^\]]+)\])?\s+(\S+)\s*$/;

/**
 * Startup reconciliation (design §5, crash-recovery): a process can crash
 * between `LedgerGit.commitFile` landing a commit and `Journal.recordTransaction`
 * persisting it, leaving a ledger commit the journal doesn't know about.
 * `reconcile` walks every ledger commit and inserts a best-effort transaction
 * row for any commit missing from the journal, recovered by parsing the
 * commit message.
 *
 * Path recovery is limited to the commit message's basename segment (not the
 * full vault-relative path) — acceptable for v0.1 since the repaired row's
 * purpose is audit-trail completeness, not driving further writes.
 */
export async function reconcile(
  deps: ReconcileDeps,
): Promise<{ repaired: number; approvalsClosed: number }> {
  const { git, journal, now, genId } = deps;
  const commits = await git.listLedgerCommits();

  let repaired = 0;
  for (const { sha, message } of commits) {
    if (journal.hasCommit(sha)) continue;

    const match = MESSAGE_RE.exec(message);
    if (!match) continue; // Not a well-formed ledger message; nothing to recover.

    // Groups 1 (op), 2 (basename), 4 (session) are guaranteed present when the
    // regex matches; group 3 (memoryId) is optional.
    const op = match[1]!;
    const basename = match[2]!;
    const memoryId = match[3];
    const session = match[4]!;

    const row: TransactionRow = {
      id: genId("txn"),
      op,
      path: basename,
      hash_before: null,
      hash_after: null,
      session,
      reason: "reconciled from commit",
      memory_id: memoryId ?? null,
      commit_sha: sha,
      approval_id: null,
      created_at: now(),
      status: "applied",
    };
    // recordTransactionIfNew (not recordTransaction): two processes can race
    // to repair the same missing commit; ON CONFLICT(commit_sha) DO NOTHING
    // converges them on one row instead of the loser crashing.
    if (journal.recordTransactionIfNew(row)) {
      repaired += 1;
    }
  }

  const approvalsClosed = closeStaleApprovals(journal, now);

  return { repaired, approvalsClosed };
}

/**
 * Second reconcile pass (crash-recovery, the approve->apply gap): a process
 * can crash after `Approvals.approve` has applied the held operation (the
 * file is patched, the commit landed, the transaction row is 'applied') but
 * BEFORE `Journal.setApprovalState` flips the approval row out of 'pending'
 * — leaving an approval that LOOKS like it's still awaiting a human, when
 * the edit it describes has already gone through.
 *
 * SOUND id-link match (not a heuristic): when `Approvals.approve` re-runs a
 * held op through the broker, it passes the approval's id as
 * `broker.apply(op, { approvalId })`, which stamps the resulting transaction
 * row's `approval_id`. So an approval is closed to 'approved' IFF the journal
 * has an APPLIED transaction whose `approval_id` equals the approval's id —
 * the EXACT row produced by applying THAT approval, nothing else.
 *
 * Why exact-id and not a path/time heuristic: a "same path, committed after
 * the approval" heuristic FALSE-CLOSES an unrelated op. Concretely — a
 * propose_edit on `Agent/Notes/x.md` is queued at t1; an unrelated DIRECT
 * revise lands on that same path at t2; the heuristic would mark the approval
 * 'approved' even though the approval's OWN patch never applied, corrupting
 * the audit trail's "every mutation is attributable" invariant. (Matching on
 * hash_before doesn't save it either — two different ops can start from the
 * same file state.) The id-link makes a false-close impossible: a different
 * op carries a different — or null — approval_id and simply won't match.
 *
 * Only ops applied THROUGH the broker's approve path carry an approval_id, so
 * the `promote`->canonical approval (whose approve() calls `store.setStatus`,
 * recording no approval_id-tagged transaction) will NOT auto-close on crash —
 * it just stays pending, which is safe (no false-close; a human re-acts).
 */
function closeStaleApprovals(journal: Journal, now: () => string): number {
  const pending = journal.listApprovals("pending");
  let closed = 0;

  for (const approval of pending) {
    // Query by approval_id (indexed lookup, not a full-table scan per pending
    // approval). Any APPLIED transaction tagged with this approval's id is the
    // exact deferred execution of its held op — close the approval.
    const appliedForThisApproval = journal.getAppliedTransactionsByApprovalId(approval.id);
    if (appliedForThisApproval.length > 0) {
      journal.setApprovalState(approval.id, "approved", now());
      closed += 1;
    }
  }

  return closed;
}
