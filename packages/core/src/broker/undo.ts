import { BrokerError } from "../errors.js";
import type { Journal, TransactionRow } from "../journal/journal.js";
import type { LedgerGit } from "./git.js";

export interface UndoDeps {
  git: LedgerGit;
  journal: Journal;
  now: () => string;
  genId: (prefix: string) => string;
}

/**
 * Revert a single applied transaction: `git revert` its commit, then
 * atomically (a) mark the original transaction 'reverted', (b) mark its
 * linked memory (if any) 'reverted', and (c) insert a new op='revert'
 * transaction row that is the exact hash mirror of the original (before <->
 * after swapped) — design §5.3.
 *
 * On REVERT_CONFLICT, the git error propagates and the journal is left
 * completely untouched: the compensation only runs after `revertCommit`
 * resolves successfully.
 */
export async function undoTransaction(
  deps: UndoDeps,
  txnId: string,
): Promise<{ revertSha: string; revertTxnId: string }> {
  const { git, journal, now, genId } = deps;

  const txn = journal.getTransaction(txnId);
  if (!txn) {
    throw new BrokerError("NOT_FOUND", `transaction not found: ${txnId}`);
  }
  if (txn.status === "reverted") {
    throw new BrokerError("ALREADY_REVERTED", `transaction already reverted: ${txnId}`);
  }
  if (!txn.commit_sha) {
    throw new BrokerError("NOT_FOUND", `transaction ${txnId} has no commit to revert`);
  }

  // May throw REVERT_CONFLICT (or a non-conflict git error); in either case
  // the journal must not be touched, so this runs before any journal write.
  const revertSha = await git.revertCommit(txn.commit_sha);

  const revertTxnId = genId("txn");
  const revertRow: TransactionRow = {
    id: revertTxnId,
    op: "revert",
    path: txn.path,
    hash_before: txn.hash_after,
    hash_after: txn.hash_before,
    session: txn.session,
    reason: `revert of ${txnId}`,
    memory_id: txn.memory_id,
    commit_sha: revertSha,
    created_at: now(),
    status: "applied",
  };

  journal.runInTransaction(() => {
    journal.setTransactionStatus(txnId, "reverted");
    if (txn.memory_id) {
      journal.setMemoryStatus(txn.memory_id, "reverted");
    }
    journal.recordTransaction(revertRow);
  });

  return { revertSha, revertTxnId };
}

/**
 * Revert every 'applied' (non-revert) transaction recorded for a session, in
 * reverse chronological order (newest first) to minimize the chance of a
 * conflict. `Journal.listTransactions` already orders by created_at DESC, so
 * no extra sort is needed.
 *
 * Stops and propagates on the first REVERT_CONFLICT (or any other error): a
 * conflict needs manual resolution, and reverts already completed before the
 * failure are left in place (both in git and the journal) rather than
 * attempting a rollback of the rollback.
 */
export async function undoSession(
  deps: UndoDeps,
  sessionId: string,
): Promise<Array<{ txnId: string; revertSha: string }>> {
  const candidates = deps.journal
    .listTransactions({ session: sessionId })
    .filter((t) => t.status === "applied" && t.op !== "revert");

  const results: Array<{ txnId: string; revertSha: string }> = [];
  for (const txn of candidates) {
    const { revertSha } = await undoTransaction(deps, txn.id);
    results.push({ txnId: txn.id, revertSha });
  }
  return results;
}
