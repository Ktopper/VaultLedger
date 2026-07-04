import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import { BridgeClient, BridgeUnavailableError } from "../bridgeClient.js";
import { groupBySession } from "../render.js";

export const ACTIVITY_VIEW_TYPE = "vaultledger-activity";

/**
 * Agent Activity view (design v0.2 Phase 4, Task 4.3): recent transactions
 * grouped by session with a per-transaction Undo button, plus a Conflicts
 * tab placeholder (real conflict detection is v0.3). THIN glue only — see
 * SMOKE.md for the manual verification steps (no automated Obsidian-API
 * test coverage; bridgeClient.ts / render.ts carry the tested logic).
 */
export class ActivityView extends ItemView {
  private tab: "activity" | "conflicts" = "activity";

  constructor(
    leaf: WorkspaceLeaf,
    private readonly getVaultRoot: () => string,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return ACTIVITY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "VaultLedger: Agent Activity";
  }

  getIcon(): string {
    return "history";
  }

  protected async onOpen(): Promise<void> {
    await this.refresh();
  }

  protected async onClose(): Promise<void> {
    // Nothing to tear down between refreshes.
  }

  async refresh(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();

    const tabs = contentEl.createDiv({ cls: "vl-activity-tabs" });
    const activityTab = tabs.createEl("button", { text: "Activity" });
    const conflictsTab = tabs.createEl("button", { text: "Conflicts" });
    activityTab.addEventListener("click", () => {
      this.tab = "activity";
      void this.refresh();
    });
    conflictsTab.addEventListener("click", () => {
      this.tab = "conflicts";
      void this.refresh();
    });

    let client: BridgeClient;
    try {
      client = await BridgeClient.fromVault(this.getVaultRoot());
    } catch (e) {
      this.renderUnavailable(e);
      return;
    }

    if (this.tab === "conflicts") {
      contentEl.createEl("p", { text: "none (v0.3)" });
      return;
    }

    contentEl.createEl("h2", { text: "Agent Activity" });

    const result = await client.transactions();
    if (!result.ok) {
      contentEl.createEl("p", {
        text: `Error loading transactions: ${result.error.code} — ${result.error.message}`,
      });
      return;
    }

    const groups = groupBySession(result.data);
    if (groups.length === 0) {
      contentEl.createEl("p", { text: "No transactions yet." });
      return;
    }

    for (const group of groups) {
      const sessionEl = contentEl.createDiv({ cls: "vl-activity-session" });
      sessionEl.createEl("h3", { text: `session: ${group.session}` });

      for (const txn of group.txns) {
        const row = sessionEl.createDiv({ cls: "vl-activity-txn" });
        row.createEl("span", { text: `${txn.created_at}  ${txn.op}  ${txn.path}  (${txn.status})` });

        if (txn.status === "reverted") continue;

        const undoBtn = row.createEl("button", { text: "Undo" });
        undoBtn.addEventListener("click", () => {
          void (async () => {
            const undoResult = await client.undo(txn.id);
            if (!undoResult.ok) {
              new Notice(`VaultLedger: undo failed — ${undoResult.error.message}`);
            }
            await this.refresh();
          })();
        });
      }
    }
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
