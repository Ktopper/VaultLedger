# VaultLedger — `ledger doctor` design

**Date:** 2026-07-13
**Status:** design (pre-implementation)
**Scope:** a read-only CLI health-check command. First deliverable of the
"integration guides and ledger doctor" track; the Claudian / second-brain
integration guides are a separate, later docs deliverable with their own spec.

---

## 1. Purpose & shape

`ledger doctor` answers one question a user (or an agent's human operator)
asks when something is off: **"is this vault wired up correctly, and if not,
what's the one command that fixes it?"** It inspects the vault + its
out-of-vault runtime state and prints a per-check report, each check carrying
a status and — when not OK — a remediation pointing at an *existing* command
(`ledger setup`, `ledger reindex`, `ledger serve`, `git init`) or a concrete
file path.

```
ledger doctor <vaultDir> [--json] [--strict]
```

- **Read-only.** Every check is a pure inspection: `readFileSync`, `statSync`,
  `existsSync`, `resolveZone`, a `{ readonly: true }` journal open,
  `require.resolve`, `process.kill(pid, 0)` (signal 0 — an existence probe, not
  a signal). No writes, no broker mutation, no reindex, no lock acquisition,
  no git write. This is the whole point: doctor is the one command you can run
  on a confused vault without risk of changing it. Enforced by a mutation-free
  test (§7).
- **Exit code.** `0` if no check is `fail`; `1` if any check is `fail`.
  `--strict` promotes `warn` to fatal (any `warn` or `fail` → exit `1`).
- **`--json`.** Emits the check array as machine-readable JSON (for the
  integration guides to reference, and for CI). Human table otherwise.

`doctor` is a **thin aggregator**. Almost every check reuses a read-only
helper an earlier cycle already built and tested — v0.4 setup
(`checkPluginFreshness`, `resolveMcpServerEntry`, the `StepResult`/report
vocabulary) and the security skim (the S7-03 Private-folder invariant, the
`.ledger/**` always-excluded invariant). Little new logic; mostly wiring
existing inspections into one report.

---

## 2. Check vocabulary

Doctor introduces a small `Check` result type, deliberately parallel to
setup's `StepResult` so the report renderer style carries over:

```ts
type CheckStatus = "ok" | "warn" | "fail" | "skipped" | "info";

interface CheckResult {
  name: string;         // stable short id, e.g. "config", "git", "zone-integrity"
  status: CheckStatus;
  detail: string;       // what was observed
  remediation?: string; // present when status is warn|fail; names a command or path
}
```

`skipped` is the **cascade** state (§4): a vault-dependent check whose
precondition (an initialized vault) is absent reports `skipped`, not a
redundant `fail`. `info` is for always-advisory reporting (versions, a
not-installed optional plugin, a bridge that simply isn't running) that must
never affect the exit code even under `--strict`.

Exit-code mapping is derived purely from status:

| status    | exit contribution (default) | exit contribution (`--strict`) |
|-----------|-----------------------------|--------------------------------|
| `ok`      | none                        | none                           |
| `info`    | none                        | none                           |
| `skipped` | none                        | none                           |
| `warn`    | none                        | **fail**                       |
| `fail`    | **fail**                    | **fail**                       |

---

## 3. The check set

Grouped by concern. Each entry: what it inspects, the status it yields, and
the remediation.

### 3.1 Init & config
- **`config`** — `.ledger/config.json` exists and parses to a config with a
  valid `vaultId`. Reuse `readConfig` (already throws a typed `NOT_FOUND` on
  absent/corrupt). Note: `assertValidVaultId` is **module-private** in
  `config.ts` and `readConfig` does not call it — so validate the id by
  routing it through `journalPath(vaultId, env)` / `vaultLockDir(vaultId, env)`
  (both call `assertValidVaultId` internally and throw on a bad id), which the
  journal/lock checks need to compute paths from anyway. *Absent, corrupt, or
  invalid id → `fail`, remediation "run `ledger setup <vault>`".* This check's
  outcome gates the cascade (§4): a `fail` here means the vaultId is unknown,
  so every out-of-vault check (journal, lock, bridge) is `skipped`.
- **`permissions`** — `.ledger/permissions.yaml` exists and parses to a valid
  `PermissionsManifest` (the same parse `openVault` uses). *Absent or invalid
  → `fail`, "run `ledger setup <vault>`" / "fix permissions.yaml".*

### 3.2 Rollback substrate
- **`git`** — the vault is a git repo AND git actually works. `.git/` present
  is necessary but not sufficient: a missing/broken `git` binary breaks
  `simple-git` everywhere and nothing else in the set would catch it. So the
  check runs a real `git rev-parse` (read-only) via the same git layer the
  broker uses.
  - **Reuse note:** `LedgerGit` (core) exposes only mutating/write-oriented
    methods (`init`/`commitFile`/`revertCommit`/`fileAtHead`/…) — no public
    read-only repo probe. So the check calls `simpleGit(vaultDir)` directly
    (`.checkIsRepo()` / `.revparse(["HEAD"])`), both pure reads, rather than
    reusing `LedgerGit`.
  - `.git/` absent → `fail`, "`ledger undo` needs git for rollback — run
    `ledger setup <vault>` (it runs `git init`)".
  - `git` binary missing / `rev-parse` errors → `fail`, "git isn't working —
    install git / check PATH" (this is the classic environment check).
  - **`HEAD` unresolvable on a freshly-init'd repo with no commits yet** is a
    legitimate state (vault initialized, no broker write has committed
    anything). That specific sub-case is `ok`/`info` ("git repo present, no
    commits yet"), **not** `fail`.

### 3.3 Zone integrity (security-skim invariants, now continuously verified)
- **`zone-integrity`** — pulls the S7-03 invariant out of its one-time
  regression test into an always-on check: under the vault's *current*,
  on-disk parsed manifest, every folder matching `PRIVATE_FOLDER_RE` at any
  depth resolves to the `excluded` zone. *Any Private folder not excluded →
  `fail`, "a 'Private' folder is not excluded — re-run `ledger setup <vault>`
  or fix permissions.yaml".* A security invariant that regresses silently is
  exactly what belongs in doctor rather than living only in the fix's
  regression test.
  - **Enumeration (re-walk, not `scanVault` reuse):** `scanVault`'s
    private-folder walk (`privateFolderPaths`) is internal, isn't returned in
    `ScanResult`, and probes the *proposed* manifest (throwing
    `INVARIANT_VIOLATION`), not the vault's *current* one. So doctor re-walks
    the tree itself to collect `PRIVATE_FOLDER_RE` matches — reusing the
    `PRIVATE_FOLDER_RE` semantics and the same directory-exclusion set
    scanner.ts skips (`.git`/`.obsidian`/`.ledger`/`node_modules`/`.trash`) —
    then probes each match with `resolveZone(probe, currentManifest)`.
  - **Constant-guard extension (not manifest-sensitive):** also assert
    `resolveZone(".ledger/anything.md", currentManifest) === "excluded"`. Be
    precise about what this proves: `resolveZone` hard-codes `.ledger/**`
    (and `.git/**`) as excluded *before* consulting the manifest, so this can
    never fail on account of the vault's `permissions.yaml` — it's a
    constant-guard against a future edit to `zones.ts`, not a check of vault
    config. Worth keeping (same low cost), but it is defense-in-depth on the
    code, not on the manifest.

### 3.4 Journal
- **`journal`** — open the app-support journal DB **read-only** and report the
  memory row count.
  - **HAZARD (must be honored in code, verified in tests):** a default
    better-sqlite3 open *creates* an empty DB if the file is absent, and a
    default-mode open of a WAL database can *materialize* `-wal`/`-shm`
    sidecar files — both of which would violate the read-only guarantee. The
    check MUST open with `{ readonly: true, fileMustExist: true }` and treat
    the throw (file absent) as the "absent" path, not create-on-open.
  - **Note — do NOT reuse core's `openJournal`:** it opens with
    `new Database(dbPath)` (no options → create-on-open) and runs
    `pragma("journal_mode = WAL")` (materializes sidecars). Doctor opens the
    path directly with `{ readonly: true, fileMustExist: true }` instead.
  - **SECOND HAZARD — a read-only open of a healthy WAL DB can itself throw
    (false-corrupt risk).** SQLite read-only access to a WAL-mode database is
    restricted: a `{ readonly: true }` connection generally cannot open a WAL
    database unless a readable `-shm` already exists — it can neither create
    the shared-memory index nor run WAL recovery. So depending on platform and
    whether the last writer closed cleanly, `{ readonly: true }` on a
    *perfectly healthy* WAL journal can throw, which the naïve mapping below
    would mislabel as "unreadable → reindex" on a vault with nothing wrong.
    This is NOT caught by the §7 sidecar-materialization test — it needs the
    healthy-WAL and live-writer fixtures called out in §7.
  - **⚠ MECHANISM CORRECTED AT PLAN-REVIEW (2026-07-14) — this bullet's
    prescription was empirically disproven; see the plan for the real
    implementation.** On macOS / better-sqlite3 11, `{ readonly: true,
    fileMustExist: true }` on a healthy cleanly-closed WAL DB does **not**
    throw — it silently **succeeds and materializes** `-wal`/`-shm` beside the
    real file (violating read-only). And the `immutable=1` URI fallback below
    is **not valid better-sqlite3** — it doesn't enable `SQLITE_OPEN_URI`, so
    `file:…?immutable=1` is treated as a literal filename and throws. **The
    implemented mechanism is instead: open a disposable temp COPY of
    `journal.db` (+ any present `-wal`/`-shm`), never the real file** — SQLite
    then touches only the throwaway, keeping app-support byte-identical while
    still yielding an accurate count. The original fallback text is retained
    below only as the reasoning trail:
  - *(superseded)* Fallback: open via the SQLite URI form with `immutable=1`
    (`file:<path>?immutable=1`, `{ readonly: true }`); else degrade to
    existence + non-zero file size + a softer detail line.
  - **Absent vs. corrupt vs. active-writer:** `fileMustExist:true` throws
    `SQLITE_CANTOPEN` for an absent DB, but a corrupt/locked DB — and, per the
    hazard above, a *healthy* WAL DB with no `-shm` — can throw the same.
    `existsSync` the path first (cheap) to separate absent from present-throws.
    For a present-throws, cross-reference the `lock` check: **if the mutation
    lock shows a live writer, the detail must read "journal busy — possibly
    held by an active writer", NOT imply corruption.** Both still route to the
    same `ledger reindex` remediation (the journal is disposable).
  - Absent → `warn`, "journal not built yet — run `ledger reindex`" (the
    journal is a disposable index; absence is recoverable, not fatal).
  - Present but unopenable, no live writer → `warn`, "journal present but
    unreadable — run `ledger reindex` to rebuild it".
  - Present but unopenable, live writer held (per `lock`) → `info`/`warn`,
    "journal busy — possibly held by an active writer".
  - Present and opens → `ok`, detail "N memories indexed" + a light drift hint
    ("run `ledger reindex` if you suspect the index has drifted"). Doctor does
    **not** run a reconcile (that would be heavier and, more importantly, a
    reindex mutates — out of scope; §8).

### 3.5 MCP wiring
- **`mcp`** — `resolveMcpServerEntry()` resolves the built
  `@vaultledger/mcp-server` entry. Since WU-1, `@vaultledger/cli`
  *runtime-depends* on `@vaultledger/mcp-server`, so a failure here does **not**
  mean "the user forgot to install the server" — it means the **cli install
  itself is broken**. *Unresolvable → `fail`, remediation "reinstall
  `@vaultledger/cli`, or from a source clone run `pnpm bootstrap`".* Do **not**
  prescribe `npm i -g @vaultledger/mcp-server` — a global-install instruction
  is wrong here and sits oddly next to the npx-first docs. Detail line notes:
  *"an `.mcp.json` using the `npx` server form does not depend on this
  resolution."*

### 3.5a Native dependencies (added 2026-07-14, post-smoke)
- **`native-deps`** — the single most likely "why is my agent stuck?"
  broken-install state, and the one doctor was originally **blind** to: with
  `better-sqlite3`'s compiled binding missing (the classic pnpm-10
  "skipped `approve-builds`" state our own friction note warns about), every
  journal-touching command (`status`/`log`/`approve`, the MCP server) fails —
  yet doctor reported a **false clean bill**, because no check ever loaded the
  native module when the journal was absent. Fix: a dedicated probe
  (`probeNativeDeps` in core) opens and closes an **in-memory** database
  (`:memory:` — no file, no vault write, so it stays read-only) which forces
  the `.node` binding to load. *Loads → `ok`; throws → `fail`, remediation
  "reinstall — on pnpm 10 run `pnpm approve-builds` then reinstall; otherwise
  `npm rebuild better-sqlite3`".* **Vault-independent** (it's install health,
  not vault state — runs even on an uninitialized/garbage path); it renders as
  the **first of the install-health / vault-independent checks**, i.e. right
  after the `config`/`permissions` gate (config stays the report's first line
  because it drives the cascade). It's unmissable regardless — a broken binding
  makes most other checks moot. Companion
  hardening (not a doctor check): both CLI and MCP entry points now route
  top-level error printing through `explainNativeBindingError` (core), so a
  broken binding yields ONE actionable line instead of the raw ~14-line
  `bindings` path dump — **at the committed bin launchers**, since the dist's
  own `isMainModule` catch is dead code when invoked via the linked bin.

### 3.6 Stale mutation lock
- **`lock`** — the post-crash state that silently blocks every broker write:
  the agent just sees lock timeouts and nothing else in the set surfaces why.
  Arguably the highest-value check for a "why is my agent stuck?" moment.
  - **Mechanism correction (grounding):** the mutation lock is
    `proper-lockfile`, which represents a held lock as a `vault.lock`
    **directory** whose **mtime** is refreshed every `update` ms (2s) while
    held and is considered **stale** after `stale` ms (20s) — there is **no
    pid** stored in it. So the check is **mtime-staleness-based, not
    pid-liveness-based**: `statSync` the lock directory (read-only; never
    acquire — acquiring/releasing would mutate lock state), and if its mtime is
    older than the staleness window, a live holder would have refreshed it, so
    it's almost certainly a crashed writer.
  - Lock absent → `ok` ("no mutation lock held").
  - Lock present, mtime within the staleness window → `ok`/`info` ("a writer
    currently holds the mutation lock" — a healthy concurrent `serve`/MCP
    write).
  - Lock present, mtime older than the staleness window → `warn`, remediation
    names the exact path and lets the human remove it: "a stale mutation lock
    is present (older than the {stale}ms window) — likely a crashed writer;
    remove `<path>` if no `ledger` process is running."

### 3.7 Sync-artifact scan
- **`sync-artifacts`** — this project just ate exactly this damage from
  iCloud (duplicate-suffixed files, and a broken ref inside `.git`), and user
  vaults live under iCloud / Obsidian Sync **by design** (it's in the risk
  table). A cheap read-only scan catches corruption before it becomes a
  mysterious `undo` failure:
  - duplicate-suffix files under `.ledger/` (`config 2.json`,
    `permissions 2.yaml` — the same `" 2."` pattern `prepack-check.mjs` and
    `verify-publish.mjs` already guard against), and
  - broken-named refs under `.git/refs/` (a cheap refs listing).
  - **Scope stays narrow on purpose — `.ledger/` and `.git/refs/` only, never
    the note space.** User notes legitimately contain names like `Page 2.md`,
    so widening the `" 2."` scan to the whole vault would drown the check in
    false positives. Left as a warning so nobody "improves" it into a
    vault-wide sweep later.
  - Any found → `warn`, detail lists the offending paths, remediation "these
    look like cloud-sync duplicates/corruption — review and remove the
    duplicates; a broken git ref can break `ledger undo`."
  - None → `ok`.

### 3.8 Plugin (optional feature)
- **`plugin`** — reuse `checkPluginFreshness(vault)` verbatim:
  - not installed → `info` ("review plugin not installed — optional; `ledger
    setup --install-plugin` to add it"). Never a fail — the plugin is opt-in.
  - installed & current → `ok`.
  - installed & outdated → `warn`, "re-run `ledger setup --install-plugin`".

### 3.9 Bridge (runtime, info-tier)
- **`bridge`** — `bridge.json`'s presence does **not** mean the bridge is
  running; after a crash/reboot a **stale** `bridge.json` actively misleads the
  plugin (it points at a dead port). Use the `isPidAlive`
  (`process.kill(pid, 0)` — read-only) probe against the recorded pid — note
  `isPidAlive` is private to serve.ts, so extract-or-reimplement per §6, not a
  reuse of an exported symbol:
  - absent → `info` ("bridge not running — `ledger serve` to start it").
  - present, pid alive → `ok`/`info` ("bridge running (port N, pid P)").
  - present, pid dead → `warn` ("stale `bridge.json` — pid P is not running;
    re-run `ledger serve`"). Never `fail` (the bridge is only expected up while
    serving).

### 3.10 Versions & environment
- **`versions`** — reports `@vaultledger/cli` and `@vaultledger/mcp-server`
  versions (`info`), AND checks **skew**: post-npm-publish, a stale global cli
  vs an `npx @latest` mcp-server is a real state, and skew is exactly what a
  doctor exists to notice. Versions disagree → `warn` ("cli vX vs mcp-server
  vY — version skew; reinstall to align"). Also compares the running Node
  version against the packages' `engines.node` → `info`/`warn` on mismatch.

---

## 4. Cascade behavior

The most common doctor run is a brand-new user pointed at the wrong directory
(or a not-yet-`setup` vault). That run must **not** produce a pile of
redundant fails. Rule:

> When `config` (§3.1) reports `fail` (no initialized vault), every
> **vault-dependent** downstream check reports `skipped` with a one-line
> reason ("no initialized vault — run `ledger setup` first"), not its own
> `fail`.

Vault-dependent (cascade-skipped when `config` fails): `permissions`,
`zone-integrity`, `journal`, `lock`, `bridge`, `plugin`. Vault-**independent**
(always run, even on an uninitialized dir): `native-deps` (install health —
first of this group, i.e. right after the config/permissions gate), `git` (a
git repo can exist before `ledger setup`), `mcp`
(install health, not vault state), `versions`, `sync-artifacts` (it can still
scan `.ledger/` / `.git/` if present, and reports `ok` if there's nothing to
scan). The `skipped` state already exists in setup's `StepState` vocabulary;
doctor reuses it.

Net effect: `ledger doctor ./not-a-vault` prints one actionable `fail`
(`config`) + a tidy list of `skipped`, exit `1` — not ten scary fails.

---

## 5. Report rendering

Reuse the table-driven renderer *style* from `packages/cli/src/setup/report.ts`
(one renderer per status, exhaustive map). Doctor gets its own renderer (its
status set is `ok|warn|fail|skipped|info`, not setup's `StepState`), but the
shape is identical:

```
✓ config          — .ledger/config.json valid (vault_ab12cd)
✓ git             — repo present, HEAD at a15ff96
✓ zone-integrity  — 3 Private folders all excluded; .ledger/** excluded
· journal    warn — not built yet → run `ledger reindex`
✗ mcp             — @vaultledger/mcp-server not resolvable → reinstall @vaultledger/cli
· lock       warn — stale mutation lock (>20s) → remove <path> if no ledger process runs
· bridge     info — not running → `ledger serve` to start
ℹ versions        — cli 0.4.0, mcp-server 0.4.0, node 22.3.0
```

A trailing summary line: `doctor: N ok, M warn, K fail — exit 1`. `--json`
bypasses the renderer and emits `{ checks: CheckResult[], exitCode }`.

---

## 6. File structure

- **Create** `packages/cli/src/commands/doctor.ts` — the orchestrator: a
  pure-ish `runDoctor(vault, opts, deps)` returning `CheckResult[]` + a
  derived exit code, with each check factored as its own small function
  (`checkConfig`, `checkGit`, `checkZoneIntegrity`, `checkJournal`, `checkMcp`,
  `checkLock`, `checkSyncArtifacts`, `checkPlugin`, `checkBridge`,
  `checkVersions`) so each unit-tests in isolation. I/O + env injected via a
  `DoctorDeps` seam (mirrors `SetupDeps`) so tests drive it with fakes and a
  temp HOME for the app-support paths.
- **Create** `packages/cli/src/commands/doctorReport.ts` (or a `renderDoctor`
  in the existing report module) — the status→line renderer + summary.
- **Modify** `packages/cli/src/index.ts` — register `doctor <vaultDir>` as a
  new top-level command with `--json` / `--strict`, alongside
  init/status/log/reindex/memory/approve/conflicts/serve/setup/undo.
- **Reuse (no change):** `checkPluginFreshness`, `resolvePluginRoot`,
  `resolveMcpServerEntry` (cli/setup); `resolveZone`, `PRIVATE_FOLDER_RE`
  semantics + the directory-exclusion set (core/scan); `readConfig`,
  `permissionsPath`, `journalPath`, `vaultLockDir`, `appSupportBase`,
  `configPath` (core/config); `LOCK_CONFIG.stale` for the lock staleness
  threshold (core/concurrency).
- **Re-implement (no shared export to reuse — noted so the plan doesn't assume
  reuse):** the permissions parse — `openVault` does
  `PermissionsManifest.parse(YAML.parse(raw))` **inline** (no exported
  `parsePermissions`), so the `permissions` check repeats that two-liner
  (`PermissionsManifest` + the `yaml` dep are both importable). `isPidAlive` —
  private to `serve.ts`; extract it to a shared module if cheap, else
  re-implement the 4-line `process.kill(pid,0)` probe. The `git` read probe —
  direct `simpleGit(dir)` (see §3.2), not `LedgerGit`.
- **Test** `packages/cli/test/commands/doctor.test.ts` (+ per-check fixtures).

---

## 7. Read-only guarantee & testing

- **Per-check unit tests** — each check's `ok`/`warn`/`fail`/`skipped` paths
  against fixtures (healthy config, missing config, corrupt permissions, no
  `.git`, git-with-no-commits, a nested `Private/` that isn't excluded, a
  duplicate `config 2.json`, a stale vs fresh lock dir, a dead-pid vs live
  `bridge.json`, version skew).
- **Integration tests** — `doctor` on a fully-healthy vault → all `ok`/`info`,
  exit `0`; on a deliberately-broken vault (no git, nested `Private/`, missing
  config) → the right `fail`s + the cascade `skipped`s, exit `1`; `--strict`
  promotes a `warn` fixture to exit `1`; `--json` shape.
- **WAL-journal read fixtures (empirical verification of the §3.4 second
  hazard) — treat these as the go/no-go on the readonly-open approach during
  implementation:**
  1. a **healthy WAL journal, writer closed cleanly** → the `journal` check
     MUST report `ok` (not `unreadable`). If the plain `{ readonly: true,
     fileMustExist: true }` open throws here, that is the signal to adopt the
     §3.4 `immutable=1` fallback (or the size-only degrade) — decided by what
     these fixtures actually do on this platform, not by assumption.
  2. a **WAL journal with a live concurrent writer** → MUST NOT report
     `corrupt`; per §3.4 it cross-references the `lock` check and reports the
     "possibly held by an active writer" detail.
- **Mutation-free assertion (the load-bearing test)** — run `doctor` against a
  vault and assert it left the vault **byte-identical**: no file content/mtime
  changes, no new git commit, no journal change. The fixture set for THIS test
  **must include both**:
  1. the **absent-journal** case (proves doctor doesn't create-on-open — no
     `journal.db` materializes), and
  2. a **WAL-mode journal** case (proves the `{ readonly: true,
     fileMustExist: true }` open doesn't materialize `-wal`/`-shm` sidecars).

  Both are spelled out because the mutation-free test only catches the §3.4
  hazard if the fixtures exercise it.

---

## 8. Out of scope (YAGNI)

- **`--fix`** — doctor is read-only by decision; every remediation is a named
  human-run command. A mutating repair mode is a separate future feature.
- **Full reconcile/drift check** — the journal check reports a row count + a
  reindex hint, not a live reconcile (which is heavier and mutates).
- **Deep bridge probe** — `bridge` reports pid-liveness only; it does not open
  a socket to the port.
- **The integration guides** — Claudian / second-brain onboarding docs are a
  separate deliverable with their own spec; doctor is referenced *by* them
  (e.g. "run `ledger doctor` to verify wiring"), not bundled with them.

---

## 9. Open deviations from the brainstormed check set (folded, flagged)

1. **`lock` is mtime-staleness-based, not pid-based.** The brainstorm framed
   it as "inspect the lockfile + pid". Grounding in `concurrency/lock.ts`
   showed the lock is `proper-lockfile` (a `vault.lock` directory with an
   mtime-refresh/staleness model, no stored pid). The check delivers the same
   value (surface a crashed-writer lock, read-only, human removes it) via the
   staleness window instead of a pid liveness probe. Documented in §3.6.
2. **`journal` uses a temp-copy read, not a readonly open.** Discovered at
   plan-review (2026-07-14): both mechanisms §3.4 originally named — a
   `{ readonly: true }` open and the `immutable=1` URI fallback — fail on
   macOS / better-sqlite3 11 (the former silently materializes `-wal`/`-shm`
   sidecars; the latter is unsupported syntax). The implemented check copies
   `journal.db` (+ live sidecars) to a temp dir and opens the copy, so SQLite
   never touches the real file. Same intent (count + readability, zero
   mutation), corrected mechanism. See §3.4's ⚠ callout and the plan's Task 2.
