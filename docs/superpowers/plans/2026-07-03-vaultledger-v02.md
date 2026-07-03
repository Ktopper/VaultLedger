# VaultLedger v0.2 Implementation Plan — Obsidian review surface + bridge

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the v0.2 review surface — a `ledger serve` HTTP bridge over the v0.1 core and an Obsidian plugin (approval queue, agent-activity/undo, provenance hover, staleness) — made safe for the plugin and the MCP server to run against one vault concurrently.

**Architecture:** `core` gains a WAL journal, a cross-process mutation lock, and an `openVault()` stack factory. A new `packages/server` (fastify) exposes core over token-authed loopback HTTP; `ledger serve` starts it and publishes a discovery file to app-support (never the synced vault). The Obsidian plugin is a thin HTTP client with XSS-safe DOM rendering; its Obsidian-API glue is manually verified (no headless Obsidian).

**Tech Stack:** TypeScript (strict, ESM, project refs), pnpm, vitest, fastify, proper-lockfile, better-sqlite3 (WAL), the existing `@vaultledger/core`, esbuild + obsidian types (plugin bundle).

**Reference:** Spec at `docs/superpowers/specs/2026-07-03-vaultledger-v02-design.md` (read it; §N below refer to it). Builds on the hardened v0.1 core (`docs/superpowers/specs/2026-07-02-vaultledger-v01-design.md`). Branch: `feat/v0.2-review-plugin`.

**Applies throughout:** REQUIRED SUB-SKILL per task: superpowers:test-driven-development. Explicit-path git staging only (never `git add -A` — this repo nests in a shared repo). Do NOT `git push` from task subagents. `.js` import extensions (NodeNext). Inject clock/id in tests (no `Date.now`/`Math.random` in `src`; `Date.parse` is fine). Temp vaults + temp HOME (inject `env`) so the journal/app-support land in temp dirs; clean up.

---

## File Structure

```
packages/
├── core/
│   └── src/
│       ├── journal/db.ts          # MODIFY: WAL + busy_timeout pragmas
│       ├── concurrency/lock.ts    # NEW: cross-process mutation lock (proper-lockfile)
│       ├── broker/broker.ts       # MODIFY: acquire lock around mutating ops
│       ├── broker/undo.ts         # MODIFY: acquire lock around undo
│       ├── host/openVault.ts      # NEW: openVault() stack factory + VaultContext
│       └── index.ts               # export openVault, lock, VaultContext
├── server/                        # NEW package @vaultledger/server
│   ├── package.json  tsconfig.json
│   └── src/
│       ├── app.ts                 # buildBridge(ctx, token) -> fastify app (routes, auth, origin guard, error map)
│       ├── render.ts              # server-side diff render (reuse cli diff)
│       ├── start.ts               # startBridge(vaultRoot, opts) -> {app, port, token, close}
│       └── index.ts
├── cli/
│   └── src/commands/serve.ts      # NEW: ledger serve (bridge.json 0600, --port, --rotate-token, lifecycle)
└── obsidian-plugin/               # was STUB — now real
    ├── manifest.json  esbuild.config.mjs  SMOKE.md
    └── src/
        ├── bridgeClient.ts        # typed fetch client; discovery via vaultId->app-support/bridge.json
        ├── render.ts              # PURE DOM builders (XSS-safe); unit-tested incl hostile fixture
        ├── views/approvals.ts     # ItemView glue (manual verify)
        ├── views/activity.ts      # ItemView glue (manual verify)
        ├── hover.ts               # provenance hover glue (manual verify)
        └── main.ts                # Plugin entry: register views/hover/commands
```

---

## Phase 0 — Dependencies & package scaffolds

### Task 0.1: Add deps; scaffold `packages/server`

**Files:** Modify `packages/core/package.json`; Create `packages/server/{package.json,tsconfig.json,src/index.ts,test/placeholder.test.ts}`; Modify root `tsconfig.json` (add server ref).

- [ ] **Step 1:** Add to `packages/core/package.json` deps: `"proper-lockfile": "^4.1.2"`, and devDeps `"@types/proper-lockfile": "^4.1.4"`.
- [ ] **Step 2:** Create `packages/server/package.json`:

