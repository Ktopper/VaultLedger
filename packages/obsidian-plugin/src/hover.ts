import { TFile, type Plugin } from "obsidian";
import { BridgeClient, BridgeUnavailableError } from "./bridgeClient.js";
import { renderProvenance, type ProvenanceInfo } from "./render.js";

const HOVER_SOURCE_ID = "vaultledger-provenance";
const POPOVER_CLASS = "vl-provenance-popover";

/**
 * Register a lightweight provenance hover (design v0.2 Phase 4, Task 4.3):
 * hovering an internal link to a note with `ledger` frontmatter shows its
 * provenance (source/reason/status/confidence/created/expires) in a small
 * floating popover. THIN glue: fetching goes through BridgeClient,
 * rendering through the tested renderProvenance — this file only wires
 * "which link, which popover, when to remove it". No automated test
 * coverage (no headless Obsidian) — see SMOKE.md.
 */
export function registerProvenanceHover(
  plugin: Plugin,
  getVaultRoot: () => string,
  transport: typeof fetch,
): void {
  plugin.registerHoverLinkSource(HOVER_SOURCE_ID, {
    display: "VaultLedger provenance",
    defaultMod: false,
  });

  let popoverEl: HTMLElement | undefined;
  const removePopover = (): void => {
    popoverEl?.remove();
    popoverEl = undefined;
  };

  plugin.registerDomEvent(document, "mouseover", (evt: MouseEvent) => {
    const target = evt.target;
    if (!(target instanceof HTMLElement)) return;
    const linkEl = target.closest<HTMLElement>("a.internal-link");
    if (!linkEl) return;

    const href = linkEl.getAttribute("data-href") ?? linkEl.getAttribute("href");
    if (!href) return;

    const sourcePath = plugin.app.workspace.getActiveFile()?.path ?? "";
    const dest = plugin.app.metadataCache.getFirstLinkpathDest(href, sourcePath);
    if (!(dest instanceof TFile)) return;

    void showProvenancePopover(getVaultRoot, transport, dest.path, evt, removePopover, (el) => {
      popoverEl = el;
    });
  });

  plugin.registerDomEvent(document, "mouseout", (evt: MouseEvent) => {
    const target = evt.target;
    if (target instanceof HTMLElement && target.closest("a.internal-link")) {
      removePopover();
    }
  });
}

async function showProvenancePopover(
  getVaultRoot: () => string,
  transport: typeof fetch,
  path: string,
  evt: MouseEvent,
  removePopover: () => void,
  setPopover: (el: HTMLElement) => void,
): Promise<void> {
  try {
    const client = await BridgeClient.fromVault(getVaultRoot(), { fetch: transport });
    const result = await client.provenance(path);
    removePopover();
    if (!result.ok || !result.data.ledger) return;

    const el = document.body.createDiv({ cls: POPOVER_CLASS });
    el.style.position = "fixed";
    el.style.left = `${evt.clientX + 12}px`;
    el.style.top = `${evt.clientY + 12}px`;
    el.style.zIndex = "9999";
    el.appendChild(renderProvenance(coerceProvenance(result.data.ledger)));
    setPopover(el);
  } catch (e) {
    if (!(e instanceof BridgeUnavailableError)) throw e;
    // Bridge not running: silently skip the hover — the Approval Queue /
    // Agent Activity views already surface the "start `ledger serve`"
    // message, no need to duplicate it in a transient hover popover.
  }
}

/**
 * Narrow the bridge's raw `ledger` frontmatter (typed `unknown`, since it's
 * whatever an agent wrote into the note) into a `ProvenanceInfo` HONESTLY: a
 * value survives only if the key is one we render AND its value is a string.
 * This replaces a bare `as ProvenanceInfo` cast (a type-lie — the raw value
 * could be null, an array, nested objects, ...) with a real boundary check.
 * Rendering is textContent-safe regardless; this is about the type reflecting
 * reality, and about never handing renderProvenance a non-string field.
 */
function coerceProvenance(raw: unknown): ProvenanceInfo {
  if (typeof raw !== "object" || raw === null) return {};
  const record = raw as Record<string, unknown>;
  const out: ProvenanceInfo = {};
  const keys: Array<keyof ProvenanceInfo> = [
    "source",
    "reason",
    "status",
    "confidence",
    "created",
    "expires",
  ];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
