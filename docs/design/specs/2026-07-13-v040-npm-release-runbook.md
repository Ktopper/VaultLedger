# VaultLedger 0.4.0 — npm first-publish runbook

**Date:** 2026-07-13
**Source:** transcribed from WU-4 of
`docs/design/specs/2026-07-13-vaultledger-v1-npm-publishing-design.md`

> **Every command in this document is Kris's to run. Nothing in this
> document is executed during plan or agent execution — the agent that wrote
> this runbook and `scripts/verify-publish.mjs` never runs `npm login`,
> `npm publish`, or `pnpm publish` (in any form, including `--dry-run`), and
> never touches the registry.**
>
> **Publish only from `~/dev/VaultLedger`** (the relocated, non-iCloud
> checkout). **Never** publish from the retired `~/Documents/.../VaultLedger`
> copy — that tree is iCloud-synced, which is what caused the duplicate-file
> (`bin/ledger 2.mjs`-style) and dematerialization problems this whole cycle
> hardens against.

---

## Step 0 — Preconditions

All of WU-1/WU-2/WU-3 (and this WU-4) must be **merged to `main`**, and the
session running the steps below must be on `main` with a clean tree —
`pnpm publish` (including `--dry-run`) enforces both a clean git tree and an
active `main`/`master` branch by default (`ERR_PNPM_GIT_UNCLEAN` /
`ERR_PNPM_ACTIVE_BRANCH`). **Never pass `--no-git-checks`** to bypass this.

Checklist before proceeding:

```bash
cd ~/dev/VaultLedger
git checkout main
git pull
git status                      # must be clean
```

- [ ] On `main`, after the merge, `git status` is clean.
- [ ] `pnpm config get ignore-scripts` prints `false` or nothing (unset). If
      it prints `true`, the WU-3 `prepack` build-integrity guard would be
      silently skipped — fix this before continuing:
      ```bash
      pnpm config get ignore-scripts
      ```
- [ ] The scratch dir used in Step 2 lives **outside** the repo (the default
      OS temp dir is fine and is what `scripts/verify-publish.mjs` uses
      automatically) — untracked tarballs inside the repo would dirty the
      tree and fail the `pnpm publish` git-clean check.

---

## Step 1 — Clean build

```bash
pnpm install
pnpm build
```

This produces a fresh `dist/` in every workspace package from the `main`
tip. Confirm no errors.