```json
{
  "name": "@vaultledger/server",
  "version": "0.2.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc -b", "test": "vitest run" },
  "dependencies": {
    "@vaultledger/core": "workspace:*",
    "fastify": "^5.0.0",
    "diff": "^7.0.0"
  }
}
```

- [ ] **Step 3:** `packages/server/tsconfig.json` extends base, `rootDir: src`, `outDir: dist`, `references: [{ "path": "../core" }]`. `src/index.ts`: `export const VERSION = "0.2.0";`. Placeholder test asserts it. Add `{ "path": "packages/server" }` to root `tsconfig.json` references.
- [ ] **Step 4:** `corepack enable pnpm && pnpm install && pnpm build && pnpm test` — all green (proper-lockfile + fastify install; server placeholder passes).
- [ ] **Step 5: Commit** `chore: add proper-lockfile + scaffold @vaultledger/server`

### Task 0.2: Make `packages/obsidian-plugin` a real (buildable) plugin

**Files:** Modify `packages/obsidian-plugin/package.json`, `tsconfig.json`; Create `manifest.json`, `esbuild.config.mjs`; keep `src/index.ts` stub for now (replaced in Phase 4).

- [ ] **Step 1:** Add devDeps to the plugin package.json: `"obsidian": "^1.7.2"`, `"esbuild": "^0.24.0"`, `"@vaultledger/core": "workspace:*"` (for the app-support path resolver types/values it reuses). Add scripts: `"build": "node esbuild.config.mjs"`, `"test": "vitest run"`.
- [ ] **Step 2:** `manifest.json`:

```json
{
  "id": "vaultledger",
  "name": "VaultLedger",
  "version": "0.2.0",
  "minAppVersion": "1.5.0",
  "description": "What does my agent believe? Approval queue, provenance, and one-click rollback for VaultLedger.",
  "author": "Kristopher Dunham",
  "isDesktopOnly": true
}
```

- [ ] **Step 3:** `esbuild.config.mjs` bundles `src/main.ts` → `main.js` (format `cjs`, platform `node`, external `["obsidian", "electron"]`, bundle true, sourcemap). (Obsidian loads a CJS `main.js`.)
- [ ] **Step 4:** `pnpm -C packages/obsidian-plugin build` produces `main.js` (once `src/main.ts` exists in Phase 4 — for now point esbuild at the stub `src/index.ts` OR defer the build assertion to Phase 4; keep the placeholder vitest test green).
- [ ] **Step 5: Commit** `chore: real obsidian-plugin package (manifest + esbuild)`

---

## Phase 1 — Core: WAL journal, cross-process lock, openVault

### Task 1.1: Journal in WAL + busy_timeout

**Files:** Modify `packages/core/src/journal/db.ts`; Test `packages/core/test/journal/db.wal.test.ts`.

