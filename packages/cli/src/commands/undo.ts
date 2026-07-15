import { BrokerError, undoSession, undoTransaction } from "@vault-ledger/core";
import { loadContext, type LoadContextDeps } from "../context.js";

export interface UndoOptions {
  out?: (s: string) => void;
}

export type UndoCommandResult =
  | { ok: true; revertSha: string; revertTxnId: string }
  | { ok: true; results: Array<{ txnId: string; revertSha: string }> }
  | { ok: false; code: string };

const SESSION_PREFIX = "session:";

/**
 * Thin adapter over `undoTransaction` / `undoSession`. `target` is either a
 * bare transaction id or `session:<id>` to revert every applied transaction
 * for a session (newest first). Never throws out of this function — a
 * BrokerError (REVERT_CONFLICT, NOT_FOUND, ALREADY_REVERTED, ...) is caught,
 * printed, and returned as `{ ok: false, code }` so a commander wrapper can
 * decide exit-code semantics.
 */
export async function undoCommand(
  vaultDir: string,
  target: string,
  deps?: LoadContextDeps,
  opts: UndoOptions = {},
): Promise<UndoCommandResult> {
  const out = opts.out ?? console.log;
  const ctx = await loadContext(vaultDir, deps);
  // Thread the shared vault lock so `ledger undo` mutually excludes with the
  // MCP server / `ledger serve` mid-mutation (design §3 lists undo* among the
  // entry points the cross-process lock must cover). Without lockDir here,
  // undo's git revert + journal writes could race their commit.
  const undoDeps = {
    git: ctx.git,
    journal: ctx.journal,
    now: ctx.now,
    genId: ctx.genId,
    lockDir: ctx.lockDir,
  };
  try {
    if (target.startsWith(SESSION_PREFIX)) {
      const sessionId = target.slice(SESSION_PREFIX.length);
      try {
        const results = await undoSession(undoDeps, sessionId);
        out(`reverted ${results.length} transaction(s) for session ${sessionId}`);
        for (const r of results) out(`  ${r.txnId} -> ${r.revertSha}`);
        return { ok: true, results };
      } catch (e) {
        return handleError(e, out);
      }
    }

    try {
      const { revertSha, revertTxnId } = await undoTransaction(undoDeps, target);
      out(`reverted ${target} -> ${revertSha} (revert txn ${revertTxnId})`);
      return { ok: true, revertSha, revertTxnId };
    } catch (e) {
      return handleError(e, out);
    }
  } finally {
    ctx.db.close();
  }
}

function handleError(e: unknown, out: (s: string) => void): { ok: false; code: string } {
  if (e instanceof BrokerError) {
    out(`${e.code}: ${e.message}`);
    return { ok: false, code: e.code };
  }
  throw e;
}
