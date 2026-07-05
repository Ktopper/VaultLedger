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

/** Last path segment, splitting on "/" only (vault-relative paths are always
 * stored with "/" separators — see reindex.ts's relPath construction). Used
 * to compare a held operation's full path against a reconcile-repaired
 * transaction row, which only ever carries the basename (see module doc). */
function basenameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

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
 * Matched CONSERVATIVELY: an approval is only closed when there's a clear
 * applied transaction, on the same path, with a created_at strictly AFTER
 * the approval's own created_at. No such transaction -> the approval is left
 * untouched. This can never resurrect a rejected/already-approved row (only
 * 'pending' rows are considered) and can never mis-close a genuinely
 * still-pending approval just because some unrelated later edit touched the
 * same path before the approval existed (the created_at ordering rules that
 * out) — worst case a stale approval survives one more reconcile cycle,
 * which is the safe direction to err in.
 *
 * PATH REPRESENTATION NOTE: a transaction row's `path` is the full
 * vault-relative path when recorded by the normal broker write path, but
 * only the BASENAME when recorded by this same reconcile function's
 * commit-repair pass above (see its doc comment). A held operation's path is
 * always the full vault-relative path (it's what the broker was originally
 * asked to write). So a transaction matches if its `path` equals the held
 * op's full path OR equals the held op's basename — covering both possible
 * shapes of the recorded row without needing to know which one produced it.
 *
 * Only `create`/`revise`/`propose_edit` held ops carry a `path` field
 * (`promote`/`forget` operate on a memory `id` instead, with no file write to
 * cross-check against) — an approval whose held op has no `path` is left
 * untouched; there is nothing conservative to match it against.
 */
function closeStaleApprovals(journal: Journal, now: () => string): number {
  const pending = journal.listApprovals("pending");
  if (pending.length === 0) return 0;

  const transactions = journal.listTransactions({});
  let closed = 0;

  for (const approval of pending) {
    let heldOp: { path?: unknown };
    try {
      heldOp = JSON.parse(approval.held_operation) as { path?: unknown };
    } catch {
      continue; // Corrupt held_operation JSON: nothing to conservatively match.
    }
    const path = typeof heldOp.path === "string" ? heldOp.path : undefined;
    if (!path) continue;
    const basename = basenameOf(path);

    const match = transactions.find(
      (t) =>
        t.status === "applied" &&
        (t.path === path || t.path === basename) &&
        t.created_at > approval.created_at,
    );
    if (match) {
      journal.setApprovalState(approval.id, "approved", now());
      closed += 1;
    }
  }

  return closed;
}
