# VaultLedger v1.0 — npm publishing (first publish) — design

**Date:** 2026-07-13
**Status:** Approved (brainstorm) — pending spec-review
**Context:** Second track of the v1.0 push (after v0.4 onboarding). The
2026-07-12 security skim cleared external distribution; this cycle makes
`npx @vaultledger/cli setup <vault>` and `npx -p @vaultledger/mcp-server
vaultledger-mcp` work for a stranger with no clone and no build. Scope decision
(2026-07-13): **npm registry only** — the Obsidian community-store submission is
a separate, mostly non-code track with weeks-long external review, and release
automation (CI publish, provenance, changesets) is deferred to a follow-up. This
is a **careful manual first publish**: hardening + one human-gated
`pnpm -r publish`, with every irreversible step preceded by a mechanical check.

Baseline: `main` @ `c55b24c` (post security-skim), working from the relocated
non-iCloud checkout `~/dev/VaultLedger`. Version published: **0.4.0** as-is — a
pre-1.0 first publish doesn't need a bump, and re-versioning would touch every
inter-package range for no reader benefit.

**Premise note (verified 2026-07-13 against `~/dev/VaultLedger`):** the repo was
relocated out of iCloud this session. The iCloud-materialized duplicate bin
files (`bin/ledger 2.mjs`, etc.) that motivated some of the packaging defenses
below **no longer exist** in the fresh clone — those measures are retained as
**precautionary hygiene** (cost nothing; guard against recurrence if the tree
ever re-syncs), not as fixes for a live problem.

---

## Publish set

Four packages, all currently at 0.4.0:

| Package | Bin | Role on npm |
|---|---|---|
| `@vaultledger/core` | — | the broker library (dep of everything) |
| `@vaultledger/server` | — | the `ledger serve` bridge (dep of cli) |
| `@vaultledger/mcp-server` | `vaultledger-mcp` | the MCP entry agents run |
| `@vaultledger/cli` | `ledger` | the human entry (`setup`, `approve`, `undo`, …) |

`@vaultledger/obsidian-plugin` stays `private: true` and unpublished — its
distribution channel is the Obsidian store (separate track); it is a leaf
esbuild bundle, not a library, and nothing published imports it at runtime.

All inter-package dependencies are `workspace:*`. Publishing MUST go through
`pnpm publish` (never raw `npm publish`): pnpm rewrites `workspace:*` to the
concrete `0.4.0` range in the packed manifest across dependencies,
devDependencies, optionalDependencies, and peerDependencies; npm would ship the
literal `workspace:*`, which no consumer can resolve.

**Prerequisite (blocking, human):** the `@vaultledger` scope must exist on npm
before anything can publish under it. Kris creates a free npm **organization**
named `vaultledger` (Add Organization → free/public tier) under his npm account,
with 2FA enabled on the account. Without the org, every publish fails with a
scope-permission error regardless of `--access public`.

---

## WU-1 — the cli → plugin untangle

