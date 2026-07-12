# VaultLedger v0.4 — onboarding & setup (`ledger setup`) — design

**Date:** 2026-07-12
**Status:** Approved (brainstorm)
**Context:** First track of the v1.0 push. v1.0 in the spec (§8) is a bucket —
"polish, packaged installers, docs, integration guides." This cycle carves out
the **critical path**: the §9 success criterion that *a non-developer Obsidian
user goes from zero to "Claude remembers across sessions" in under 10 minutes,
with zero existing notes modified.* Distribution is deliberately scoped to
**GitHub-grade** (clone + build + sideload; no npm-registry publish, no Obsidian
community-store submission — those are later tracks). The goal is **external
release**: someone who isn't the author can get it working unaided.

Baseline: `main` @ `dc27e1f` (v0.3b complete; core 441 pass, integration green in
isolation). Built subagent-driven with the two-stage review. The `--write-mcp`
merge and the `--install-plugin` footprint are the two units that can damage a
real user's environment, so they get an adversarial pass.

**The friction this cycle removes** (each an observed stall point in the current
README walkthrough):

- **F1** — the `ledger` bin isn't linked until *after* `pnpm build` **and** a
  second `pnpm install`; today's README documents "run `pnpm install` again."
- **F2** — MCP wiring needs a hand-edited absolute path to
  `packages/mcp-server/dist/index.js`; a typo yields a silently-dead server.
- **F3** — the plugin is a manual copy of two files into
  `<vault>/.obsidian/plugins/vaultledger/`, then a manual enable.
- **F4** — no Claude-Code-specific wiring (`.mcp.json` / `claude mcp`).
- **F5** — README status is stale (header "v0.3.0", roadmap lists v0.3b as
  future); no single non-dev quickstart; no Node/pnpm prerequisites.

**Approach (chosen over a `doctor`-first diagnostic and a docs-only pass):** one
auditable orchestrating command, `ledger setup <vault>`, **print-by-default**
(writes are explicit opt-in flags, global config is never mutated), whose
idempotent re-run is diagnostic-shaped — so `ledger doctor` (a later track) falls
out for free. Print-by-default and explicit writes are the product's
auditability ethos applied to onboarding itself.

---

## Component map

A new testable command function `packages/cli/src/commands/setup.ts`, shaped like
`initCommand` (injected `out` / prompt / deps for tests), wired into
`packages/cli/src/index.ts` as `ledger setup <vault>`. It orchestrates small,
independently-testable units:

- **`promptYesNo`** — the CLI's first interactive prompt (stdin seam, injectable).
- **`resolveMcpServerEntry`** — packaging-safe path resolution (WU-2).
- **`buildMcpConfig` / `mergeMcpConfig`** — emit + never-clobber merge (WU-2).
- **`smokeCheck`** — spawn the emitted command, call `ledger_status` (WU-3).
- **`installPlugin`** — opt-in copy into `.obsidian/` (WU-4).

Each step returns a **`StepResult`** `{ step, state, detail }` where `state ∈
{created, already, updated, outdated, skipped, failed}`. The orchestrator renders
these; a fresh run reads as progress, a re-run reads as a diagnostic (§WU-1).
`--json` emits the `StepResult[]` verbatim for the e2e.

**WU order:** WU-1 (skeleton + interactive init + report contract) first — it
fixes the `StepResult` shape every later unit returns, so they're written against
it rather than retrofitted.

---

## WU-1 — `ledger setup` skeleton: interactive init, step-status model, report

**The zone-review moment is load-bearing, not friction.** `init` today is purely
`--yes`-driven (`confirm: opts.yes`); without the flag it scans-and-prints and
writes nothing. Setup must **default to interactive**: scan (`initCommand` with
`confirm:false`, which already prints the profile + proposed zones), then prompt
`Write this zone manifest? [y/N]`, and only on `y` call `initCommand` with
`confirm:true`. The one place a user sees "`Private/` excluded, everything else
trusted" is the product's identity — the stranger *should* spend a beat here.
`--yes` skips the prompt (auto-confirm, for scripts/CI/the e2e). If the vault is
already initialized, `init` short-circuits (`already initialized`) and there's no
prompt.

