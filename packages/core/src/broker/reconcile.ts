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
export async function reconcile(deps: ReconcileDeps): Promise<{ repaired: number }> {
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

  return { repaired };
}