`packages/cli/package.json` lists `"@vaultledger/obsidian-plugin":
"workspace:*"` under `dependencies` (added in v0.4 so `installPlugin` could
resolve the plugin package's built `manifest.json` + `main.js`). This doesn't
block the publish command itself (pnpm packs `@vaultledger/cli` without
complaint), but it ships a **broken package**: the packed manifest lists
`@vaultledger/obsidian-plugin@0.4.0` in `dependencies`, which was never
published, so every consumer's `npm install @vaultledger/cli` 404s. That's the
failure to prevent.

**Change:** move the entry from `dependencies` → `devDependencies`.

- **Monorepo users keep `--install-plugin`:** devDependencies are installed in
  the workspace, so the plugin symlink under `node_modules/@vaultledger/` is
  present exactly as before; `installPlugin`'s resolution is unchanged for
  anyone running from a clone.
- **npm-installed users degrade gracefully:** an `npm install @vaultledger/cli`
  does not pull devDependencies, so the plugin package is absent.
  `installPlugin` already has a not-found path; today its message points at the
  monorepo build (`pnpm -C packages/obsidian-plugin build`), which is nonsense
  advice for an npx user. **Change the not-found message** to point at the
  plugin's real channels: the Obsidian community-plugin store (once live) and
  the GitHub releases page, with the monorepo build mentioned last as the
  from-source option. The step still returns `state: skipped`/`failed` per the
  v0.4 `StepResult` contract — no behavioral change, message only.
- **Tests:** the existing setup/installPlugin tests must stay green; adjust the
  not-found-path assertion to the new message. One new test: cli's
  `package.json` `dependencies` contains no private workspace package (a
  publishability guard, same spirit as the plugin's bundle-purity test — it
  fails the suite if anyone re-adds the plugin as a runtime dep).

The remaining cli runtime deps (`core`, `server`, `mcp-server`, `commander`,
`@modelcontextprotocol/sdk`, `diff`, `yaml`) are genuine and all published or
public — no other cycle-or-privacy hazard exists. (`server` devDepending on
`cli` and `mcp-server` devDepending on `cli` are dev-only edges; devDependencies
are never installed by consumers, so they don't gate publish.)

---

## WU-2 — manifest hardening (each of the 4 packages)

Every publishable `package.json` gains:

- **`"publishConfig": { "access": "public" }`** — scoped packages default to
  private on first publish; without this (or a `--access public` flag) the
  publish is rejected outright on the free org tier.
- **`"files"`** — a tight inclusion allowlist so the tarball ships built output
  only:
  - core, server: `["dist"]`
  - cli: `["dist", "bin/ledger.mjs"]`
  - mcp-server: `["dist", "bin/vaultledger-mcp.mjs"]`

  Two deliberate choices. First, **bin files are listed individually, not as
  the `bin/` directory** — precautionary against the iCloud-duplicate pattern
  (`bin/ledger 2.mjs`): `files` entries override ignore rules in npm-packlist,
  so `"files": ["bin"]` would ship any such duplicate if the tree ever
  re-syncs; naming the exact file can't. (The `bin`-field target is
  force-included by npm anyway; the explicit entry documents intent.) Second,
  **no `tsbuildinfo` handling is needed** — verified that `tsc -b` writes
  `tsconfig.tsbuildinfo` at each package *root*, never under `dist/`, so a
  `["dist", …]` allowlist already excludes it. (`files` is inclusion-only; a
  `!`-negation would be both unnecessary here and unreliably honored by npm, so
  none is used.) `package.json`, `README.md`, and `LICENSE` are always included
  by npm regardless of `files`.
- **Metadata (all currently absent):** `"description"` (per-package one-liner),
  `"license": "MIT"`, `"author": "Kristopher Dunham"`,
  `"repository": { "type": "git", "url": "git+https://github.com/Ktopper/VaultLedger.git", "directory": "packages/<name>" }`,
  `"homepage": "https://github.com/Ktopper/VaultLedger#readme"`,
  `"bugs": "https://github.com/Ktopper/VaultLedger/issues"`,
  `"keywords"` (obsidian, mcp, agent-memory, provenance, …),
  `"engines": { "node": ">=20" }` (matches the root manifest).

**Per-package `LICENSE`:** npm auto-includes `LICENSE` only from the package's
own directory — the root file does not ride into workspace tarballs. Copy the
root `LICENSE` (confirmed present) verbatim into each of the four package dirs
(committed copies; no build-time copy step to go stale or get skipped).

**Per-package `README.md`:** only `obsidian-plugin` has one today; the four
published packages would have blank npm pages. Each gets a short README —
what the package is, the one-command install/use (`npx @vaultledger/cli setup
<vault>` for cli; the `.mcp.json` block for mcp-server; "you probably want the
cli" pointers for core/server) — linking to the repo README and
`docs/GETTING_STARTED.md` for everything else. Short and stable beats
comprehensive and drifting.

---

## WU-3 — build-integrity guard (`prepack`)

`dist/` is gitignored build output, and this is a manual publish: a stale or
missing build is the classic way a hand-run publish ships a broken tarball.
Make the mistake structurally impossible rather than checklist-dependent:

- New `scripts/prepack-check.mjs` at the repo root (plain Node, no deps):
  1. `dist/index.js` and `dist/index.d.ts` exist in the invoking package;
  2. if the package declares a `bin`, every bin target exists;
  3. **no iCloud-duplicate artifacts** — fail if any file matching
     `/ [0-9]+(\.|$)/` exists under `dist/` or `bin/` (the pattern the repo's
     `.gitignore` already quarantines; here it hard-fails, not just ignored —
     precautionary, since the fresh clone has none today);
  4. `dist/index.js` is newer than the newest file under `src/` (staleness
     check — a cheap mtime comparison, advisory-grade but catches the
     "edited after last build" case).
- Each publishable package adds
  `"prepack": "node ../../scripts/prepack-check.mjs"`. `prepack` runs on both
  `pnpm pack` and `pnpm publish`, with cwd = the package dir; the relative path
  is fine because publishing only ever happens from the workspace this cycle.
- The guard is checked by a unit test that runs the script against a fixture
  with a planted `ledger 2.mjs` and asserts a non-zero exit.

---

## WU-4 — verification & the human-gated publish runbook

`npm publish` is irreversible in the ways that matter: a published version can
never be reused even after unpublish, and unpublish itself is policy-limited
(≤72h, and only if no dependents). So the runbook is ordered so that every
check happens **before** the first irreversible command, and the irreversible
command is run by (or explicitly authorized by) Kris.

1. **Clean build + full gate:** `pnpm install` → `pnpm build` (fresh `dist/`
   everywhere) → `pnpm -w lint` → **`pnpm -r test`**. The test run is
   load-bearing here, not ceremony: WU-1's new publishability-guard test (cli
   `dependencies` contains no private workspace package) is the ONLY check that
   catches a re-introduced private runtime dep *before* the irreversible
   publish — neither `pnpm pack` nor `pnpm publish --dry-run` refuses or warns on
   a private `@vaultledger/obsidian-plugin` still sitting in `dependencies`
   (verified: dry-run succeeds silently; the breakage only surfaces later as a
   consumer-side `npm install` 404). So the suite must be green before step 2.
2. **Pack + inspect (mechanical, per package):** `pnpm -r --filter '!@vaultledger/obsidian-plugin' pack`
   into a scratch dir, then list each tarball (`tar -tzf`) and assert:
   `dist/` present with `.js`/`.d.ts`/maps; `bin/<name>.mjs` present where
   declared; `LICENSE` + `README.md` present; **absent:** `src/`, `test/`,
   `tsconfig*`, `*.tsbuildinfo`, any `" 2."`-pattern file, anything matching
   `.env*`. Also extract each packed `package.json` and assert every
   `@vaultledger/*` range reads `0.4.0` — i.e. the `workspace:*` rewrite
   actually happened.
3. **Dry-run the real thing:** `pnpm -r publish --dry-run` from the workspace
   root (confirms auth flow, tag, access, and per-package skip of the private
   plugin) — expected to fail only at the auth step until step 4.
4. **Human gate:** Kris creates the `vaultledger` npm org (see prerequisite),
   runs `npm login` (2FA), then publishes. **Publish in explicit dependency
   order so `cli` is last** — `pnpm --filter @vaultledger/core publish
   --access public`, then `server`, then `mcp-server`, then `cli` — rather than
   relying on `pnpm -r publish`, whose topo-sort is confused by the dev-only
   cli↔server / cli↔mcp-server cycle and empirically publishes `cli` *before*
   its runtime siblings. (Verified `pnpm -r publish` doesn't error, but an
   interrupted run — OTP timeout, network blip — could leave a published `cli`
   referencing not-yet-published `server`/`mcp-server`, a window a consumer
   `npm install` would hit as a 404.) Explicit order removes that window.
   Kris runs these (or explicitly authorizes running them against his
   logged-in session). Nothing before this step has touched the registry.
5. **Post-publish smoke (clean environment):** from an empty temp dir with no
   workspace on the path:
   - `npx @vaultledger/cli@0.4.0 --help` → command list renders;
   - `npx @vaultledger/cli@0.4.0 setup <fresh-temp-vault>` → full v0.4 flow:
     zone review, MCP block emitted, **`smoke verified`** green line. This
     transitively proves `resolveMcpServerEntry` (built packaging-safe in v0.4
     WU-2) resolves `@vaultledger/mcp-server`'s entry from `node_modules`
     rather than a repo-relative path — the one v0.4 behavior this cycle
     changes the context of;
   - `--install-plugin` on the same vault → the new WU-1 degraded message, not
     a crash.
6. **Record:** append the published versions + tarball listings to this doc's
   directory as a short release note (`docs/design/specs/2026-07-13-v040-npm-release-notes.md`).

If step 5 fails, the fix ships as **0.4.1** — never an unpublish/republish of
0.4.0.

---

## WU-5 — docs lead with npx

The whole point of publishing is that strangers skip clone+bootstrap:

- **`README.md`:** Quickstart becomes
  `npx @vaultledger/cli@latest setup /path/to/your/vault` (one line, no clone);
  the `git clone <this repo's URL>` placeholder (which was never a real URL)
  moves into a "from source / contributing" section further down with the real
  `https://github.com/Ktopper/VaultLedger.git`. The MCP config example switches
  to the npx form (`"command": "npx", "args": ["-y", "-p",
  "@vaultledger/mcp-server", "vaultledger-mcp", "--vault", "<vault>"]`) with
  the repo-dist form kept as the from-source variant.
- **`docs/GETTING_STARTED.md`:** same inversion — npm path first (install
  Node ≥20 → `npx … setup` → done), clone+bootstrap demoted to the contributor
  appendix.
- **Known-friction note (both docs):** consumers installing with **pnpm 10+**
  must approve `better-sqlite3`'s build script (`pnpm approve-builds`) — the
  same policy this repo handles via `allowBuilds`. npm/npx users are
  unaffected. `better-sqlite3` ships prebuilt binaries for common
  platforms; unusual platforms compile from source (needs a toolchain) — one
  sentence, not a support matrix.

Root `package.json`, `pnpm-workspace.yaml` (including the VL-SEC-S4-06 vite
override — install-time only, never reaches consumers), and the eslint
bundle-purity guard are all confirmed inert to this track and untouched.

---

## Out of scope (documented follow-ups)

- Release automation: CI publish workflow, npm provenance/`--provenance`,
  changesets/version management. First publish is deliberately manual; automate
  from a known-good baseline.
- Obsidian community-store submission (separate track; external review).
- The three security-skim fast-follows (read-gate/stdio batch) — cheap separate
  cycle, not publish-blocking.
- Any version bump / API stability commitments — 0.4.0 publishes as pre-1.0.

## Risks

| Risk | Mitigation |
|---|---|
| Irreversible publish of a broken tarball | pack-and-inspect (WU-4.2) + prepack guard (WU-3) both run before the human gate; version-forward (0.4.1) policy, never unpublish |
| iCloud duplicate files leak into tarballs | none in the fresh clone today; explicit bin-file `files` entries + prepack hard-fail on the `" 2."` pattern are precautionary against re-sync; tarball inspection re-checks |
| `workspace:*` reaches the registry | publish via `pnpm` only; WU-4.2 asserts rewritten ranges in the packed manifests |
| Scope not owned at publish time | org creation is a named blocking prerequisite, before the runbook starts |
| npm-installed `ledger setup` resolves repo paths | v0.4 built `resolveMcpServerEntry` packaging-safe; WU-4.5 proves it from a clean temp dir before declaring done |
| Native dep (`better-sqlite3`) install friction | prebuilds cover common platforms; documented pnpm-10 approve-builds note; `engines: node>=20` |
