# VaultLedger Obsidian plugin — manual smoke test

The plugin glue (`src/views/*`, `src/hover.ts`, `src/main.ts`) has NO automated
test coverage — there is no headless Obsidian to drive it in CI. `bridgeClient.ts`
and `render.ts` (the logic these files wire together) ARE unit tested
(`pnpm -C packages/obsidian-plugin test`). This checklist is how a human
verifies the glue itself against a real Obsidian install.

## 0. Prerequisites

- A real Obsidian vault you don't mind experimenting in (or a fresh empty
  folder opened as a vault).
- The vault is a VaultLedger vault: run `ledger init <vault>` first if it
  isn't already (creates `.ledger/config.json` + `.ledger/permissions.yaml`).
- Node 20+, this repo checked out, `pnpm install` already run at the repo root.

## 1. Build and install the plugin

```sh
pnpm -C packages/obsidian-plugin build
mkdir -p "<vault>/.obsidian/plugins/vaultledger"
cp packages/obsidian-plugin/manifest.json "<vault>/.obsidian/plugins/vaultledger/"
cp packages/obsidian-plugin/main.js "<vault>/.obsidian/plugins/vaultledger/"
```

**Expected:** `main.js` builds with no esbuild errors (~20KB — it should NOT
be large; if it balloons back up into the hundreds of KB, something is
pulling `@vault-ledger/core`'s native-dependent modules — better-sqlite3,
simple-git — back into the bundle. Check that value imports still come
from `@vault-ledger/core/config`, not the full barrel).

In Obsidian: Settings → Community plugins → make sure "Restricted mode" is
off → the "VaultLedger" plugin should appear in the installed list → enable it.

**Expected:** no error notice on enable; the developer console
(Cmd/Ctrl+Shift+I) shows no exception from `main.js`.

## 2. Start the bridge

```sh
pnpm -C packages/cli build   # if not already built
node packages/cli/dist/index.js serve <vault>
```

**Expected:** a line like `VaultLedger bridge on http://127.0.0.1:<port>
(token in <app-support>/<vaultId>/bridge.json)`. Leave this running.

## 2a. Real-Obsidian CORS transport gate (REQUIRED — do not skip)

This is the release gate for 0.4.1. It catches the exact failure unit tests
structurally CANNOT: unit tests run in Node, where there is no browser origin
and no CORS preflight, so a transport that works in vitest can still be blocked
inside real Obsidian. Before 0.4.1 the plugin used a browser `fetch` carrying
`Authorization` + `Content-Type` headers; from the `app://obsidian.md` origin
that fires a CORS preflight (`OPTIONS`) the bridge doesn't answer, so EVERY
request was blocked before auth and every view rendered empty. 0.4.1 routes all
bridge calls through Obsidian's `requestUrl`, which is not subject to the
preflight.

**Steps:**

1. With the bridge running (section 2), queue at least one real approval against
   the SAME vault (see section 3.1 below — a `propose_edit` to a trusted note
   that comes back queued).