> **If Step 2's `prepack` prints a `WARNING — … older than the newest file
> under src/`:** that's benign — `tsc -b`'s incremental cache legitimately
> leaves an unchanged output's mtime behind a no-emit source edit. It does NOT
> block packing (it's a warning, not a failure). Only if you suspect a
> genuinely stale build, force a clean rebuild:
> `pnpm -r exec -- rm -rf dist tsconfig.tsbuildinfo && pnpm build`, then re-run
> Step 2.

---

## Step 2 — Pack + inspect (mechanical, per package)

Run the pack-and-inspect verification script built in this cycle:

```bash
node scripts/verify-publish.mjs
```

This packs the four publishable packages (`core`, `server`, `mcp-server`,
`cli` — never the private `obsidian-plugin`) via
`pnpm -r --filter '!@vaultledger/obsidian-plugin' pack` into a scratch
directory outside the repo, lists each tarball's contents, and asserts:

- **present:** `dist/` with `.js` + `.d.ts` (+ source/declaration maps);
  `bin/<name>.mjs` for `cli` and `mcp-server`; `LICENSE`; `README.md`;
  `package.json`.
- **absent:** `src/`, `test/`, `tsconfig*`, `*.tsbuildinfo`, any
  iCloud-duplicate (`" 2."`-pattern) file, any `.env*` file.
- every `@vaultledger/*` range in each packed `package.json` reads exactly
  `0.4.0` (the `workspace:*` rewrite happened).
- **independently:** `@vaultledger/obsidian-plugin` does not appear in any
  package's packed `dependencies` (it may appear in `devDependencies` —
  harmless).

**Expected result: all 4 packages print `PASS` and the script exits 0.**

- [ ] `node scripts/verify-publish.mjs` exits 0, all 4 packages PASS.

If it fails, **stop** — do not proceed to Step 3 or beyond. A failure here
means a real manifest/files/build problem that must be fixed and re-verified
before anything registry-facing happens.

---

## Step 3 — Dry-run

```bash
pnpm -r publish --dry-run
```

Run from the workspace root, on `main`, clean tree. This proves packing, the
version tag, and that the private plugin (and the private root) are
correctly skipped. **Scope of proof is limited:** `publish --dry-run` never
contacts the registry and does not require login (npm removed the dry-run
auth check; see npm/cli#2445) — it proves nothing about auth, org
membership, or access rights. Never pass `--no-git-checks` here either.

- [ ] `pnpm -r publish --dry-run` completes without error, shows the 4
      packages (never the plugin), and shows version `0.4.0` for each.

---

## Step 4 — Registry preflight (first reversible registry contact)

This is the first step that touches the npm registry, but it is still fully
reversible (no publish happens here).

1. Create the `vaultledger` npm organization if it doesn't already exist:
   npmjs.com → **Add Organization** → name `vaultledger` → free/public tier.
   Ensure **2FA is enabled** on your npm account before doing this.
2. Log in:
   ```bash
   npm login
   ```
3. Prove the session and scope rights actually exist:
   ```bash
   npm whoami
   npm org ls vaultledger
   ```

- [ ] `npm whoami` prints your npm username.
- [ ] `npm org ls vaultledger` shows you as a member/owner of the `vaultledger`
      org.

Without the org existing and your account holding rights on it, every
publish below fails with a scope-permission error regardless of
`--access public`.

---

## Step 5 — Human gate: the publish, canary-first

Publish `@vaultledger/core` alone first:

```bash
pnpm --filter @vaultledger/core publish --access public
```

Verify it landed on the registry:

```bash
npm view @vaultledger/core@0.4.0
```

Then publish the remaining three **one at a time, in this exact
runtime-dependency order** (NOT `pnpm -r publish`):

```bash
pnpm --filter @vaultledger/server publish --access public
pnpm --filter @vaultledger/mcp-server publish --access public
pnpm --filter @vaultledger/cli publish --access public
```

**Do NOT use `pnpm -r publish --access public` here.** `server` and
`mcp-server` each *devDepend* on `cli` while `cli` *runtime-depends* on both,
so the workspace graph has `cli↔server` / `cli↔mcp-server` cycles. `pnpm -r
publish` topo-sorts over the whole graph (devDeps included) and a cycle makes
the order undefined — it can push `cli` to the registry **before**
`server`/`mcp-server`, and anyone who `npm install`s `@vaultledger/cli` in
that gap gets a 404 on the missing sibling. The canary shrinks that window to
just `core`; publishing `cli` **last**, after its runtime deps are already
live, closes it entirely. `cli` must be the final publish.

**2FA note:** with auth-and-writes 2FA, each upload prompts for a valid OTP,
and a TOTP window can lapse between packages, leaving a partial publish. Each
per-package publish is *individually* rerun-safe (publish skips a version
already on the registry), so recovery is: `npm view @vaultledger/<pkg>@0.4.0`
in the order above and resume from the first one that 404s — no all-or-nothing
run, and never re-attempt an already-live package.

- [ ] `@vaultledger/core@0.4.0` published and verified via `npm view`.
- [ ] `@vaultledger/server@0.4.0`, then `@vaultledger/mcp-server@0.4.0`, then
      **last** `@vaultledger/cli@0.4.0` — each published in that order.

---

## Step 6 — Post-publish smoke (clean environment)

From an **empty temp directory with no workspace on the path** (i.e. not
inside `~/dev/VaultLedger` or any clone — a fresh `mkdir` elsewhere):

```bash
cd "$(mktemp -d)"

npx @vaultledger/cli@0.4.0 --help
```

Expect: the full command list renders (setup, approve, undo, serve, etc.).

```bash
npx @vaultledger/cli@0.4.0 setup ./fresh-temp-vault
```

Expect: the full v0.4 setup flow — zone review, MCP block emitted, and a
green **`smoke verified`** line. This transitively proves
`resolveMcpServerEntry` resolves `@vaultledger/mcp-server`'s entry from
`node_modules` (not a repo-relative path) — the one behavior this cycle
changes the packaging context of.

```bash
npx @vaultledger/cli@0.4.0 setup ./fresh-temp-vault --install-plugin
```

Expect: the new WU-1 **degraded message** (pointing at the Obsidian
community-plugin store / GitHub releases, not the monorepo build) — not a
crash.

- [ ] `--help` renders.
- [ ] `setup <fresh-temp-vault>` completes with a green `smoke verified`
      line.
- [ ] `--install-plugin` shows the WU-1 degraded message, not a crash.

---

## Step 7 — Record

Append the actual published versions and tarball listings to:

```
docs/design/specs/2026-07-13-v040-npm-release-notes.md
```

(Create the file if it doesn't exist yet.) Include, at minimum:

- Published version per package (should all read `0.4.0`).
- Timestamp of publish.
- `npm view @vaultledger/<pkg>@0.4.0` output or a summary of it, per package.
- Confirmation that Step 6's smoke test passed.

---

## Recovery: if a published package is broken

**Never unpublish/republish `0.4.0`** — npm forbids reusing a version number
even after unpublish (and unpublish itself is policy-limited: ≤72h, and only
if no dependents), so a clean re-do of the same version is not possible.

Recover **forward** instead:

```bash
npm deprecate @vaultledger/<pkg>@0.4.0 "broken — use 0.4.1"
```

Then ship the fix as `0.4.1` through this same runbook (Steps 0–6 again,
version bumped).

---

## Quick reference — full command sequence

```bash
# Step 0
cd ~/dev/VaultLedger
git checkout main && git pull
git status
pnpm config get ignore-scripts

# Step 1
pnpm install
pnpm build

# Step 2
node scripts/verify-publish.mjs

# Step 3
pnpm -r publish --dry-run

# Step 4
npm login
npm whoami
npm org ls vaultledger

# Step 5 — per-package, in dependency order (NOT `pnpm -r publish`; cli LAST)
pnpm --filter @vaultledger/core publish --access public
npm view @vaultledger/core@0.4.0
pnpm --filter @vaultledger/server publish --access public
pnpm --filter @vaultledger/mcp-server publish --access public
pnpm --filter @vaultledger/cli publish --access public

# Step 6 (from a fresh empty temp dir, not the repo)
cd "$(mktemp -d)"
npx @vaultledger/cli@0.4.0 --help
npx @vaultledger/cli@0.4.0 setup ./fresh-temp-vault
npx @vaultledger/cli@0.4.0 setup ./fresh-temp-vault --install-plugin

# Step 7: append results to
# docs/design/specs/2026-07-13-v040-npm-release-notes.md
```
