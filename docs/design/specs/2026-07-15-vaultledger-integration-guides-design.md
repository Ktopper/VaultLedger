# VaultLedger — integration guides + memory skill + npx-cache fix

**Date:** 2026-07-15
**Status:** design (pre-implementation)
**Context:** `v0.4.0` is live on npm (all four `@vault-ledger/*` packages,
verified `npm view` + a real `npx` smoke on the Mac). This is the
integration-guides track that was deliberately queued behind the publish so it
could be written against verified-live packages.

**Scope:** one track, five deliverables, **one `0.4.1` publish — two packages (mcp-server → cli), ordered**
at the end (§7). Serves the spec.md §9 criterion: *"Existing harness/skill
projects integrate rather than compete (their prompts call our tools)."*

---

## 1. Deliverables

| # | Deliverable | Kind | Reaches users via |
|---|---|---|---|
| 1 | npx/dlx-cache-aware MCP config emission | code (cli) | `0.4.1` publish |
| 2 | `docs/integrations/` index + Claude Code guide | docs | repo (on merge) |
| 3 | Hermes guide | docs | repo (on merge) |
| 4 | Generic MCP-clients guide | docs | repo (on merge) |
| 5 | `vaultledger-memory` skill (two shapes, parity-enforced) | content | repo (on merge) |

---

## 2. The npx/dlx-cache fix (deliverable 1)

### 2.1 The bug

`ledger setup` prints (and `--write-mcp` writes) an MCP config block built by
`buildMcpConfig(vault, entry)` in `packages/cli/src/setup/mcpConfig.ts`, which
today **always** emits the resolved physical path:

```ts
{ mcpServers: { vaultledger: { command: "node", args: [entry, "--vault", vault] } } }
```

When setup is run the documented way — `npx @vault-ledger/cli setup <vault>` —
`entry` resolves inside npm's **ephemeral npx cache**
(`~/.npm/_npx/<hash>/node_modules/...`). npm can prune or invalidate that
directory at any time, so a config the user keeps dies **silently, weeks
later**, presenting as a confusing "MCP server not responding". Found by the
real post-publish npx smoke.

### 2.2 The fix

`buildMcpConfig` branches on whether the resolved entry is **ephemeral**:

- **Ephemeral entry** → emit the **durable npx form**:
  ```json
  { "command": "npx",
    "args": ["-y", "-p", "@vault-ledger/mcp-server", "vaultledger-mcp", "--vault", "<vault>"] }
  ```
- **Otherwise** → keep the physical-path form (`command:"node"`, `args:[entry,…]`).

### 2.3 Why NOT always emit the npx form (the load-bearing rationale)

An always-npx emission would make a **source clone silently test the published
package instead of the contributor's local build** — the worst failure mode
available, because it is invisible precisely to the people modifying the code.
The physical path is correct *when it is stable*; only the caches are prunable.
**Do not "simplify" this branch away.**

### 2.4 Detection — `isEphemeralEntry(entry): boolean`

A pure, exported path-segment check (no env sniffing — env is not reliably
present when the entry is merely *resolved* rather than *executed*).

**Matching rule (state it precisely — a substring match is a false-positive
farm):** split the path on the separator, require an **exact, case-sensitive
segment** match against a known cache segment, **and** require a later
`node_modules` segment (every real cache entry resolves through one; a user's
own directory named `dlx` will not).

Cache segments — **empirically verified on this machine, 2026-07-15, not
assumed**:

| Tool | Real observed path | Segment |
|---|---|---|
| npm `npx` | `~/.npm/_npx/de6729f694090229/node_modules/…` | `_npx` |
| pnpm `dlx` (pnpm 11) | `~/Library/Caches/pnpm/dlx/f9e99c4313084f05f3756fa56ad93726/mrmjt8gl-nf4/node_modules/…` | **`dlx`** |

> **The segment is `dlx`, NOT `dlx-`.** `dlx-<random>` is the *legacy* pnpm (<7)
> `os.tmpdir()` shape and is kept only as an additional legacy arm. This was
> caught at spec review by running a real `pnpm dlx` — the original `dlx-`
> spec would have **missed every modern `pnpm dlx` invocation while a
> hand-written `dlx-` fixture test passed green**, i.e. reproduced the exact
> silent failure §2.1 exists to kill, with a green test vouching for it.
> **Any fixture for this check must be derived from a real observed path, never
> invented.**

