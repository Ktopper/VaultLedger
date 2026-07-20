import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import { BridgeClient, BridgeUnavailableError, type ApprovalWithDiff } from "../bridgeClient.js";
import { renderApprovalBody } from "../render.js";

export const APPROVALS_VIEW_TYPE = "vaultledger-approvals";

/**
 * Approval Queue view (design v0.2 Phase 4, Task 4.3). Deliberately THIN:
 * all logic (discovery, typed calls, diff rendering) lives in bridgeClient.ts
 * / render.ts, which ARE unit tested. This class only wires
 * fetch -> render -> button -> refresh, and has no automated test coverage
 * (no headless Obsidian) — see SMOKE.md for the manual verification steps.
 */
export class ApprovalsView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly getVaultRoot: () => string,
    // The plugin's Obsidian-`requestUrl`-backed transport. Threaded into
    // `fromVault` so bridge calls dodge the CORS preflight that (with a plain
    // browser `fetch`) blocks every request from the app:// origin — the whole
    // reason the views were empty inside real Obsidian.
    private readonly transport: typeof fetch,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return APPROVALS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "VaultLedger: Approval Queue";
  }

  getIcon(): string {
    return "check-check";
  }

  protected async onOpen(): Promise<void> {
    await this.refresh();
  }

  protected async onClose(): Promise<void> {
    // Nothing to tear down: refresh() re-renders contentEl from scratch each
    // time and holds no timers/subscriptions between calls.
  }

  async refresh(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();

    const header = contentEl.createDiv({ cls: "vl-approval-header" });
    header.createEl("h2", { text: "Approval Queue" });
    const refreshBtn = header.createEl("button", { text: "Refresh", cls: "vl-refresh-btn" });
    refreshBtn.addEventListener("click", () => {
      void this.refresh();
    });

    let client: BridgeClient;
    try {
      client = await BridgeClient.fromVault(this.getVaultRoot(), { fetch: this.transport });
    } catch (e) {
      this.renderUnavailable(e);
      return;
    }

    const result = await client.approvals();
    if (!result.ok) {
      contentEl.createEl("p", {
        text: `Error loading approvals: ${result.error.code} — ${result.error.message}`,
      });
      return;
    }

    if (result.data.length === 0) {
      contentEl.createEl("p", { text: "No pending approvals." });
      return;
    }

    for (const approval of result.data) {
      this.renderApproval(client, approval);
    }
  }

  private renderApproval(client: BridgeClient, approval: ApprovalWithDiff): void {
    const item = this.contentEl.createDiv({ cls: "vl-approval-item" });
    item.createEl("h3", { text: `${approval.zone} — ${approval.reason ?? "(no reason given)"}` });
    item.createEl("p", { cls: "vl-approval-meta", text: `session: ${approval.session}` });
    item.appendChild(renderApprovalBody(approval.held_operation, approval.diff));

    const actions = item.createDiv({ cls: "vl-approval-actions" });

    const approveBtn = actions.createEl("button", { text: "Approve" });
    approveBtn.addEventListener("click", () => {
      void this.runAction(async () => {
        const res = await client.approve(approval.id);
        if (res.ok && "stale" in res.data && res.data.stale) {
          new Notice("VaultLedger: this edit went stale (the file changed) — rejected automatically.");
        } else if (!res.ok) {
          new Notice(`VaultLedger: approve failed — ${res.error.message}`);
        }
      });
    });

    const rejectBtn = actions.createEl("button", { text: "Reject" });
    rejectBtn.addEventListener("click", () => {
      void this.runAction(async () => {
        const res = await client.reject(approval.id);
        if (!res.ok) {
          new Notice(`VaultLedger: reject failed — ${res.error.message}`);
        }
      });
    });
  }

  private async runAction(fn: () => Promise<void>): Promise<void> {
    await fn();
    await this.refresh();
  }

  private renderUnavailable(e: unknown): void {
    if (e instanceof BridgeUnavailableError) {
      this.contentEl.createEl("p", {
        text: "VaultLedger bridge is not running. Start it with: ledger serve <vault>",
      });
    } else {
      this.contentEl.createEl("p", {
        text: `VaultLedger error: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
}