- **`promptYesNo(question, { input?, out?, defaultNo? })`** — new helper (its own
  file, `packages/cli/src/prompt.ts`). Reads one line via `readline` over
  `process.stdin` by default; `input` is injectable so unit tests feed answers
  with no TTY. Default is **No** (empty line / EOF → false): the safe default for
  a write prompt.
- **Step-status model** — `StepResult { step: "init"|"mcp"|"smoke"|"plugin";
  state; detail }`. The orchestrator collects them and renders the **report**:
  - fresh: `✓ Initialized vault <id>` / `✓ MCP config written to <path>` / `✓
    VaultLedger is working — N zones, journal healthy, M pending`.
  - re-run (diagnostic-shaped): `· already initialized ✓ · MCP config current ✓ ·
    plugin outdated (0.3.0 → 0.4.0) → rerun with --install-plugin · smoke ✓`.
- **Report always ends on the smoke result** (WU-3) — the green line is the "you
  can stop reading now, it works" signal.

**Error handling:** any step's hard failure sets `state:"failed"` with a
one-line remediation in `detail`, the orchestrator prints the partial report and
exits non-zero. Setup never leaves a half-written `.mcp.json` (write is atomic:
temp + rename) and never a half-copied plugin (WU-4).

---

## WU-2 — MCP config: packaging-safe resolution, print-by-default, merge-never-clobber

**`resolveMcpServerEntry()`** — resolve the built server through **Node module
resolution**, not repo-relative math: `createRequire(import.meta.url).resolve(
"@vaultledger/mcp-server")` (falling back to the package's `bin`/`main` →
`dist/index.js`). In the monorepo this resolves via the workspace symlink; under
a future `npx vaultledger` it resolves via the installed dep — **same code, no
rewrite when the distribution track lands.** Returns an **absolute** path.

**`buildMcpConfig(vault, entry)`** — returns the Claude Code object:

```json
{ "mcpServers": { "vaultledger": {
  "command": "node",
  "args": ["<abs entry>", "--vault", "<abs vault>"] } } }
```

