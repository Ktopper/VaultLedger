import matter from "gray-matter";
import { BrokerError } from "../errors.js";
import type { Journal, TransactionRow } from "../journal/journal.js";
import { withVaultLock } from "../concurrency/lock.js";
import type { LedgerGit } from "./git.js";

export interface UndoDeps {
  git: LedgerGit;
  journal: Journal;
  now: () => string;
  genId: (prefix: string) => string;
  /** When set, acquires the shared cross-process vault lock (see
   * concurrency/lock.ts) around the undo. Opt-in: unset leaves behavior
   * unchanged for existing single-process callers/tests. */
  lockDir?: string;
}

/**
 * Revert a single applied transaction: `git revert` its commit, then
 * atomically (a) mark the original transaction 'reverted', (b) re-derive its
 * linked memory's status (if any) from the FILE at HEAD (source of truth,
 * spec §6.0) — 'reverted' if the note is now gone (an originating create was
 * undone), otherwise whatever status the note's restored `ledger:`
 * frontmatter declares (a content revise or promote status-flip was undone,
 * and the memory stays live in recall) — and (c) insert a new op='revert'
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
  if (deps.lockDir !== undefined) {
    return withVaultLock(deps.lockDir, () => runUndoTransaction(deps, txnId));
  }
  return runUndoTransaction(deps, txnId);
}

/**
 * The actual undo-one-transaction work, factored out of `undoTransaction` so
 * `undoSession` can call it directly WITHOUT re-acquiring the vault lock per
 * transaction — `undoSession` already holds the lock for its whole run (see
 * below), and `proper-lockfile` locks are not reentrant within a process, so
 * acquiring it again per-transaction from inside an already-locked session
 * would self-deadlock until the outer lock's `stale` timeout lapsed.
 */
async function runUndoTransaction(
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

  // Re-derive the linked memory's status from the FILE — the source of
  // truth per spec §6.0 — rather than blindly marking it 'reverted'.
  // `MemoryStore.revise()` (and status flips like promote) link every
  // content-edit transaction to its memory, so blindly reverting the memory
  // status here would make a live, correct memory silently vanish from
  // `recall` on every routine revise-undo. Only a reverted *create* actually
  // removes the file, and that's the one case that should end in 'reverted'.
  //
  // Computed BEFORE the runInTransaction block below: `fileAtHead` is async
  // (goes through git) and `runInTransaction` (better-sqlite3) is
  // synchronous, so the async read + parse must happen first and the result
  // applied synchronously inside the transaction.
  let derivedMemoryStatus: string | undefined;
  if (txn.memory_id) {
    const mem = journal.getMemory(txn.memory_id);
    if (mem) {
      const fileAtHead = await git.fileAtHead(mem.path);
      if (fileAtHead === null) {
        // The note is gone (an originating create was reverted) — the
        // belief's file no longer exists, so recall should drop it.
        derivedMemoryStatus = "reverted";
      } else {
        // The note still exists (a content revise or a promote status-flip
        // was reverted) — read whatever status git already restored into
        // the frontmatter and keep the memory live with that status. If the
        // frontmatter can't be parsed, leave derivedMemoryStatus undefined
        // so the status is left UNCHANGED below: losing a live memory from
        // recall is the worse failure than a possibly-stale status.
        try {
          const parsed = matter(fileAtHead);
          const ledger = parsed.data.ledger;
          const status =
            ledger && typeof ledger === "object"
              ? (ledger as Record<string, unknown>).status
              : undefined;
          if (typeof status === "string" && status.length > 0) {
            derivedMemoryStatus = status;
          }
        } catch {
          // Malformed frontmatter: fail safe, leave status unchanged.
        }
      }
    }
  }

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
    if (txn.memory_id && derivedMemoryStatus !== undefined) {
      journal.setMemoryStatus(txn.memory_id, derivedMemoryStatus);
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
  const run = async (): Promise<Array<{ txnId: string; revertSha: string }>> => {
    const candidates = deps.journal
      .listTransactions({ session: sessionId })
      .filter((t) => t.status === "applied" && t.op !== "revert");

    const results: Array<{ txnId: string; revertSha: string }> = [];
    for (const txn of candidates) {
      // Calls the lock-free core directly (not the exported `undoTransaction`)
      // — the lock for this whole session-undo is already held below, and
      // re-acquiring it per-transaction would self-deadlock (see
      // `runUndoTransaction`'s doc comment).
      const { revertSha } = await runUndoTransaction(deps, txn.id);
      results.push({ txnId: txn.id, revertSha });
    }
    return results;
  };
  if (deps.lockDir !== undefined) {
    return withVaultLock(deps.lockDir, run);
  }
  return run();
}