Both branches unit-testable from fixture strings; no filesystem or env needed.

### 2.5 Accepted limitation (named so it isn't "improved" later)

A **global install under `nvm`** also breaks when the user switches Node
versions (the bin path is version-scoped). We deliberately **do not** chase
that: it is rarer, self-inflicted, and visible at the moment of the switch —
whereas the npx-cache case is the common, silent one that the *documented happy
path* produces. Naming this here prevents a future well-meaning change to
always-npx, which would reintroduce the §2.3 contributor bug.

### 2.6 Disclosure

When the branch swaps, setup prints one line, consistent with the project's
self-disclosure habit (precedent: the `git init` disclosure):

> `· emitted the npx form — this run resolved from an ephemeral npx/dlx cache
> path that can be pruned`

**Seam — `defaultSteps.configureMcp` (`packages/cli/src/commands/setup.ts:127-184`),
NOT `printableBlock`.** `printableBlock` (`:109-116`) looks like "the step that
prints the block", but the **`--write-mcp` success path (`:161-177`) never calls
it** — it calls `writeMcpConfig` and returns a `StepResult`. A disclosure placed
in `printableBlock` would fire on the print path and the merge-refused fallback
(`:139`, `:179`) and be **silent on `--write-mcp` success** — precisely the path
§3.3 recommends. `configureMcp` already holds both `entry` and the `out` sink
and dominates both branches; emit the line there, once, gated on
`isEphemeralEntry(entry)`.

`--write-mcp` inherits the *block shape* for free (both construction sites —
`printableBlock:110` and `mergeMcpConfig:105` — go through `buildMcpConfig`), so
the written file and the printed block never disagree.

**Known limitation (stated, not discovered later):** the disclosure is invisible
under `--json`. `StepResult` is `{step, state, detail}` only
(`packages/cli/src/setup/types.ts`) and json mode routes human output to stderr
(`commands/setup.ts:50`), so a scripted consumer won't see the swap. Accepted —
the swap changes the emitted config, which the consumer *does* receive.

### 2.7 Tests

- `isEphemeralEntry`: `_npx` path → true; pnpm `dlx/<32-hex key>/…` path → true
  (incl. a **relocated `cache-dir`**, whose parent is not `pnpm`); legacy
  `dlx-<rand>` → true; a normal `node_modules` path → false; a monorepo
  workspace path → false.
- `buildMcpConfig`: ephemeral entry → npx-form block (exact shape); stable
  entry → path-form block (unchanged from today).
- `mergeMcpConfig` still preserves siblings/extras with the new shape (the
  existing merge tests must stay green — the block shape changed, the merge
  semantics did not).
- The disclosure line appears only on the swap.
- **`mergeMcpConfig(null, vault, <ephemeral entry>)` → npx-form block.** This is
  the assertion that actually defends §2.6's "the write path inherits the fix"
  promise — the other tests only exercise `buildMcpConfig` directly.
- **False-positive guard:** `~/projects/dlx/my-app/node_modules/…` → `false`
  (a user directory legitimately named `dlx`), alongside the monorepo-workspace
  → `false` case.

---

## 2.8 Required companion fix — the version-skew check must tolerate a patch bump