Both paths absolute. Serialized with `JSON.stringify` (no manual string building
— spaces/unicode in the path are handled by the encoder, consistent with the
repo's existing `pathToFileURL` care around the space-in-path gotcha).

**Default: print** the block with a one-line "paste into your Claude Code
`.mcp.json`, or re-run with `--write-mcp <path>`." **`--write-mcp <path>`
merges, never clobbers:**

- Target absent → write the object.
- Target present + valid JSON → **merge** the `vaultledger` key into
  `mcpServers`, preserving every other server. Atomic write (temp + rename).
- Target present + a *different* existing `vaultledger` entry → overwrite **only**
  that key (re-run updates the path), leave siblings untouched.
- Target present + unparseable JSON → **refuse**, print the block to paste
  manually, `state:"failed"`. Never overwrite a file we can't safely merge.

Overwriting a user's existing `.mcp.json` would be a data-loss bug in the very
command built to make first contact safe — the merge is the safety property.
Global config (`~/.claude.json`) is **never** touched.

---

## WU-3 — smoke check: drive the exact emitted command

After config generation, prove it end-to-end by **spawning the exact
`command`+`args` we just emitted** (not an in-process core call), over stdio, with
the MCP SDK client, and calling `ledger_status`.

- Success → `state:"created"`, `detail: "N zones, journal healthy, M pending"`
  (read from the tool result), rendered as the green closing line.
- Failure → `state:"failed"`, `detail` carries the captured **stderr** + the
  resolved entry path, so an F2 path error is diagnosed *at setup time* rather
  than as a silently-dead MCP server at first use.
- Bounded: a spawn timeout (a few seconds) so a hung server fails loud, not hangs
  the command. The child is always killed in a `finally`.

Driving the real command is the entire point — an in-process check would pass
while the emitted path is wrong. This is an integration check of the artifact we
just produced.

---

## WU-4 — `--install-plugin`: opt-in copy + a deliberate constitutional amendment

`--install-plugin` copies the built plugin from the resolved
`@vaultledger/obsidian-plugin` package into
`<vault>/.obsidian/plugins/vaultledger/`.

- **Copy set:** `manifest.json` + `main.js` (what the build produces today), plus
  `styles.css` **only if present** — Obsidian's third standard file isn't emitted
  now, but copy-if-exists means adding styling later can't silently ship a broken
  plugin.
- **If the plugin isn't built** (`main.js` missing) → `state:"failed"` with the
  one-line build command (`pnpm -C packages/obsidian-plugin build`); never a
  half-install.
- **Copying does not activate.** The report **and** GETTING_STARTED must print the
  manual enable steps: *Obsidian → Settings → Community plugins → (turn off
  Restricted mode if on) → enable **VaultLedger***. Without this the flag ends in
  a silently-inert plugin — exactly the class of stall this cycle exists to kill.
- **Freshness:** compare the installed `manifest.json` `version` against the
  package's for the diagnostic re-run (`plugin outdated (x → y)`).

**Constitutional amendment (deliberate).** The standing invariant is "`.ledger/`
is the only in-vault footprint besides the agent zone." Writing into
`<vault>/.obsidian/plugins/` breaches that literally. It is legitimate — the
invariant governs **agent/broker** writes to vault *content*; this is a **human**
running an **explicit opt-in flag**, installing a plugin into Obsidian's own
config directory, touching **no notes**. Rather than leave the first exception to
a stated invariant undocumented, this cycle **amends `CLAUDE.md`** to scope the
footprint rule to agent/broker content writes and to name `ledger setup
--install-plugin` as the sanctioned human-initiated exception. Default `setup`
(no flag) still writes nothing outside `.ledger/`.

---

## WU-5 — `pnpm bootstrap` + docs

- **`pnpm bootstrap`** (root `package.json` script) — `install → build → install`
  (the second install links the `ledger` bin post-build), the F1 fix in one
  command. **Named `bootstrap`, not `setup`:** `pnpm setup` is a real pnpm
  built-in (installs pnpm's own shell integration) and a bare `pnpm setup` would
  do something baffling to a stranger's shell.
- **`docs/GETTING_STARTED.md`** — the non-dev <10-minute path, with a
  **prerequisites section first** (the genuine non-dev wall isn't this repo, it's
  the toolchain): install **Node 22 LTS**, `corepack enable pnpm`, platform-noted
  (macOS/Windows/Linux one-liners). Then: clone → `pnpm bootstrap` → `ledger
  setup <vault>` (walk the zone prompt) → paste the block into Claude Code (or
  `--write-mcp`) → `--install-plugin` + the enable steps → first
  `remember`/`recall`. Without the prerequisites the <10-min claim only holds for
  people who didn't need the doc.
- **README refresh** — fix F5: status header + roadmap (v0.3b **shipped**),
  replace the "install dance" quickstart with `pnpm bootstrap` → `ledger setup`,
  keep the detailed developer walkthrough below the fold.
- **CLAUDE.md** — the WU-4 amendment.

---

## Testing

- **Unit (`setup.test.ts`, injected deps — no real processes):** step sequence
  and `StepResult` shape; interactive path prompts and aborts on `N` (writes
  nothing) vs `--yes` auto-confirms; emitted config shape (absolute entry +
  vault, `node` command); **print vs `--write-mcp`**; **merge never clobbers** —
  *existing `.mcp.json` with another server → both present after*; unparseable
  target → refuse + print, no write; plugin skip by default, error-when-unbuilt,
  `styles.css` copied only if present; **diagnostic re-run output** shape.
- **E2E (`setup.e2e.test.ts`, mirroring `v01-gate.e2e.test.ts`):** temp vault →
  `setup --yes --write-mcp <tmp> --json` → assert the smoke check **actually
  spawned the server** and got a healthy `ledger_status`; then a **second
  invocation asserts the re-run is diagnostic-shaped AND mutation-free** — no new
  git commits, no file mtime changes outside `.ledger/` logs. This pins WU-1's
  idempotence promise, otherwise the least-tested claim.

---

## Out of scope (YAGNI / later tracks)

- npm-registry publish + release tooling (versioning, changelogs) — next track.
- Obsidian community-store submission — a weeks-long external review; separate.
- `ledger doctor` as its own command — the diagnostic re-run *is* the capability;
  a later track adds the alias + a no-mutation `--check`.
- Claudian / second-brain integration guides — next track (they layer on the
  install path this cycle establishes).
- Any mutation of global Claude config (`~/.claude.json`).
