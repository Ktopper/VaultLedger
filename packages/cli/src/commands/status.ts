import type { ApprovalRow, TransactionRow } from "@vault-ledger/core";
import { loadContext, type LoadContextDeps } from "../context.js";

export interface StatusResult {
  zones: {
    trusted: string[];
    agent: string[];
    scratch: string[];
    excluded: string[];
  };
  pendingApprovals: ApprovalRow[];
  recentTransactions: TransactionRow[];
}

export async function statusCommand(
  vaultDir: string,
  deps?: LoadContextDeps,
): Promise<StatusResult> {
  const out = console.log;
  const ctx = await loadContext(vaultDir, deps);
  try {
    const zones = ctx.manifest.zones;
    const pendingApprovals = ctx.approvals.list();
    const recentTransactions = ctx.journal.listTransactions({ limit: 10 });

    out(`Vault: ${ctx.vaultRoot} (${ctx.config.vaultId}), mode=${ctx.config.mode}`);
    out(
      `Zones: trusted=[${zones.trusted.join(",")}] agent=[${zones.agent.join(",")}] ` +
        `scratch=[${zones.scratch.join(",")}] excluded=[${zones.excluded.join(",")}]`,
    );
    out(`Pending approvals: ${pendingApprovals.length}`);
    out(`Recent transactions: ${recentTransactions.length}`);
    for (const t of recentTransactions) {
      out(`  ${t.created_at}  ${t.op}  ${t.path}  (${t.status})`);
    }

    return { zones, pendingApprovals, recentTransactions };
  } finally {
    ctx.db.close();
  }
}
