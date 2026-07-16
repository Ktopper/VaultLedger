import { FileSystemAdapter, Plugin, requestUrl, type WorkspaceLeaf } from "obsidian";
import { ApprovalsView, APPROVALS_VIEW_TYPE } from "./views/approvals.js";
import { ActivityView, ACTIVITY_VIEW_TYPE } from "./views/activity.js";
import { registerProvenanceHover } from "./hover.js";
import { makeRequestUrlTransport } from "./requestUrlTransport.js";

/**
 * VaultLedger review plugin entry point (design v0.2 Phase 4). A THIN
 * Obsidian host over the `ledger serve` bridge: registers the Approval
 * Queue + Agent Activity views, a ribbon icon + commands to open them, and
 * the provenance hover. All real logic lives in bridgeClient.ts / render.ts
 * (unit tested); this file is untested glue — see SMOKE.md for the manual
 * verification checklist.
 */
export default class VaultLedgerPlugin extends Plugin {
  /**
   * A `fetch`-shaped transport backed by Obsidian's `requestUrl`, built once at
   * load and threaded into every `BridgeClient.fromVault` site (views + hover).
   * This is what makes the views work inside real Obsidian: a plain browser
   * `fetch` from the `app://obsidian.md` origin fires a CORS preflight the
   * bridge doesn't answer, blocking every request; `requestUrl` bypasses it.
   */
  readonly transport: typeof fetch = makeRequestUrlTransport(requestUrl);

  async onload(): Promise<void> {
    this.registerView(APPROVALS_VIEW_TYPE, (leaf) => new ApprovalsView(leaf, () => this.getVaultRoot()));
    this.registerView(ACTIVITY_VIEW_TYPE, (leaf) => new ActivityView(leaf, () => this.getVaultRoot()));

    this.addRibbonIcon("check-check", "VaultLedger: Approval Queue", () => {
      void this.activateView(APPROVALS_VIEW_TYPE);
    });
    this.addRibbonIcon("history", "VaultLedger: Agent Activity", () => {
      void this.activateView(ACTIVITY_VIEW_TYPE);
    });

    this.addCommand({
      id: "open-approval-queue",
      name: "Open Approval Queue",
      callback: () => {
        void this.activateView(APPROVALS_VIEW_TYPE);
      },
    });
    this.addCommand({
      id: "open-agent-activity",
      name: "Open Agent Activity",
      callback: () => {
        void this.activateView(ACTIVITY_VIEW_TYPE);
      },
    });

    registerProvenanceHover(this, () => this.getVaultRoot());
  }

  /**
   * The vault's root path on disk. `Vault.adapter` is a `FileSystemAdapter`
   * on desktop (this plugin's manifest declares `isDesktopOnly: true`) which
   * exposes `getBasePath()`; the `as any` fallback is defensive only — if
   * Obsidian ever runs this on a non-filesystem adapter, callers get a clear
   * empty-path failure (BridgeClient.fromVault -> BrokerError NOT_FOUND)
   * rather than a crash reading a property that doesn't exist.
   */
  private getVaultRoot(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }
    return (adapter as { getBasePath?: () => string }).getBasePath?.() ?? "";
  }

  private async activateView(viewType: string): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(viewType);
    let leaf: WorkspaceLeaf | null;
    if (existing.length > 0) {
      leaf = existing[0] ?? null;
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: viewType, active: true });
      }
    }
    if (leaf) {
      await workspace.revealLeaf(leaf);
    }
  }
}
