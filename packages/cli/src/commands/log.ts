import type { TransactionRow } from "@vaultledger/core";
import { loadContext, type LoadContextDeps } from "../context.js";

export interface LogFilters {
  entity?: string;
  session?: string;
  limit?: number;
}

export async function logCommand(
  vaultDir: string,
  filters: LogFilters = {},
  deps?: LoadContextDeps,
): Promise<TransactionRow[]> {
  const out = console.log;
  const ctx = await loadContext(vaultDir, deps);
  try {
    const rows = ctx.journal.listTransactions({
      entity: filters.entity,
      session: filters.session,
      limit: filters.limit ?? 20,
    });

    if (rows.length === 0) {
      out("(no transactions)");
    }
    for (const t of rows) {
      out(`${t.created_at}  ${t.op}  ${t.path}  session=${t.session}  status=${t.status}  ${t.id}`);
    }

    return rows;
  } finally {
    ctx.db.close();
  }
}
