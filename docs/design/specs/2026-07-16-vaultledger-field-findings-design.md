# VaultLedger — field-findings batch (0.4.3 + plugin 0.4.1)

**Date:** 2026-07-16
**Status:** design (pre-implementation)
**Source:** two bugs from live Hermes end-to-end testing, both verified against a
running system. Independent (different packages, different delivery), batched by
provenance.

**Two release trains in one batch — say it loudly so nobody conflates them:**
- **WU-1** (propose-time patch validation) → `@vault-ledger/core` + `@vault-ledger/mcp-server` bump to **0.4.3**, published to npm (ordered core → mcp-server).
- **WU-2** (plugin view staleness) → `@vault-ledger/obsidian-plugin` is `private:true`, **NOT on npm**. It ships via a **manifest version bump + esbuild rebuild**, distributed through the Obsidian community store / GitHub releases / `ledger setup --install-plugin`. Plugin → **0.4.1** (its own cadence — it hasn't moved since 0.4.0). **Do not `npm publish` the plugin.**

---

## WU-1 — Propose-time patch validation (core + mcp-server)

### The bug (grounded)

`vault_propose_edit` accepts a patch the approval path cannot apply. The parse
guard (`parsePatch`, ≥1 hunk, single-file) lives in `applyPatch`
(`packages/core/src/broker/patch.ts:176-188`) and runs only at **approval**
time (`broker.ts:327`). The propose-time enqueue path `applyProposeEdit`
(`broker.ts:420`) does traversal + zone + `MALFORMED_HASH` guards but **never
parses the patch**. So a V4A-format patch (`*** Begin Patch` style) — which
`parsePatch` yields **zero hunks** for — enqueues cleanly, and every approval
surface then fails with `SYNTAX_BREAK: unparseable or empty patch`. Confirmed:
Hermes queued V4A patches; they queued; approval died.

### The fix

**Extract the parse guard into one shared function** so propose and apply agree
on what "parseable" means (single source of truth):

```ts
// patch.ts — extracted from applyPatch's current parse guard.
// NOTE: patch.ts currently imports only `StructuredPatchHunk` from "diff";
// this extraction must ALSO import `StructuredPatch` (the per-file parse type
// parsePatch returns).
import { applyPatch as diffApply, parsePatch, type StructuredPatch, type StructuredPatchHunk } from "diff";

/** ONE format-naming hint, appended to BOTH rejection messages (0-hunks and
 * multi-file) so the code an agent sees is `SYNTAX_BREAK` regardless of site,
 * and the message always tells it the expected shape — agents guess otherwise. */
const PATCH_FORMAT_HINT =
  "patch must be a unified diff (`---`/`+++` file headers, `@@` hunks) for a single file — " +
  "the V4A / `*** Begin Patch` style is NOT accepted";

export function assertPatchParseable(patchText: string, retriable = false): StructuredPatch[] {
  const parsed = parsePatch(patchText);
  if (parsed.length === 0 || parsed.every((f) => f.hunks.length === 0)) {
    throw new BrokerError("SYNTAX_BREAK", `no parseable hunks — ${PATCH_FORMAT_HINT}`, retriable);
  }
  if (parsed.length !== 1) {
    throw new BrokerError(
      "SYNTAX_BREAK",
      `patch spans ${parsed.length} files; only single-file patches are supported — ${PATCH_FORMAT_HINT}`,
      retriable,
    );
  }
  return parsed;
}
```

(A V4A `*** Begin Patch` string parses to 1 file / **0 hunks** — verified with
jsdiff at spec review — so it's the empty-hunk clause, checked first, that
catches it.)

- **`applyProposeEdit` calls `assertPatchParseable(op.patch, /* retriable */ true)`** — after the `MALFORMED_HASH` guard, before it enqueues. So an unapplyable proposal **can never enter the queue**, and the agent gets a **`retriable:true`** rejection it can fix-and-retry on. (`brokerError` already forwards `e.toRejection()`, which carries `retriable`; `BrokerError`'s constructor takes a per-call override — `SYNTAX_BREAK` defaults to `false` in the RETRIABLE map, so the `true` here is explicit and scoped to the propose site.)
- **`applyPatch` keeps calling `assertPatchParseable(patchText)`** (default `retriable:false`) as its first step, then does its existing ordering/landing checks on the returned parse. **The apply-time check MUST stay** — defense in depth: the queue can carry proposals enqueued *before* this fix (Kris's vault has three right now), and the applier must never assume propose validated. Apply-time semantics unchanged: a human at the approval surface can't fix a patch by retrying, so it stays non-retriable.
- **Same code (`SYNTAX_BREAK`), two sites, format-naming message at BOTH** — because the same malformed patch can now be caught at either site, and if the sites used different codes the code an agent sees would depend on *when* it was caught, not *what's wrong*. The shared helper carries the format message to both automatically.

### Tool description

`vault_propose_edit`'s description (`tools.ts`) must state the format where the
agent reads it:
> `\`patch\` must be a unified diff (\`---\`/\`+++\` file headers, \`@@\` hunks) for a single file — NOT \`*** Begin Patch\` / V4A style.`

### Stranded proposals — the recovery path (state it, it's live-tested)

WU-1 stops *new* unapplyable proposals; it does nothing for ones **already
queued** (Kris's three, and any user who upgrades with junk queued). Recovery:
**`--reject` discards a queued proposal without parsing its patch**, so it works
on a malformed one. Kris's three pre-fix proposals are the live test of this
sentence — reject them post-build.

### Regression test (mirrors the real repro)

A V4A patch (`*** Begin Patch\n...\n*** End Patch`) passed to `vault_propose_edit`
is **rejected at propose time** (`SYNTAX_BREAK`, `retriable:true`, message names
the format) and **never enters the queue** (`approvals.list()` stays empty).
Plus: `assertPatchParseable` unit tests (V4A → throws; a valid unified diff →
returns the single-file parse; multi-file → throws), and a test that a proposal
with a valid unified-diff patch still enqueues (no regression).

---

## WU-2 — Plugin views empty in real Obsidian (obsidian-plugin)

### ROOT CAUSE (found after the initial staleness framing — supersedes it as the PRIMARY bug)

The views are not merely *stale* — inside real Obsidian they are **never
populated at all**. `BridgeClient.request()` (`bridgeClient.ts:198`) sends the
bridge request via **browser `fetch`** with `Authorization: Bearer <token>` and
`Content-Type: application/json` headers. Both are **non-simple** headers, so
from the plugin's `app://obsidian.md` origin the browser fires a **CORS
preflight (`OPTIONS`)** first. The bridge (`@vault-ledger/server`) correctly
does **not** answer preflights — it is a localhost, token-authed, browser-origin-
ignorant server — so the preflight fails and **every view request is blocked
before auth ever happens**. Console evidence attached to the finding.

This reorders WU-2: the **transport fix (below) is the primary bug** — without
it the views never work in Obsidian at all. The three staleness fixes
(refresh-on-reveal, refresh button, reconnect) are real and still wanted, but
they layer *on top* of a transport that actually reaches the bridge.

### Fix 0 (PRIMARY) — a `requestUrl`-backed transport

Obsidian ships `requestUrl()` — an HTTP function that runs in Electron's **main
process, not the browser renderer**, so it makes **no CORS preflight**. Route
the plugin's bridge calls through it:

- **Keep the existing injectable transport seam.** `BridgeClientDeps.fetch`
  (`bridgeClient.ts:133`, defaulting to `fetch.bind(globalThis)`) is already the
  seam the 8 existing tests and the planned reconnect logic depend on — **do not
  churn it**. `bridgeClient.ts` stays `obsidian`-free and Node-testable.
- **Inject a `requestUrl`-backed adapter from `main.ts` at plugin load.**
  `main.ts` already imports from `"obsidian"`; add a small
  `requestUrlTransport` (its own plugin-only module, e.g.
  `src/requestUrlTransport.ts`, which imports `requestUrl` from `"obsidian"`)
  that is `typeof fetch`-compatible: maps `init` → `requestUrl` params, sets
  `throw: false` so a non-2xx returns its status (matching how `request()`
  reads `res.status`/`res.ok`), and returns a real `Response`
  (`new Response(bodyText, { status, headers })`) so `request()`'s existing
  `res.ok`/`res.json()`/`res.status` handling is unchanged. `BridgeClient.fromVault`
  is called with `{ fetch: requestUrlTransport }` from `main.ts`.
- **Preserve timeout semantics manually.** `requestUrl` has **no** timeout /
  `AbortSignal` support (today's `request()` relies on `AbortSignal.timeout`).
  The adapter must enforce the timeout itself — race the `requestUrl` promise
  against a timer and reject with an `AbortError`/`TimeoutError`-named error, so
  `request()`'s existing timeout branch (`:213-217`) still maps it to the
  "bridge wedged" message. Confirm the wedged-timeout test still passes through
  the adapter.
- **GROUND-CHECK the `requestUrl` API against the local `.d.ts`, not memory
  (named plan-review item).** Every claim here about `requestUrl` — that
  `throw: false` suppresses status-based throws, that the response exposes
  `.json`/`.text`/`.arrayBuffer`/`.status`/`.headers` as **properties** (not
  methods, unlike `fetch`'s `Response`), that there is no timeout/`AbortSignal`,
  and the `RequestUrlParam` field names — is currently **docs-level**. `obsidian`
  is a devDependency; its `.d.ts` is in `node_modules`. The plan must read
  `RequestUrlParam` / `RequestUrlResponse` from that file and pin the adapter's
  mapping to what's actually declared. This is the ONE place an invented detail
  could reach runtime, because no unit test executes the real `requestUrl`.
- **Connection-level failures MUST throw through the adapter (this is where Fix
  0 and Fix 3 compose).** `throw: false` only suppresses HTTP *error statuses*.
  A **connection-level** failure (dead port — the exact reconnect trigger) still
  **rejects** the `requestUrl` promise. The adapter must **pass that rejection
  through unchanged** — do NOT swallow it into a synthetic error-status
  `Response`. `#doRequest`'s connection-failure throw is what arms the reconnect
  logic (Fix 3); if the adapter absorbs it into a fake response, reconnect
  **silently never fires** under the new transport. Test case: adapter + dead
  port → **throws** → `request()`'s reconnect path engages.
- **Null-body status guard in the `Response` construction.** `new Response(body,
  { status })` **throws** when `status` is a null-body status (204/205/304) and
  `body` is non-null. If any bridge endpoint ever returns 204, the adapter would
  die constructing the reply. Guard: pass a **null** body for null-body statuses.
  A fixture must cover a 204 or the tests won't see it.
- **LOAD-BEARING: the transport must reach every `fromVault` call site, which is
  inside the VIEWS, not `main.ts`.** `approvals.ts`/`activity.ts` `refresh()`
  each call `BridgeClient.fromVault(this.getVaultRoot())` themselves — those are
  where the real requests originate. If the transport is injected only where
  `main.ts` happens to build a client but the views keep calling `fromVault`
  with the default (browser) fetch, the views stay broken. So the plugin holds
  the `requestUrlTransport` (created in `main.ts` at load) and every view's
  `fromVault` call is given it (view gets it via its plugin reference /
  constructor). `fromVault`'s `deps` already accepts `fetch` — thread it through.

**REJECTED ALTERNATIVE — do NOT add CORS headers to the bridge.** Answering the
preflight (`Access-Control-Allow-Origin`/`-Headers` on `@vault-ledger/server`)
would "fix" it too, but it makes the security-critical bridge browser-origin-
aware and invites a class of cross-origin reasoning the server deliberately
avoids. The bridge stays localhost + token + origin-ignorant **by design**; the
plugin adapts its transport to that, not the reverse.

### META-FINDING — why this shipped, and the gate that stops the next one

The 8 `bridgeClient` unit tests exercise the client from **Node**, where there
is **no browser and no CORS preflight** — so a transport that works perfectly in
tests is blocked in real Obsidian. **The plugin was never verified inside a real
Obsidian install.** SMOKE.md exists but its checklist did not catch empty views.
Two additions:
1. **Now:** add a SMOKE.md item that explicitly opens the Approval Queue view in
   a **real Obsidian** against a running `ledger serve` **with a queued
   approval**, and asserts the view **populates** (a preflight block shows as an
   empty view + a console CORS error — exactly what a "does it show the pending
   approval?" step catches).
2. **Store-submission track:** a **real-Obsidian verification gate** — no plugin
   release is "done" on unit tests alone; it must be loaded into Obsidian and
   its views confirmed to populate against a live bridge.

### The staleness fixes (SECONDARY — still wanted, layered on the new transport)

Three failure modes, unchanged by the transport fix (they compose on top of it):

1. The Approval Queue view refreshes only on `onOpen` (first creation,
   `approvals.ts:34`). `activateView` (`main.ts:60-73`) **reveals an existing
   leaf without refreshing** (`revealLeaf`, no `refresh()` call) — so re-running
   the open command shows a stale queue.
2. **No manual refresh control** in the view.
3. A `BridgeClient` is bound to a fixed port at construction; the approve/reject
   button closures capture it (`approvals.ts` `renderApproval`). A **bridge
   restart changes the port** (and, with `--rotate-token`, the token) and
   **strands** those captured clients — their requests hit a dead port with no
   recovery.

### The fix

1. **Refresh on reveal** — `activateView`, when revealing an EXISTING leaf, calls
   `view.refresh()`. Since `refresh()` re-runs `BridgeClient.fromVault` (fresh
   discovery), this also re-reads the current bridge port/token. Extract the
   "reveal → refresh" decision from the Obsidian-coupled `activateView` into a
   small testable unit.
2. **Refresh affordance** — a "Refresh" button in the Approval Queue (and
   Activity) view header, wired to `refresh()`.
3. **Reconnect on dead bridge** — `BridgeClient.fromVault` captures `vaultRoot` +
   `env` on the instance so the client can **re-discover**. On a **connection
   failure** (dead port — the throw that today becomes `BridgeUnavailableError`),
   the client **re-reads `bridge.json`** (picking up a restarted bridge's new
   **port AND token** — so `--rotate-token` is handled too), updates its
   baseUrl+token, and **retries the request once**. If discovery finds no bridge,
   or the retry also fails, THEN `BridgeUnavailableError` (unchanged surface for
   "truly not running").
   - **Mechanism — no recursion/storm:** the current single private `request()`
     (all 15 methods funnel through it) becomes a thin wrapper over an inner
     `#doRequest(...)` that performs exactly one fetch. `request()` calls
     `#doRequest` **at most twice**: once; on a connection-failure throw, it
     re-discovers then calls `#doRequest` **once more** (the retry does NOT go
     back through the reconnect wrapper). A persistently-dead port therefore
     fails after exactly two attempts, never recurses.
   - **Only a `fromVault`-built client can reconnect** (it holds `vaultRoot`/`env`).
     A client built with the bare `new BridgeClient(url, token)` constructor has
     nothing to re-discover from, so its reconnect is a no-op → it fails as
     today. That's fine (production always uses `fromVault`), but the tests must
     build via `fromVault` (see below).

Together these cover the repro "a pane opened before the bridge starts, then it
starts": reveal-refresh or the button re-discovers; and a mid-session restart is
transparently reconnected.

### Test coverage (CORRECTION)

The plugin **does** have test coverage — `packages/obsidian-plugin/test/bridgeClient.test.ts`
has 8 tests and already fakes a live bridge (a real port + injected `fetch`),
including a "network failure (bridge down) → `BridgeUnavailableError`" case
(:339) and `fromVault` discovery via a written `bridge.json` (:296-321). The
`approvals.ts` view is what lacks coverage. **Extend the existing bridgeClient
harness** for the reconnect tests — do NOT stand up parallel scaffolding.
**The reconnect tests MUST build the client via `fromVault`** (only that path
captures `vaultRoot`/`env` and can re-discover — the harness's existing
failure tests use the bare `new BridgeClient(url, token)` constructor, which
cannot reconnect), and rewrite `bridge.json` (port A → port B, rotated token)
between calls using the harness's existing bridge-file/bridge-start helpers:
- request against port A fails (connection error) → client re-discovers (rewrite
  `bridge.json` to port B + a rotated token) → retries → succeeds on B, using
  the rotated token (auth follows).
- request fails AND re-discovery finds no bridge (`bridge.json` removed) →
  `BridgeUnavailableError`.
- request fails AND the retry against B also fails → `BridgeUnavailableError`
  (exactly two attempts, then give up — no recursion).

The reveal-refresh gets a unit test on the extracted decision; the header
Refresh button is view-coupled (Obsidian API) and is validated by build +
manual smoke, not a unit test (consistent with the view's existing
no-unit-coverage reality).

### Plugin release mechanics (well-formed for the store track)

`manifest.json` version `0.4.0 → 0.4.1`, `package.json` version to match, and
`versions.json` maps `"0.4.1"` → the correct `minAppVersion` (Obsidian's
plugin-version → min-app-version map). The upcoming **Obsidian store-submission
track** will formalize these mechanics; this bump should already follow that
shape (manifest version + `minAppVersion` mapping) so it's the store
submission's **first well-formed release**, not a one-off to redo. esbuild
rebuild (`main.js`) required — `tsc` doesn't produce it.

---

## Versioning & publish

- **core + mcp-server → 0.4.3** (`VERSION`, `SERVER_VERSION`, both package.json;
  update `packages/core/test/placeholder.test.ts`). **cli stays 0.4.1, server
  stays 0.4.0.**
- **Publish (WU-1, npm):** ordered `core` → `mcp-server`, both `--access public`.
  `verify-publish.mjs` (reads each sibling's local version) should pass the new
  graph — verify, don't assume.
- **Plugin (WU-2, NOT npm):** version bump + esbuild rebuild; distribute via
  store / releases / `--install-plugin`. `ledger setup --install-plugin` /
  `checkPluginFreshness` compares manifest versions, so the bump is what makes
  existing installs report "outdated".
- doctor's `major.minor` keeps cli@0.4.1 ↔ mcp-server@0.4.3 quiet (both 0.4).

## File structure

**Modify (WU-1):**
- `packages/core/src/broker/patch.ts` — extract `assertPatchParseable`; `applyPatch` calls it.
- `packages/core/src/broker/broker.ts` — `applyProposeEdit` calls `assertPatchParseable(op.patch, true)`.
- `packages/mcp-server/src/tools.ts` — `vault_propose_edit` description states the format.
- Tests: `packages/core/test/broker/patch.test.ts` (or broker test) + a propose-time rejection test.
- Version: core/mcp-server package.json, `core/src/index.ts` VERSION, `mcp-server/src/index.ts` SERVER_VERSION, `core/test/placeholder.test.ts`.

**Create (WU-2):**
- `packages/obsidian-plugin/src/requestUrlTransport.ts` — the `requestUrl`-backed, `typeof fetch`-compatible adapter (imports `requestUrl` from `"obsidian"`; manual timeout). Keeps `obsidian` out of `bridgeClient.ts`.

**Modify (WU-2):**
- `packages/obsidian-plugin/src/main.ts` — inject `requestUrlTransport` into `BridgeClient.fromVault` (Fix 0); reveal → refresh (Fix 1).
- `packages/obsidian-plugin/src/views/approvals.ts` (+ `activity.ts`) — Refresh button (Fix 2); thread the injected transport into the `fromVault` calls these views make (so the views' own `fromVault` uses `requestUrl`, not browser fetch — this is the load-bearing part of Fix 0).
- `packages/obsidian-plugin/src/bridgeClient.ts` — re-discover + retry-once on connection failure (`request()` → inner `#doRequest`); `fromVault` captures vaultRoot/env. **Stays `obsidian`-free** (uses the injected transport).
- `packages/obsidian-plugin/test/bridgeClient.test.ts` — extend with reconnect tests.
- `packages/obsidian-plugin/SMOKE.md` — add the real-Obsidian "views populate against a live bridge" item (the meta-finding gate).
- `packages/obsidian-plugin/manifest.json` (0.4.0→0.4.1; `minAppVersion` is `1.5.0`), `package.json` (→0.4.1) — modify.
- `packages/obsidian-plugin/versions.json` — **CREATE** (does not exist yet): `{ "0.4.1": "1.5.0" }` (plugin-version → minAppVersion). Store-track-only — `checkPluginFreshness`/`--install-plugin` compare `manifest.json` only, not this file.

## Non-goals
- Not reworking the approval view's rendering or adding view unit-test infra beyond the extracted reveal-refresh decision.
- Not the full Obsidian store submission (separate track) — only making this plugin bump well-formed for it.
- Not changing apply-time patch semantics (landing/ordering checks, non-retriable) — only adding the shared parse guard earlier.
