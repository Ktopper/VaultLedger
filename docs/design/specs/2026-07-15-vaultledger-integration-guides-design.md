# VaultLedger — integration guides + memory skill + npx-cache fix

**Date:** 2026-07-15
**Status:** design (pre-implementation)
**Context:** `v0.4.0` is live on npm (all four `@vault-ledger/*` packages,
verified `npm view` + a real `npx` smoke on the Mac). This is the
integration-guides track that was deliberately queued behind the publish so it
could be written against verified-live packages.

**Scope:** one track, five deliverables, **one single-package `0.4.1` publish**
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
present when the entry is merely *resolved* rather than *executed*). Matches:

- **npm's npx cache** — a `_npx` path segment (`~/.npm/_npx/<hash>/…`).
- **pnpm's dlx cache** — a `dlx-` path segment. `pnpm dlx @vault-ledger/cli
  setup` is an entirely plausible invocation and its cache is just as prunable.

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

`--write-mcp` inherits the fix for free (same builder), so the written file and
the printed block never disagree.

### 2.7 Tests

- `isEphemeralEntry`: `_npx` path → true; `dlx-` path → true; a normal
  `node_modules` path → false; a monorepo workspace path → false.
- `buildMcpConfig`: ephemeral entry → npx-form block (exact shape); stable
  entry → path-form block (unchanged from today).
- `mergeMcpConfig` still preserves siblings/extras with the new shape (the
  existing merge tests must stay green — the block shape changed, the merge
  semantics did not).
- The disclosure line appears only on the swap.

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
4. **Propose promotion when a fact is confirmed** (scratch → working →
   canonical) — *because canonical is the belief the system will defend; it
   needs a human's approval by design, and yours is the proposal.*
5. **Prefer `memory_retire` (with a reason) over `memory_forget`** — *because
   retired stays queryable in history; forget tombstones it.*
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

## 7. The `0.4.1` publish — **single package** (do not re-run the four-package ritual)

The fix lives **entirely in `@vault-ledger/cli`**. Therefore:

- **Only `@vault-ledger/cli` bumps to `0.4.1`.** `core`, `server`, and
  `mcp-server` stay at `0.4.0` and are **not** re-published (they're unchanged
  and already live).
- cli's `workspace:*` dependency ranges rewrite at publish to the siblings'
  **local** versions — `0.4.0` — which are already on the registry, so
  `@vault-ledger/cli@0.4.1` resolves cleanly for consumers.
- **The four-package dependency-ordering ritual does not apply.** That ordering
  exists to stop a dependent landing before its runtime deps; here every
  dependency is already live. It is **one command**:

  ```bash
  pnpm --filter @vault-ledger/cli publish --access public
  ```

  Stated explicitly because, left unsaid, someone will dutifully re-run the
  whole runbook.
- Preconditions still hold: clean `main`, `node scripts/verify-publish.mjs`,
  `pnpm -r publish --dry-run`, then the single publish, then the npx smoke on
  the Mac.

**Implementation note to verify:** `scripts/verify-publish.mjs` asserts
"all `@vault-ledger/*` ranges rewritten to `0.4.0`". A cli at `0.4.1` still has
**deps** at `0.4.0`, so that assertion should pass unchanged — but confirm the
script doesn't *also* assert each package's own `version === "0.4.0"`; if it
does, it needs to tolerate a per-package bump before the 0.4.1 publish.

---

## 8. File structure

**Create:**
- `docs/integrations/README.md`, `claude-code.md`, `hermes.md`, `mcp-clients.md`
- `skills/vaultledger-memory/SKILL.md`, `SNIPPET.md`
- `packages/cli/test/skillParity.test.ts`

**Modify:**
- `packages/cli/src/setup/mcpConfig.ts` — add `isEphemeralEntry`, branch
  `buildMcpConfig`
- `packages/cli/src/commands/setup.ts` (or the step that prints the block) — the
  §2.6 disclosure line
- `packages/cli/test/setup/mcpConfig.test.ts` — the §2.7 tests
- `packages/cli/package.json` — version → `0.4.1`
- `README.md`, `docs/GETTING_STARTED.md` — link the guides
