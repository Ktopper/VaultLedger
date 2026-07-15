# VaultLedger v1.0 — npm publishing (first publish) — design

**Date:** 2026-07-13
**Status:** Spec-reviewed (adversarial pass 2026-07-13; one blocker + two
should-fixes found and folded in below)
**Context:** Second track of the v1.0 push (after v0.4 onboarding). The
2026-07-12 security skim cleared external distribution; this cycle makes
`npx @vault-ledger/cli setup <vault>` and `npx -p @vault-ledger/mcp-server
vaultledger-mcp` work for a stranger with no clone and no build. Scope decision
(2026-07-13): **npm registry only** — the Obsidian community-store submission is
a separate, mostly non-code track with weeks-long external review, and release
automation (CI publish, provenance, changesets) is deferred to a follow-up. This
is a **careful manual first publish**: hardening + one human-gated
`pnpm -r publish`, with every irreversible step preceded by a mechanical check.

Baseline: `main` @ `c55b24c` (post security-skim), **published from the
relocated non-iCloud checkout `~/dev/VaultLedger`** — the old
`~/Documents/.../VaultLedger` working copy is retired this session and must
never be used to publish (it's iCloud-synced, which caused the duplicate-file
and dematerialization problems; the fresh clone is the only sanctioned publish
source). Version published: **0.4.0** as-is — a pre-1.0 first publish doesn't
need a bump, and re-versioning would touch every inter-package range for no
reader benefit.

**Premise note (verified 2026-07-13 against `~/dev/VaultLedger`):** the
iCloud-materialized duplicate bin files (`bin/ledger 2.mjs`, etc.) that motivated
the packaging defenses below **do not exist in this fresh clone** — they were an
artifact of the old iCloud tree. Those measures (explicit bin-file `files`
entries, the WU-3 `" 2."` hard-fail) are retained as **precautionary hygiene**,
not fixes for a live problem, since `files` entries and packlist behavior are
worth getting right regardless.

---

## Publish set

Four packages, all currently at 0.4.0:

| Package | Bin | Role on npm |
|---|---|---|
| `@vault-ledger/core` | — | the broker library (dep of everything) |
| `@vault-ledger/server` | — | the `ledger serve` bridge (dep of cli) |
| `@vault-ledger/mcp-server` | `vaultledger-mcp` | the MCP entry agents run |
| `@vault-ledger/cli` | `ledger` | the human entry (`setup`, `approve`, `undo`, …) |

`@vault-ledger/obsidian-plugin` stays `private: true` and unpublished — its
distribution channel is the Obsidian store (separate track); it is a leaf
esbuild bundle, not a library, and nothing published imports it at runtime.

All inter-package dependencies are `workspace:*`. Publishing MUST go through
`pnpm publish` (never raw `npm publish`): pnpm rewrites `workspace:*` to the
concrete `0.4.0` range in the packed manifest across dependencies,
devDependencies, optionalDependencies, and peerDependencies; npm would ship the
literal `workspace:*`, which no consumer can resolve.

**Prerequisite (blocking, human):** the `@vault-ledger` scope must exist on npm
before anything can publish under it. Kris creates a free npm **organization**
named `vault-ledger` (Add Organization → free/public tier) under his npm account,
with 2FA enabled on the account. Without the org, every publish fails with a
scope-permission error regardless of `--access public`.

---

## WU-1 — the cli → plugin untangle