**This is the false signal a single-package publish creates, and it ships in
0.4.1.** (§7 was amended mid-build: this release ended up **two-package**, so the
skew does not bite 0.4.1 itself. Keep this fix anyway — it is the correct
semantics, and it is what makes the *next* single-package fast-follow, the
common case, safe to ship. Do not drop it on the grounds that "there's no skew
now.")

After a cli-only bump, a consumer installing `@vault-ledger/cli@0.4.1` gets
`@vault-ledger/mcp-server@0.4.0` (cli's `workspace:*` dep rewrites to the
sibling's local `0.4.0`, which is correct and already live). But doctor's
`checkVersions` reads the cli's own version (`0.4.1`) and the resolved
mcp-server's version (`0.4.0`), and `compareVersions` warns on **any** string
inequality:

```ts
if (cliVersion !== mcpVersion) → warn "version skew"
```

So **every `npx @vault-ledger/cli@latest doctor <vault>` on a perfectly healthy
0.4.1 install would print a version-skew warning** — and `--strict` would exit
`1`. That is doctor crying wolf: the exact mirror of the false-clean-bill we
just fixed for `native-deps`, and it would land in the same release as the
guides that tell users to trust doctor.

**Fix:** `compareVersions` compares **`major.minor`**, not the full version
string.

**Why `major.minor` is the *correct* granularity, not merely a pragmatic
loosening:** pre-1.0, semver shifts the compatibility boundary down a level — in
`0.x`, the **minor** is the breaking-change position and the patch is the
compatible one. So comparing `major.minor` aligns the check with what
"compatible" actually *means* for 0.x packages, and it stays sensible post-1.0
(cross-minor drift between a stale global cli and an `npx @latest` server is
precisely the real-drift signal worth a warn).

- `0.4.1` vs `0.4.0` → **no warn** (fold the exact versions into the existing
  `info` detail line, which already prints both).
- `0.4.x` vs `0.5.x` → `warn` (unchanged intent).
- **The parse must tolerate prerelease suffixes:** `0.4.1-beta.1` parses as
  `0.4`. Cheap now; annoying the first time a beta tag exists.
- Tests: equal → info; **patch-differs → info** (regression test for this exact
  0.4.1-vs-0.4.0 case); minor-differs → warn; major-differs → warn;
  **prerelease (`0.4.1-beta.1` vs `0.4.0`) → info** (parses to `0.4` on both
  sides).

**Do not "fix" this by bumping all four packages to 0.4.1 instead.** That would
republish three unchanged packages purely to sync a number, re-invoke the
four-package ordering ritual §7 exists to avoid, and paper over a check that is
simply too strict.

### 2.9 The npx form stays unpinned (a decision, not an omission)

The emitted `args` are `["-y","-p","@vault-ledger/mcp-server","vaultledger-mcp",…]`
— **unpinned**, matching the form `README.md` and `GETTING_STARTED.md` already
publish. Pinning would freeze a spawned server at the cli's release-time
version and quietly rot; floating keeps the server current, and §2.8 makes
patch drift a non-event. Revisit only if a real cross-minor incompatibility
appears — at which point the §2.8 check is exactly what surfaces it.

---

## 3. The three guides (deliverables 2–4)

Location: **`docs/integrations/`** — `README.md` (index: "pick your harness"),
`claude-code.md`, `hermes.md`, `mcp-clients.md`. Linked from the root README and
from GETTING_STARTED's "Next steps". GETTING_STARTED is **not** rewritten — it
remains the 10-minute fast path; the guides are the per-harness depth.

### 3.1 The shared spine (every guide, same four beats)

Identical structure in each page so they're skimmable and can't drift:

1. **Wire it** — the durable config block, where the file lives, how to reload.
2. **Verify it** — see §3.2. *Doctor is the guides' verification step — the
   reuse the doctor track hoped for.*
3. **Teach it** — the standing instruction (the memory skill, §4), in whatever
   form that harness takes.
4. **Trust model** — what that harness does and doesn't gate, plus the
   constant: **VaultLedger's broker is the enforcement layer; trusted-zone
   writes queue for human approval regardless of what the agent attempts.**

### 3.2 The verify beat — doctor **plus** a live recall (an honest gap)

`ledger doctor <vault>` validates the **install side**: the native binding
loads, the mcp-server entry resolves, the vault + zones + journal are healthy.
It does **not** read the user's `.mcp.json` / `~/.hermes/config.yaml` — so a
stale or wrong path *in their harness config* still fails only at
harness-connect time, which doctor cannot see. Every guide's verify beat is
therefore **two steps**:

1. `ledger doctor <vault>` → install + vault health.
2. Restart the harness, ask the agent to remember something, then (new session)
   ask it to recall — and check the note landed in `Agent/Memory/`.

Step 2 is the end-to-end proof; step 1 is what tells you *which side* is broken
when step 2 fails. Say this in one half-sentence per guide, not a lecture.

### 3.3 Claude Code (`claude-code.md`)

- `.mcp.json`, **npx form** (never a prunable path).
- `npx @vault-ledger/cli@latest setup <vault> --write-mcp ./.mcp.json` as the
  no-copy-paste path (merges, never clobbers siblings).
- Restart Claude Code.
- **Teach it:** the skill → `.claude/skills/vaultledger-memory/` (Shape A), or
  the standing-instruction snippet in `CLAUDE.md` (Shape B).
- Cross-ref the Obsidian review plugin (`setup --install-plugin`).
- **Trust model:** Claude Code prompts for tool approval per its own settings;
  VaultLedger's guarantees do not depend on that — the broker gates regardless.
- **Half-sentence the page must carry** (since it recommends both the
  hand-pasted block *and* `--write-mcp`): `mergeMcpConfig` lets our
  `command`/`args` **overwrite** an existing `vaultledger` entry
  (`mcpConfig.ts:131`) while preserving siblings and your extra keys (`env`,
  `disabled`). So if you hand-wrote the npx form and later run `--write-mcp`
  from a *stable* install, your block is rewritten to the path form. That's
  §2.3 working as designed — but say it, don't let them discover it.

### 3.4 Hermes (`hermes.md`)

Sourced from the official docs (linked below). **Carries the caveat verbatim:
verified against the docs, not yet run against a live Hermes install.**

- Config: `~/.hermes/config.yaml`, `mcp_servers` key. Fields: `command`, `args`,
  `env` (optional), `enabled` (default true).
- **Recommended form — differs from Claude Code, for a real reason:** agent
  harnesses spawn MCP servers as bare subprocesses, so the more reliable shape
  is a one-time `npm install -g @vault-ledger/mcp-server`, then:
  ```yaml
  mcp_servers:
    vaultledger:
      command: "vaultledger-mcp"
      args: ["--vault", "/absolute/path/to/vault"]
      enabled: true
  ```
  This still honors the rule — the rule is **"never a path that can be
  pruned"**, not "always literally npx". A PATH-resolved bin name is durable;
  `~/.npm/_npx/<hash>/…` is not. (The `command: "npx"` form is shown as the
  no-global-install alternative.)
  - **Carry the §2.5 nvm caveat here as one parenthetical.** This page actively
    *recommends* the global form, and §2.5 names global-under-nvm as the one
    accepted breakage — a global bin is version-scoped, so switching Node
    orphans it. The guide's strongest recommendation must not carry the spec's
    one named breakage unmentioned: *"if you use nvm, reinstall
    `@vault-ledger/mcp-server` after switching Node versions — global bins are
    Node-version-scoped."* One half-sentence, not a section.
- Reload: `hermes chat` (restart) or `/reload-mcp`.
- **Tool naming:** tools register as `mcp_<server>_<tool>` with hyphens/dots →
  underscores — ours appear as `mcp_vaultledger_memory_recall`,
  `mcp_vaultledger_memory_remember`, `mcp_vaultledger_vault_propose_edit`, …
- **Gotcha worth calling out:** optional `tools.include` / `tools.exclude`
  filters match the **original** tool names, not the `mcp_vaultledger_*`
  registered names.
- **Trust model:** Hermes has **no interactive per-call approval prompts** for
  custom entries — it executes what the config specifies. One sentence on why
  that's acceptable rather than alarming: it makes VaultLedger's broker the only
  enforcement layer in the loop, which is exactly the product's thesis —
  trusted-zone writes still queue for human approval no matter what the agent
  tries.
- Sources:
  `https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp`,
  `https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference`.

### 3.5 Generic MCP clients (`mcp-clients.md`)

The minimal contract for any harness: stdio, `command` + `args`, ending in
`--vault <absolute path>`; a durable command (published bin or npx form, never a
cache path); the standing instruction (§4); the two-step verify (§3.2). This is
where the trust-model caveat **generalizes**: the catalog/approval/trust model
differs per harness — assume nothing about what your harness gates, because
VaultLedger's guarantees deliberately don't rely on it.

---

## 4. The `vaultledger-memory` skill (deliverable 5)

Location: `skills/vaultledger-memory/`.

### 4.1 Why a skill at all

The MCP tools are self-describing, so an agent *can* use them. The skill teaches
**when** — and that discipline is the difference between memory that's good and
memory that's noisy. This is the §9 "integrate rather than compete" criterion in
practice: a harness's prompts call our tools.

### 4.2 Content — six rules, each with a terse *because*

Agents follow rules with visible rationale measurably better than bare
imperatives, and it costs half a line each. Kept to six — a wall of text doesn't
get followed.

1. **Recall before you start** on a known entity — *because starting cold means
   contradicting what's already known, or re-asking what the user already told
   you.*
2. **Remember durable facts, with a reason — never transcripts** — *because the
   vault is memory, not a log; keep what someone still cares about next month,
   and the reason is what makes it auditable later.*
3. **Cite or supersede an existing belief; don't write a competing duplicate** —
   *because a duplicating agent generates conflict-queue noise, while a
   superseding one generates lineage the contradiction detector can use.*
   (Mechanically: `memory_retire` takes `superseded_by`, and `memory_distill`
   documents that *a retired source may still be cited* — that's what makes
   supersede-don't-duplicate real rather than advisory. Rules 3 and 5 are one
   idea.)
4. **Promote when confirmed — `scratch→working` applies immediately;
   `working→canonical` is a proposal a human approves** — *because canonical is
   the belief the system will defend, so that hop is the one that needs a
   human.* (Corrected at spec review: the earlier "propose promotion" phrasing
   implied **both** hops queue. Per `tools.ts:296` only the second does.)
5. **Prefer `memory_retire` over `memory_forget`** — *because retired stays
   queryable in history and can still be cited; forget tombstones it.*
   (Both tools **require** a `reason` — `RetireInput`/`ForgetInput` are each
   `z.string().min(1)` — so do NOT phrase this as "retire, with a reason" as if
   that distinguished them. The distinction is what survives.)
6. **Never edit vault files directly — every write goes through the tools** —
   *because the broker is the only thing that makes a change attributable and
   reversible; a direct write is an unattributable change `ledger undo` can't
   reach.*

### 4.3 Two shapes, ONE source, parity enforced in code

- **Shape A — `skills/vaultledger-memory/SKILL.md`:** a Claude Code Agent Skill
  (frontmatter `name` + `description` so it triggers), droppable into
  `.claude/skills/`.
- **Shape B — `skills/vaultledger-memory/SNIPPET.md`:** the identical rules as a
  paste-ready standing-instruction block for a Hermes profile / any system
  prompt.

**The parity is mechanical, not aspirational** — this codebase's whole thesis is
"enforced in code, not prompts", so the skill's own packaging lives by it:

> A test asserts `SNIPPET.md` content **equals** `SKILL.md` with its frontmatter
> stripped (normalized for trailing whitespace). The two shapes cannot diverge
> silently; editing one and not the other fails the suite.

The **guides link to `SNIPPET.md`** rather than inlining the rules — inlining
would create three more copies to drift. Each guide may quote a 1–2 line
excerpt for orientation only.

**Test placement:** `packages/cli/test/` (precedent: `packages/core/test/prepackCheck.test.ts`
already tests a root-level `scripts/` file from inside a package suite). The cli
is the natural owner — it's what users install.

---

## 5. Verification standard (the same bar as everything else)

| Deliverable | Standard |
|---|---|
| npx/dlx fix | unit tests both branches **+ a real `npx @vault-ledger/cli@0.4.1 setup` run on the Mac after publish** — the same run class that found the bug |
| Claude Code guide | **tested** — wire the live test vault into the real Claude Code config and accumulate real memories; first-user friction found this week is exactly what the guide must answer |
| Hermes guide | **docs-accurate** — caveat carried in the page; Hermes is not installed on this machine. Upgradeable in ~5 min if installed (`/reload-mcp` → ask it to remember → check `Agent/Memory/`) |
| Generic guide | structurally validated against the two concrete guides |
| Skill | the parity test (§4.3); rules reviewed against the actual tool surface |

---

## 6. Non-goals

- **`ledger setup --install-skill`** (a `--install-plugin` parallel that copies
  the skill into `.claude/skills/`). Rejected: it's Claude-Code-only (an
  asymmetry smell), and it would write into the user's **project config**, which
  isn't the broker's business — the broker's footprint discipline is about the
  *vault*. Copy-paste is honest here. Possible future, not this track.
- **Rewriting GETTING_STARTED** — it stays the 10-minute fast path.
- **New MCP tools** — none. The skill teaches the existing nine.
- **Chasing nvm-scoped global-install breakage** — see §2.5.

---

## 7. The `0.4.1` publish — **two packages, ordered** (NOT the four-package ritual)

> **AMENDED 2026-07-15, mid-build.** This section originally specced a
> **single-package** cli-only publish. Building the skill surfaced a real bug
> whose one-word fix lives in **mcp-server** (`RecallInput.status` omitted
> `retired`, so an agent could never reach a retired memory via MCP —
> contradicting core's documented intent and undercutting the
> retire-don't-forget lifecycle). Kris chose to fix it in this release, so
> **mcp-server bumps too**. Recorded as an amendment rather than a silent
> rewrite: the single-package reasoning below is still exactly right for a
> cli-only fast-follow, and that's the common case.

Two packages change: **`@vault-ledger/mcp-server`** (the `retired` enum fix) and
**`@vault-ledger/cli`** (the npx/dlx fix + the §2.8 skew fix). Therefore:

- **`mcp-server` and `cli` both bump to `0.4.1`.** `core` and `server` stay at
  `0.4.0` and are **not** re-published (unchanged, already live).
- **Order matters, and the rule is the one already established: the dependent
  publishes LAST.** `cli` runtime-depends on `mcp-server`, so:

  ```bash
  pnpm --filter @vault-ledger/mcp-server publish --access public   # first
  pnpm --filter @vault-ledger/cli publish --access public          # last (depends on it)
  ```

  Two commands, in dependency order — **not** the four-package ritual (`core`
  and `server` don't move). Stated explicitly because, left unsaid, someone will
  dutifully re-run the whole runbook.
- cli's `workspace:*` ranges rewrite at publish to the siblings' **local**
  versions: `mcp-server@0.4.1` (published moments earlier, hence the order) and
  `core`/`server`@`0.4.0` (already live). All resolve cleanly.

**Consequence for §2.8 — it stays, and stays required.** With both at `0.4.1`
there is no cli↔mcp-server skew *in this release*, so §2.8 is no longer
load-bearing for 0.4.1 specifically. Keep it anyway: it is the correct semantics
(pre-1.0, the minor is the compatibility boundary), and it is what makes the
*next* single-package fast-follow — the common case this release happens not to
be — safe to ship without doctor crying wolf. Do not drop it on the grounds that
"there's no skew now."
- Preconditions still hold: clean `main`, `node scripts/verify-publish.mjs`,
  `pnpm -r publish --dry-run`, then **the two ordered publishes**, then the npx
  smoke on the Mac.

**Implementation note — SUPERSEDED. `verify-publish.mjs` WAS changed, and had
to be.** (The original note said "no change needed", which was true only while
§7 was a cli-only bump. Corrected here because §7 is the runbook read at the
cutover, and a confident-but-false note about the most safety-critical script in
the release is exactly what causes a wrong decision under time pressure.)

What actually happened: once mcp-server joined the release, cli's packed dep on
it rewrites to `0.4.1` — and the old check was a hard-coded
`range !== "0.4.0"`, which **would have falsely blocked this release** (verified:
three packages failed, since `server` and `mcp-server` also devDepend on `cli`).
The script now reads each sibling's **actual local version** from
`packages/*/package.json` and requires the packed range to equal it exactly —
correct by construction, because that is precisely what pnpm's `workspace:*`
rewrite produces, and it can never go stale on a version bump again.

Its teeth were preserved and adversarially re-verified at final review: a
literal `workspace:` reaching the registry still fails; a hand-written stale or
caret range still fails; it was **not** weakened to accept anything. A latent
reporting bug was fixed in passing (the "all ranges rewritten" success line
could print directly beneath its own FAIL — the verdict was already correct, but
the output contradicted itself).

Still true, unchanged: the script asserts only dependency **ranges**, never a
package's own version, and tarball discovery uses a version-less prefix — so a
version bump needs no change there.

**But §2.8 is a hard prerequisite of this publish** — a cli-only bump makes
doctor's version check warn on every healthy install. Ship §2.8 in the same
0.4.1 or don't ship the bump.

---

## 8. File structure

**Create:**
- `docs/integrations/README.md`, `claude-code.md`, `hermes.md`, `mcp-clients.md`
- `skills/vaultledger-memory/SKILL.md`, `SNIPPET.md`
- `packages/cli/test/skillParity.test.ts`

**Modify:**
- `packages/cli/src/setup/mcpConfig.ts` — add `isEphemeralEntry` (§2.4), branch
  `buildMcpConfig` (§2.2)
- `packages/cli/src/commands/setup.ts` — the §2.6 disclosure line, in
  **`defaultSteps.configureMcp` (`:127-184`)**, NOT `printableBlock`
- `packages/cli/src/commands/doctor.ts` — **§2.8 required companion fix:**
  `compareVersions` compares `major.minor`, not the full string
- `packages/cli/test/setup/mcpConfig.test.ts` — the §2.7 tests
- `packages/cli/test/commands/doctor.test.ts` — the §2.8 tests (incl. the
  0.4.1-vs-0.4.0 patch-skew regression test)
- `packages/cli/package.json` — version → `0.4.1`
- `README.md`, `docs/GETTING_STARTED.md` — link the guides