- [ ] **Step 1: Failing test** — open a **file-backed** journal (temp path), assert `db.pragma("journal_mode", {simple:true}) === "wal"` and `db.pragma("busy_timeout",{simple:true}) === 5000`. (`:memory:` DBs can't use WAL — see step 3.)
- [ ] **Step 2:** Run — FAIL (pragmas not set).
- [ ] **Step 3: Implement** — in `openJournal(dbPath)`, after opening: if `dbPath !== ":memory:"` run `db.pragma("journal_mode = WAL")`; always `db.pragma("busy_timeout = 5000")`. (Guard WAL on `:memory:` so the existing in-memory tests are unaffected.)
- [ ] **Step 4:** Run — PASS; then run the whole core suite to confirm no regression (`pnpm -C packages/core test`).
- [ ] **Step 5: Commit** `feat(core): journal WAL + busy_timeout`

### Task 1.2: Cross-process mutation lock

**Files:** Create `packages/core/src/concurrency/lock.ts`; Test `packages/core/test/concurrency/lock.test.ts`.

Design: a small wrapper over `proper-lockfile` with the staleness-safe config (§3): `update` ≪ `stale`.

- [ ] **Step 1: Failing tests:**
  - `withVaultLock(lockDir, fn)` runs `fn` while holding an exclusive lock and returns its result; the lockfile is released afterward (a second `withVaultLock` on the same dir succeeds).
  - **Serialization:** two overlapping `withVaultLock` calls on the same dir do NOT run their critical sections concurrently (use a shared counter/flag; assert max concurrency 1).
  - **Slow critical section doesn't get its lock stolen:** with an artificially slow `fn` (delay longer than `update` but well under `stale`), a second acquirer waits and runs only after the first releases (assert ordering, not overlap). This is the slow-commit guard from §3.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement:**

```ts
import lockfile from "proper-lockfile";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// update ≪ stale: an active holder refreshes the lock mtime every `update` ms,
// so a slow transaction (e.g. a cold-disk git commit) is never mistaken for a
// crashed holder and stolen mid-flight (§3).
const LOCK_OPTS = {
  stale: 20000,
  update: 2000,
  retries: { retries: 50, factor: 1.5, minTimeout: 50, maxTimeout: 1000 },
} as const;

/** Run `fn` while holding the vault's cross-process mutation lock. */
export async function withVaultLock<T>(lockDir: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(lockDir, { recursive: true });
  // Lock a stable path under the app-support vault dir (proper-lockfile locks a
  // path by creating `<path>.lock`; the target need not exist as a file).
  const target = join(lockDir, "vault");
  const release = await lockfile.lock(target, { ...LOCK_OPTS, realpath: false });
  try {
    return await fn();
  } finally {
    await release();
  }
}

export const LOCK_CONFIG = LOCK_OPTS; // exported so a test can assert update < stale
```

- [ ] **Step 4:** Run — PASS (all three). Add a test asserting `LOCK_CONFIG.update < LOCK_CONFIG.stale`.
- [ ] **Step 5: Commit** `feat(core): cross-process vault mutation lock`

### Task 1.3: Wire the lock into the broker's mutating boundary + undo

**Files:** Modify `packages/core/src/broker/broker.ts`, `packages/core/src/broker/undo.ts`; Tests alongside.

Per §3, the lock wraps the broker's mutating operations and `undo*`; everything else (Approvals, MemoryStore, TTL sweep) reaches mutation through them, so it's inherited.

- [ ] **Step 1:** The `Broker` needs a `lockDir` (the app-support `<vaultId>/` dir). Add `lockDir?: string` to the Broker constructor opts. When set, wrap the body of each mutating op — `applyCreate`, `applyRevise`, `applyProposeEdit` (only the actual write path; the propose_edit **queue** path is a journal-only write and may also take the lock for row-insert safety — simplest: wrap the whole `apply` for create/revise/propose_edit and `archive`), — in `withVaultLock(lockDir, ...)`. When `lockDir` is undefined (existing tests), behavior is unchanged (no lock) — so all v0.1 tests still pass.
- [ ] **Step 2: Failing test** — construct two `Broker`s over the SAME temp vault + SAME lockDir (simulating two processes in one test), fire concurrent `apply(create)` for two different files via `Promise.all`; assert both commits land and the Git index is not corrupt (`git status` clean, 2 distinct `ledger:` commits, both files present). Without the lock this can race; with it, serialized.
- [ ] **Step 3: Implement** the wrapping in broker.ts + undo.ts (`undoTransaction`/`undoSession` bodies wrapped when `lockDir` provided — pass lockDir into the undo functions' opts).
- [ ] **Step 4:** Run — PASS; full core suite green (v1.0 tests unaffected because they pass no lockDir).
- [ ] **Step 5: Commit** `feat(core): serialize broker mutations with the vault lock`

### Task 1.4: `openVault()` stack factory

**Files:** Create `packages/core/src/host/openVault.ts`; Test `packages/core/test/host/openVault.test.ts`.

- [ ] **Step 1: Failing tests:**
  - `openVault(vaultRoot, {now, genId, env})` on an initialized temp vault returns a `VaultContext` with `{ vaultRoot, config, manifest, journal, git, broker, store, approvals, session, lockDir, db, close() }`; a `remember` through `ctx.store` works and `recall` returns it.
  - it runs `ensureJournal` + `reconcile` at open (seed a vault whose journal is empty → memories rebuilt).
  - **concurrent/double open reindex converges** (§3): open twice (or call reindex twice) on a vault with existing notes+commits → identical memory/txn row counts (idempotent). Explicit test.
  - `close()` closes the db (spy on `db.close`).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement** — mirror `packages/cli/src/context.ts` wiring, but: derive `lockDir` = the app-support `<vaultId>/` dir (reuse the config path resolver used by `journalPath`), pass `lockDir` into the `Broker` (and thread it to undo calls), open the journal via `openJournal(journalPath(...))` (now WAL), run `ensureJournal` then `reconcile`, build store/approvals, generate a `session` (`openVault` is a boundary — real `now`/`genId` default here, injectable for tests). Wrap post-open work in try/catch that closes `db` before rethrowing (learn from the cli fix). Accept `sweep?: boolean` (default false) — callers that are long-running (server) pass true.
- [ ] **Step 4:** Run — PASS. Export from `core/src/index.ts`: `openVault`, `VaultContext`, `withVaultLock`, `LOCK_CONFIG`, and a helper `vaultLockDir(vaultId, env?)` that returns the app-support `<vaultId>/` dir (reuse the `journalPath` resolver's base).
- [ ] **Step 5: Commit** `feat(core): openVault stack factory (+lock wiring, idempotent reindex)`

### Task 1.5: Thread the lock into the CLI and MCP-server brokers (the real second process)

**Files:** Modify `packages/cli/src/context.ts`, `packages/mcp-server/src/context.ts`; Tests alongside.

> **CRITICAL (plan-review fix):** the lock only protects a process that passes
> `lockDir`. `openVault` (the server) does, but the **MCP server** builds its own
> `Broker` in `mcp-server/src/context.ts`, and the **CLI** builds its own in
> `cli/src/context.ts` — both for mutating paths (`memory_*`/`vault_propose_edit`
> in MCP; `approve`/`undo` in CLI). If they don't pass `lockDir`, there is NO
> mutual exclusion between `ledger serve` and the MCP server — the exact
> serve+MCP race §3 exists to prevent. This is the minimal change spec §2 names
> ("mcp-server ... now acquires the shared mutation lock"); it is distinct from
> the deferred full `openVault` adoption (§8) — we only pass `lockDir`, not
> restructure the wiring.

- [ ] **Step 1: Failing test** — in `mcp-server` (and `cli`) tests, construct the context over a temp vault (temp HOME) and assert the `Broker` was built with a `lockDir` equal to `vaultLockDir(vaultId, env)`. Stronger: a two-context concurrency test IN the mcp-server suite — build TWO server contexts the real way (`loadServerContext`) over the same vault and fire concurrent `memory_remember`s; assert serialized, non-corrupt commits. (This is the test that would FAIL if the MCP path skipped the lock.)
- [ ] **Step 2:** FAIL (contexts currently pass no lockDir).
- [ ] **Step 3: Implement** — in both `loadContext`/`loadServerContext`: compute `lockDir = vaultLockDir(config.vaultId, env)` and pass it into `new Broker({..., lockDir})`. Nothing else changes. (WAL is already inherited via `openJournal`.)
- [ ] **Step 4:** Run — PASS; full cli + mcp suites green (the lock is a no-op under single-process test load, just serialized).
- [ ] **Step 5: Commit** `fix(cli,mcp): acquire the shared vault lock on mutations`

---

## Phase 2 — Server: the fastify bridge

### Task 2.1: App factory + auth + origin guard

**Files:** Create `packages/server/src/app.ts`; Test `packages/server/test/auth.test.ts`.

`buildBridge(ctx: VaultContext, token: string): FastifyInstance`. Add a global `preHandler`: (a) reject if `Host`/`Origin` isn't loopback (`127.0.0.1`/`localhost`/`[::1]`) → 403; (b) require `Authorization: Bearer <token>` (constant-time compare) → 401 on missing/mismatch.

- [ ] **Step 1: Failing tests** (fastify `app.inject`): a request with no auth → 401; wrong token → 401; correct token but `Host: evil.com` → 403; correct token + loopback host to a trivial `/status` → 200.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement** the app with the preHandler and a stub `/status`. Use `crypto.timingSafeEqual` for the token compare (guard length first).
- [ ] **Step 4:** PASS. **Step 5: Commit** `feat(server): fastify app with token auth + loopback guard`

### Task 2.2: Read routes

**Files:** Modify `packages/server/src/app.ts`; Create `packages/server/src/render.ts`; Test `packages/server/test/read.test.ts`.

Routes: `/status`, `/approvals` (with server-rendered diff per item via `render.ts` reusing the `diff` lib like the CLI), `/transactions`, `/memories`, `/staleness` (core `findStale`), `/conflicts` (returns `[]`).

- [ ] **Step 1: Failing tests** over a temp vault seeded via `openVault`+store: `/status` shape (zones/mode/counts); after a `propose_edit`, `/approvals` returns 1 item with a non-empty `diff` string; `/transactions` returns the remembers; `/memories?entity=` filters; `/staleness` returns flagged ids for an old working memory; `/conflicts` → `[]`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement routes + render. **Step 4:** PASS. **Step 5: Commit** `feat(server): read routes (status/approvals/transactions/memories/staleness)`

### Task 2.3: `/provenance` with the zone check (security)

**Files:** Modify `packages/server/src/app.ts`; Test `packages/server/test/provenance.test.ts`.

- [ ] **Step 1: Failing tests:** `/provenance?path=Agent/Memory/<id>.md` → 200 with `{ ledger: {...} }` frontmatter; `/provenance?path=Private/secret.md` (excluded zone) → **403 FORBIDDEN_ZONE**; `/provenance?path=../../etc/passwd` (traversal) → 403; a path resolving through a symlink out of the vault → 403.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement** — resolve the zone with `resolveZone` AND run the broker's containment. The broker's containment currently lives in private methods in `broker.ts` (~lines 174–226, `resolveAbs` + zone gate). **Refactor that into a shared exported helper in core** — e.g. `assertContainedAndReadable(vaultRoot, manifest, relPath)` (lexical + realpath containment + excluded/`.ledger`/`.git` zone check) — and have BOTH the broker and this route call it, so there is ONE implementation of the containment rule (no reimplementation drift). If excluded/escaping → throw BrokerError FORBIDDEN_ZONE (mapped to 403 in Task 2.4). Else read the file and parse `ledger:` frontmatter with gray-matter.
- [ ] **Step 4:** PASS. **Step 5: Commit** `feat(server): zone-checked /provenance`

### Task 2.4: Mutation routes + error mapping

**Files:** Modify `packages/server/src/app.ts`; Test `packages/server/test/mutations.test.ts`.

Routes: `POST /approvals/:id/approve`, `POST /approvals/:id/reject`, `POST /undo {target}`. Global error handler maps `BrokerError.code` → HTTP status (403/404/409/422/400) with `{ error: { code, message, retriable } }`.

- [ ] **Step 1: Failing tests:** approve a queued propose_edit → 200 `{applied:true}` and the file changes; approve when the note changed (stale) → 200 `{stale:true}` (recommended over 409 — stale is an expected outcome, not an error); reject → 200, file unchanged; undo a create txn → 200 and file gone; undo an unknown txn → 404; a forced REVERT_CONFLICT → 409. Also assert the error body shape. **The `/undo` route MUST thread `ctx.lockDir` into the `undoTransaction`/`undoSession` deps** (Task 1.3 added `lockDir` to their opts; `VaultContext` carries it) so the undo mutation is locked, not just create/revise — assert an undo runs under the lock (or at least that lockDir is passed).
- [ ] **Step 2:** FAIL. **Step 3:** Implement routes + a fastify `setErrorHandler` that recognizes `BrokerError`. **Step 4:** PASS. **Step 5: Commit** `feat(server): mutation routes + BrokerError->HTTP mapping`

### Task 2.5: `startBridge` + the two-process concurrency test

**Files:** Create `packages/server/src/start.ts`; Test `packages/server/test/twoProcess.integration.test.ts`.

`startBridge(vaultRoot, { token, port?, now?, genId?, env? }): Promise<{ app, port, token, close }>` — `openVault(vaultRoot, {sweep:true, ...})`, `buildBridge(ctx, token)`, `app.listen({ host: "127.0.0.1", port: port ?? 0 })`, resolve the actual port. `close()` closes app + ctx.db.

- [ ] **Step 1: Failing test (two-process, the load-bearing one):** start the bridge over a temp vault (sweep on). In parallel, run a SECOND writer **built the way the real MCP server builds its broker** — i.e. via `mcp-server`'s `loadServerContext` (NOT a second `openVault`; using `openVault` would mask the Task 1.5 gap since it always locks). Have that context do several `store.remember`s WHILE the test hits the bridge's `/memories` reads. Assert: all writes committed, `git status` clean, no corrupt index, journal row counts consistent, reads succeeded throughout. Also a slow-commit variant (inject a delay into the git step) asserting the second writer waits rather than stealing the lock. (If importing mcp-server into the server test package is awkward, put this concurrency test in the mcp-server suite in Task 1.5 instead and keep a server-side reads-during-writes test here — but SOMETHING must exercise the real MCP broker path under contention.)
- [ ] **Step 2:** FAIL (or flaky) without proper locking. **Step 3:** Implement `startBridge`. **Step 4:** PASS reliably (run it a few times). **Step 5: Commit** `feat(server): startBridge + two-process safety test`

---

## Phase 3 — CLI: `ledger serve`

### Task 3.1: `ledger serve` command + discovery file

**Files:** Create `packages/cli/src/commands/serve.ts`; Modify `packages/cli/src/index.ts` (register subcommand); Test `packages/cli/test/serve.test.ts`.

- [ ] **Step 1: Failing tests:**
  - `serveCommand(vaultDir, { port:0, now, genId, env })` starts the bridge, writes `<app-support>/<vaultId>/bridge.json` = `{port, token, pid, startedAt}` with file mode `0o600` (assert `statSync(...).mode & 0o777 === 0o600`), and the returned handle can `close()` (which removes bridge.json + closes db).
  - the written `port` matches the live listening port; `token` is present and non-trivial.
  - `--rotate-token`: a second serve with `--rotate-token` writes a DIFFERENT token; the old token no longer authenticates (401 against the running instance is a server test — here assert the file's token changed).
  - a request to the running bridge with the bridge.json token succeeds (spin a real `fetch` to `127.0.0.1:<port>/status`).
- [ ] **Step 2:** FAIL. 
- [ ] **Step 3: Implement** — mint a token (`randomBytes(24).toString("hex")`; injectable), call `startBridge`, write bridge.json with `writeFileSync(path, json, { mode: 0o600 })` (and `chmodSync` to be safe on umask), register SIGINT/SIGTERM handlers that `close()` + `unlink` bridge.json. On start, if an existing bridge.json names a dead pid, overwrite. Keep the testable core in `serveCommand`; commander wrapper thin.
- [ ] **Step 4:** PASS. **Step 5: Commit** `feat(cli): ledger serve (bridge.json 0600, --rotate-token, lifecycle)`

---

## Phase 4 — Obsidian plugin

### Task 4.1: BridgeClient (discovery + typed calls)

**Files:** Create `packages/obsidian-plugin/src/bridgeClient.ts`; Test `packages/obsidian-plugin/test/bridgeClient.test.ts`.

- [ ] **Step 1: Failing tests** (against a real `startBridge` instance in the test): `BridgeClient.fromVault(vaultRoot, {env})` resolves `{port, token}` by reading vaultId from `.ledger/config.json` then app-support `bridge.json`; `.status()`, `.approvals()`, `.approve(id)`, `.undo(target)` hit the bridge with the bearer header and return typed results; a bridge error body maps to a typed `{error}` (no throw for expected rejections). A wrong/missing bridge.json → a clear "bridge not running" error.
- [ ] **Step 2:** FAIL. **Step 3:** Implement the fetch client (use global `fetch`; base URL `http://127.0.0.1:<port>`). Reuse core's app-support resolver for the path (import from `@vaultledger/core`). **Step 4:** PASS. **Step 5: Commit** `feat(plugin): BridgeClient with app-support discovery`

### Task 4.2: PURE render helpers + the hostile-diff XSS test (security)

**Files:** Create `packages/obsidian-plugin/src/render.ts`; Test `packages/obsidian-plugin/test/render.test.ts` (jsdom environment).

Pure functions returning DOM nodes: `renderDiff(diffText): HTMLElement`, `renderProvenance(prov): HTMLElement`, `groupBySession(txns): {...}`. Build nodes with `document.createElement` + `textContent` ONLY.

- [ ] **Step 1: Failing tests** (vitest `environment: jsdom` for this file):
  - `renderDiff` colors `+`/`-` lines (class assertions), preserves content as text.
  - **XSS (the named security test):** `renderDiff("+ <img src=x onerror=alert(1)>\n- <script>evil()</script>")` → the returned element contains NO `<img>`/`<script>` child elements; the malicious text appears only as `textContent`. Assert `el.querySelectorAll("img,script").length === 0` and that `el.textContent` includes the literal string.
  - `renderProvenance` on a hostile `reason` field (`"<img onerror=...>"`) → inert text, no element.
- [ ] **Step 2:** FAIL. **Step 3:** Implement with createElement/textContent; NEVER `innerHTML`. **Step 4:** PASS. **Step 5: Commit** `feat(plugin): XSS-safe render helpers (+ hostile-fixture test)`

### Task 4.3: Plugin glue — views, hover, entry (manual-verify)

**Files:** Create `packages/obsidian-plugin/src/views/{approvals,activity}.ts`, `src/hover.ts`, `src/main.ts`, `SMOKE.md`. Replace `src/index.ts` usage.

No automated tests (Obsidian API). Keep glue THIN: each view constructs a `BridgeClient`, polls, and renders via the pure helpers; buttons call client mutations then refresh.

- [ ] **Step 1:** Implement `main.ts` (a `Plugin` subclass) registering: an Approval Queue `ItemView`, an Agent Activity `ItemView`, a provenance hover (via `registerHoverLinkSource`/`registerEvent` on hover), and commands to open the views. Views use `bridgeClient` + `render.ts`. Conflicts tab present, empty.
- [ ] **Step 2:** `pnpm -C packages/obsidian-plugin build` → produces `main.js` with no errors (esbuild). Typecheck clean.
- [ ] **Step 3:** Write `SMOKE.md` — the manual checklist: install (copy `manifest.json`+`main.js` into `<vault>/.obsidian/plugins/vaultledger/`), start `ledger serve <vault>`, open each view, approve/reject a queued edit, undo a transaction, hover a memory note; expected results for each.
- [ ] **Step 4:** Commit `feat(plugin): views, provenance hover, entry + SMOKE.md`

---

## Phase 5 — Docs & gate

### Task 5.1: README + v0.2 gate

- [ ] **Step 1:** Add a README section: `ledger serve <vault>` (what it publishes, loopback+token), and plugin install (copy build output into the vault's plugins dir; enable it). Note the concurrency model (serve + MCP safe together).
- [ ] **Step 2:** REQUIRED SUB-SKILL: superpowers:verification-before-completion. Run `pnpm build`, `pnpm lint`, `pnpm test` from root; paste real output. All green (v0.2 additive; server suite incl. the two-process + XSS + provenance-zone + auth tests passing).
- [ ] **Step 3:** Commit `docs: v0.2 serve + plugin walkthrough; test: full green gate`.

---

## Sequencing & notes

- Strict phase order: core concurrency (1) underpins the server (2); the server underpins cli serve (3) and the plugin client (4).
- The lock is inherited: only the broker + undo acquire it; Approvals/MemoryStore/sweep get it for free (§3). Do NOT add a second lock site.
- **Every mutating process must pass `lockDir`**: `openVault` (server) in Task 1.4, AND the CLI + MCP contexts in Task 1.5. Threading `lockDir` is NOT the same as the deferred `openVault` adoption (§8) — cli/mcp keep their wiring, they just gain the one `lockDir` arg. Without Task 1.5 the serve+MCP concurrency guarantee is a no-op.
- v0.1 core unit tests that build a `Broker` directly pass no lockDir, so they stay lock-free and green — don't change them. (The cli/mcp integration tests DO get lockDir via their contexts and must stay green under the now-engaged lock.)
- Plugin glue (4.3) is the only untested code; keep it minimal and push logic into the tested `bridgeClient`/`render`.
- Commit after each green test. Never `git add -A`; never `git push` from a task.