`packages/cli/package.json` lists `"@vault-ledger/obsidian-plugin":
"workspace:*"` under `dependencies` (added in v0.4 so `installPlugin` could
resolve the plugin package's built `manifest.json` + `main.js`). This doesn't
block the publish command itself (pnpm packs `@vault-ledger/cli` without
complaint), but it ships a **broken package**: the packed manifest lists
`@vault-ledger/obsidian-plugin@0.4.0` in `dependencies`, which was never
published, so every consumer's `npm install @vault-ledger/cli` 404s. That's the
failure to prevent. (Note the WU-4.1 test run is what catches a regression here
before the irreversible publish — pack/dry-run don't refuse it.)

**Change:** move the entry from `dependencies` → `devDependencies`.

- **Monorepo users keep `--install-plugin`:** devDependencies are installed in
  the workspace, so the plugin symlink under `node_modules/@vault-ledger/` is
  present exactly as before; `installPlugin`'s resolution is unchanged for
  anyone running from a clone. One accepted cosmetic consequence: pnpm rewrites
  `workspace:*` in devDependencies too, so the *published* cli manifest carries
  `devDependencies: { "@vault-ledger/obsidian-plugin": "0.4.0" }` — a package
  that doesn't exist on npm. Harmless to consumers (registry installs never
  install a dependency's devDeps); noted here so nobody later reads it as a
  publish bug.
- **npm-installed users degrade gracefully:** an `npm install @vault-ledger/cli`
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

  Two deliberate choices here. First, **bin files are listed individually, not
  as the `bin/` directory** — precautionary against the iCloud-duplicate pattern
  (`bin/ledger 2.mjs`), which does NOT exist in the relocated clone but did in
  the old iCloud tree. The reasoning still holds and is worth encoding: the
  `* [0-9].*` quarantine patterns live only in the **monorepo root**
  `.gitignore`, and packing a workspace package consults ignore files inside
  that package's own directory only — so the root gitignore never participates
  in packlist. `"files": ["bin"]` (or no `files` field) would ship any such
  duplicate if the tree ever re-syncs; naming the exact file can't. The
  corollary is load-bearing: **gitignore must never be assumed to protect
  tarball contents** anywhere, including under `dist/`. (The `bin`-field target
  is force-included by npm anyway; the explicit entry documents intent.)
  Second, **no `tsbuildinfo` handling is needed** — verified that `tsc -b`
  writes `tsconfig.tsbuildinfo` at each package *root*, never under `dist/`, so
  a `["dist", …]` allowlist already excludes it. (`files` is inclusion-only; a
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

**Per-package `LICENSE`:** under **pnpm** (the only sanctioned publish path
here), `pnpm pack` already hoists the root workspace `LICENSE` into each
package's tarball when the package lacks its own — verified 2026-07-13
(`packages/core` with no own LICENSE still packs the root MIT text). So
per-package copies aren't strictly necessary under pnpm; we copy them anyway for
explicitness and raw-`npm publish` safety (npm proper does NOT hoist it). Copy
the
root `LICENSE` verbatim into each of the four package dirs (committed copies;
no build-time copy step to go stale or get skipped).

**Per-package `README.md`:** only `obsidian-plugin` has one today; the four
published packages would have blank npm pages. Each gets a short README —
what the package is, the one-command install/use (`npx @vault-ledger/cli setup
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
     `.gitignore` already quarantines; here it must hard-fail, not just be
     ignored);
  4. `dist/index.js` is newer than the newest file under `src/` (staleness
     check — a cheap mtime comparison, advisory-grade but catches the
     "edited after last build" case).
- Each publishable package adds
  `"prepack": "node ../../scripts/prepack-check.mjs"`. `prepack` runs on both
  `pnpm pack` and `pnpm publish`, with cwd = the package dir; the relative path
  is fine because publishing only ever happens from the workspace this cycle.
- The guard is checked by a unit test that runs the script against a fixture
  with a planted `ledger 2.mjs` and asserts a non-zero exit.
- Caveat: an `ignore-scripts=true` in any effective `.npmrc` would silently
  skip `prepack` under pnpm. The runbook's step 0 includes
  `pnpm config get ignore-scripts` (must be false/unset) so the guard is known
  to be armed.

---

## WU-4 — verification & the human-gated publish runbook

`npm publish` is irreversible in the ways that matter: a published version can
never be reused even after unpublish, and unpublish itself is policy-limited
(≤72h, and only if no dependents). So the runbook is ordered so that every
check happens **before** the first irreversible command, and the irreversible
command is run by (or explicitly authorized by) Kris.

0. **Preconditions:** all WU-1/WU-2/WU-3 edits (plus the four LICENSE copies
   and READMEs) **committed on `main`, working tree clean** — `pnpm publish`
   (including `--dry-run`) enforces a clean tree and a `main`/`master` branch
   by default (`ERR_PNPM_GIT_UNCLEAN` / `ERR_PNPM_ACTIVE_BRANCH`), and that
   guard stays on (never `--no-git-checks`). Also:
   `pnpm config get ignore-scripts` is false/unset (arms the WU-3 guard), and
   the scratch dir for step 2 lives **outside the repo** (untracked tarballs
   inside it would dirty the tree and fail the git check).
1. **Clean build:** `pnpm install` → `pnpm build` (fresh `dist/` everywhere).
2. **Pack + inspect (mechanical, per package):** on this pnpm (11.9),
   `pnpm -r --filter '!@vault-ledger/obsidian-plugin' pack
   --pack-destination "$SCRATCH"` works directly and produces exactly the 4
   non-plugin tarballs (verified 2026-07-13 — the old `pnpm#4351` "no recursive
   pack" caveat is stale for this version; note that unfiltered `pnpm -r pack`
   does NOT skip the private plugin, so the `!`-filter is required). In
   practice this is the `scripts/verify-publish.mjs` check. Then list each
   tarball (`tar -tzf`) and assert: `dist/` present with
   `.js`/`.d.ts` and maps (the base tsconfig emits `sourceMap` +
   `declarationMap`, so maps are expected); `bin/<name>.mjs` present where
   declared; `LICENSE` + `README.md` present; **absent:** `src/`, `test/`,
   `tsconfig*`, `*.tsbuildinfo`, any `" 2."`-pattern file, anything matching
   `.env*`. Also extract each packed `package.json` and assert every
   `@vault-ledger/*` range reads `0.4.0` — pnpm applies the `workspace:*`
   rewrite on `pack` as well as `publish`, so this inspection is
   representative of the real publish.
3. **Dry-run:** `pnpm -r publish --dry-run` from the workspace root. Scope of
   proof: packing, tag, and the per-package skip of the private plugin (and
   the private root) **only** — `publish --dry-run` never contacts the
   registry and does not require login (npm removed the dry-run auth check;
   npm/cli#2445), so it proves nothing about auth, org, or access.
4. **Registry-side preflight (first registry contact, still reversible):**
   Kris creates the `vault-ledger` npm org (see prerequisite), runs
   `npm login` (2FA), then `npm whoami` and `npm org ls vault-ledger` to prove
   the session and scope rights actually exist — without this, the first auth
   test would be the irreversible publish itself.
5. **Human gate — the publish, canary-first:** publish `@vault-ledger/core`
   alone, verify it on the registry (`npm view @vault-ledger/core@0.4.0`), then
   publish the remaining three as **four explicit per-package publishes in
   runtime-dependency order** — `core` → `server` → `mcp-server` → `cli` — NOT
   `pnpm -r publish`. **Why not recursive:** `server` and `mcp-server` each
   *devDepend* on `cli` while `cli` *runtime-depends* on both, so the workspace
   graph contains `cli↔server` and `cli↔mcp-server` cycles. `pnpm -r publish`
   topologically sorts over the full graph (devDeps included), and a cycle
   makes that order undefined — it can put `cli` on the registry before
   `server`/`mcp-server`, and a consumer who `npm install`s `@vault-ledger/cli`
   in that gap gets a 404 on the missing runtime sibling. Canary-first shrinks
   the window (only `core` precedes) but does not close it; four ordered
   publishes close it entirely at zero cost, since a dependent is never
   published before its runtime deps exist. Kris runs these himself or
   explicitly authorizes each. Each per-package publish is *individually*
   rerun-safe (publish skips a version already on the registry), so a 2FA/OTP
   lapse mid-sequence is recovered by `npm view @vault-ledger/<pkg>@0.4.0` in
   the same order and resuming from the first 404 — no all-or-nothing run.
6. **Post-publish smoke (clean environment):** from an empty temp dir with no
   workspace on the path:
   - `npx @vault-ledger/cli@0.4.0 --help` → command list renders;
   - `npx @vault-ledger/cli@0.4.0 setup <fresh-temp-vault>` → full v0.4 flow:
     zone review, MCP block emitted, **`smoke verified`** green line. This
     transitively proves `resolveMcpServerEntry` (built packaging-safe in v0.4
     WU-2) resolves `@vault-ledger/mcp-server`'s entry from `node_modules`
     rather than a repo-relative path — the one v0.4 behavior this cycle
     changes the context of;
   - `--install-plugin` on the same vault → the new WU-1 degraded message, not
     a crash.
7. **Record:** append the published versions + tarball listings to this doc's
   directory as a short release note (`docs/design/specs/2026-07-13-v040-npm-release-notes.md`).

If step 6 fails on an already-published package, recover **forward**: run
`npm deprecate @vault-ledger/<pkg>@0.4.0 "broken — use 0.4.1"` so the registry
warns anyone who installs it, then ship the fix as **0.4.1**. Never
unpublish/republish 0.4.0 — a version number can't be reused on npm even after
unpublish, so a clean re-do of the same version is impossible; deprecate-then-
supersede is the only real recovery.

---

## WU-5 — docs lead with npx

The whole point of publishing is that strangers skip clone+bootstrap:

- **`README.md`:** Quickstart becomes
  `npx @vault-ledger/cli@latest setup /path/to/your/vault` (one line, no clone);
  the `git clone <this repo's URL>` placeholder (which was never a real URL)
  moves into a "from source / contributing" section further down with the real
  `https://github.com/Ktopper/VaultLedger.git`. The MCP config example switches
  to the npx form (`"command": "npx", "args": ["-y", "-p",
  "@vault-ledger/mcp-server", "vaultledger-mcp", "--vault", "<vault>"]`) with
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
| iCloud duplicate files leak into tarballs | none in the relocated clone today; explicit bin-file `files` entries + prepack `" 2."` hard-fail are precautionary against re-sync; tarball inspection re-checks |
| `workspace:*` reaches the registry | publish via `pnpm` only; WU-4.2 asserts rewritten ranges in the packed manifests |
| Scope not owned at publish time | org creation is a named blocking prerequisite, and WU-4.4 proves session + scope rights (`npm whoami`, `npm org ls`) before anything irreversible |
| Partial publish mid-run (2FA OTP lapse) | four ordered per-package publishes, each individually rerun-safe (already-published versions skipped); resume from the first `npm view` 404 |
| `cli` reaches the registry before its runtime siblings (404 window) | publish per-package in dependency order (`core`→`server`→`mcp-server`→`cli`), NOT `pnpm -r publish` — the `cli↔server`/`cli↔mcp-server` dev cycles make recursive topo-order undefined |
| npm-installed `ledger setup` resolves repo paths | v0.4 built `resolveMcpServerEntry` packaging-safe; WU-4.5 proves it from a clean temp dir before declaring done |
| Native dep (`better-sqlite3`) install friction | prebuilds cover common platforms; documented pnpm-10 approve-builds note; `engines: node>=20` |