2. Open the developer console (Cmd/Ctrl+Shift+I) and keep it visible.
3. Open the Approval Queue view (ribbon icon or "VaultLedger: Open Approval
   Queue").

**PASS:** the view POPULATES — it lists the queued approval (zone, reason,
session, colored diff). No CORS / preflight error in the console.

**FAIL (the regression this gate exists for):** the view is EMPTY (e.g. shows
"No pending approvals." despite a real queued item, or nothing at all) AND the
console shows a CORS / preflight error such as *"Access to fetch at
'http://127.0.0.1:PORT/approvals' from origin 'app://obsidian.md' has been
blocked by CORS policy: Response to preflight request doesn't pass access
control check"* or a failed `OPTIONS` request. That empty-view + console-CORS
pairing is the preflight-block signature. If you see it, the requestUrl
transport is not in effect — do NOT ship the build.

## 3. Approval Queue view

1. Using an agent/MCP client (or `ctx.broker.apply({op:"propose_edit", ...})`
   via a quick script) against the SAME vault, propose an edit to an
   existing trusted note. It should come back queued (not applied).
2. In Obsidian, click the VaultLedger ribbon icon for "Approval Queue" (or
   run the command "VaultLedger: Open Approval Queue" from the command
   palette).

**Expected:** the view lists the pending approval, showing the zone, reason,
session, and a colored diff (green `+` lines, red `-` lines) of the proposed
change.

3. Click **Approve**.

**Expected:** the file on disk is patched to match the proposal, a new git
commit exists, and the approval disappears from the list (view auto-refreshes).
If the underlying file changed since the edit was proposed, approving instead
shows a "went stale" notice and the file is untouched.

4. Propose a second edit and click **Reject**.

**Expected:** the file is untouched; the approval disappears from the list.

## 4. Agent Activity view

1. Open the "Agent Activity" view (ribbon icon or command palette).

**Expected:** recent transactions are grouped by session, each row showing
timestamp / op / path / status, with an **Undo** button on non-reverted rows.

2. Click **Undo** on a transaction.

**Expected:** the change is reverted on disk (file content/existence matches
pre-transaction state) and a new git commit records the revert; the row's
status updates to `reverted` (Undo button no longer shown for it) after refresh.

3. Create a contradiction for the SAME entity. Two preconditions (precision-first
   by design): facts must be `key: value` lines, and at least one side must be a
   **live** belief (`working`/`canonical`) — two fresh `scratch` claims are not
   compared. So the recipe is remember → promote → contradicting remember:
   - `store.remember({ content: "deadline: 2026-08-15", entity: "nova", ... })` → memory A (scratch)
   - `store.promote({ id: A, target_status: "working", ... })` → A is now live (scratch→working is immediate)
   - `store.remember({ content: "deadline: 2026-09-01", entity: "nova", ... })` → contradiction queued
   Contradiction detection runs automatically after each `remember`/`revise`.
   (A bare prose sentence like "nova's deadline is 2026-08-15" extracts no fact
   and will NOT conflict — use the `key: value` form.)
4. Click the "Conflicts" tab.

**Expected:** the tab lists the open conflict — entity, kind, detail (e.g.
`deadline: "2026-08-15" vs "2026-09-01"`), and both memories' id/path — with
**Resolve** and **Dismiss** buttons. If there are no open conflicts, the tab
shows "No open conflicts."

5. Click **Resolve** (or **Dismiss**) on the conflict.

**Expected:** the conflict disappears from the list after the view
auto-refreshes; re-running detection later (e.g. via `ledger conflicts
<vault> --rescan`) does not resurrect a resolved/dismissed conflict.

## 5. Provenance hover

1. Open (or create) a note containing a wikilink to a memory note that has
   `ledger` frontmatter (e.g. one created via `remember`, under `Agent/Memory/`).
2. In reading view, hover the mouse over that wikilink and hold still for a
   moment.

**Expected:** a small popover appears near the cursor showing the linked
note's provenance fields (source / reason / status / confidence / created /
expires) as plain text. Moving the mouse off the link removes the popover.

**Expected (bridge down):** stop `ledger serve` (Ctrl+C in its terminal),
then repeat steps 3/4 above (Approval Queue / Agent Activity views) — each
should show "VaultLedger bridge is not running. Start it with: `ledger serve
<vault>`" instead of an error stack or a hang. Hovering a link with the
bridge down should simply show no popover (no console error).

## 6. Wrong / stale token (optional, defense-in-depth check)

1. With the bridge running, edit `<app-support>/<vaultId>/bridge.json` and
   change one character of `token`, then reopen the Approval Queue view (or
   click its refresh path by reopening it).

**Expected:** the bridge itself still enforces auth (bad token → 401), but
since `BridgeClient.fromVault` re-reads bridge.json fresh each open, restoring
the correct token and reopening the view recovers cleanly — there's no stuck
bad-token state cached anywhere in the plugin.
