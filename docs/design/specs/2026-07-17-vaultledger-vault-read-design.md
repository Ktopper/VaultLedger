# VaultLedger — `vault_read` governed read tool (0.4.6)

**Date:** 2026-07-17
**Status:** design (pre-implementation)
**Source:** field finding #7 (live 0.4.5 testing). **A missing-primitive finding.**

## The finding

0.4.5's structured propose tools (`vault_propose_replace` / `vault_propose_create`)
depend on a **fresh read**: the agent must copy `old_text` byte-for-byte from the
file's current content and pass the file's current `expected_hash`. But **the MCP
surface has no read tool.** An agent following the memory-skill discipline
("never touch the disk directly") has no governed way to obtain either value.

In the live incident, Hermes **correctly refused to propose** rather than
reconstruct bytes from conversation memory — the governed behavior working as
designed, but a dead end. The fix is the missing primitive: a governed
`vault_read` that hands back the exact bytes and their hash, so the propose
tools have a legitimate source for `old_text` and `expected_hash`.

**This closes the loop 0.4.5 opened:** read → locate exact text → propose →
approve, entirely through governed tools, no disk exception anywhere.

---

## 1. The tool

`vault_read` — **MCP-only** (like recall's content, 0.4.2). The Obsidian plugin
already has direct vault access; the locked-down-agent problem is MCP-specific.
**No bridge route** (`GET /read` is not added — same call as the 0.4.2 decision
not to read content in `GET /memories`).

| | |
|---|---|
| **input** | `{ path }` |
| **output** | `{ path, content, hash, size }` |

- **`hash`** — the canonical `sha256:<64 hex>` form, computed over the **raw file
  bytes**. This is byte-identical to what `vault_propose_replace`'s
  `expected_hash` is compared against at propose AND approve time (`hashBytes` /
  `hashFile` in `broker/hash.ts`), so the agent feeds it straight through.
- **`content`** — those exact bytes, decoded as UTF-8. The **raw file including
  frontmatter** — NOT frontmatter-stripped like recall's content, and NOT
  trimmed. `old_text` must be locatable anywhere the propose scan
  (`generateReplacementPatch`'s `indexOf` over `buf.toString("utf8")`) will
  search, and the returned hash must cover exactly what the agent sees.
- **`size`** — the byte length (`Buffer.byteLength` of the raw bytes).

### The invariant (load-bearing)

**`content` is exactly the bytes that `hash` covers.** Concretely, for the
returned triple: `hashBytes(Buffer.from(content, "utf8")) === hash` and
`Buffer.byteLength(content, "utf8") === size`. This symmetry is what makes the
read safe to drive a propose: the agent's `old_text` (a substring of `content`)
is guaranteed to exist in the exact bytes `expected_hash` (= `hash`) pins.

**No truncation, ever.** A partial `content` would break the invariant (the hash
would cover bytes the agent can't see). So the size cap is a hard rejection, not
a truncation — the opposite of recall's `byteSafeTruncate`/`truncated` contract,
which is a *display* budget where the hash symmetry does not matter.

---

## 2. The cap — 64 KiB, checked before the read

Files over **`READ_MAX_BYTES = 64 * 1024`** → **`FILE_TOO_LARGE`** (a new,
non-retriable rejection; retrying the same file can't shrink it).

**The check runs on `statSync().size` BEFORE the read** — a 4 GiB file is never
loaded into memory to discover it's over cap (this also resolves the 0.4.2
backlog note that recall's content read is output-bounded but not input-bounded;
`vault_read` is bounded on both ends).

**Why 64 KiB (justification for the record):**
- The propose-input cap is `TEXT_MAX_BYTES = 16 KiB` (bounds a single `old_text`
  / `new_text` and a whole raw patch). A note being *edited* is routinely larger
  than any single replacement — a 40 KiB note edited by a 200-byte replace is
  ordinary. So the **read cap must exceed the propose-input cap**, or you could
  never read a note big enough to be worth structured-editing.
- **64 KiB = 4× the propose cap** — comfortably covers a long-form human
  markdown note (~10k words) while bounding the MCP response and memory. A note
  over 64 KiB is rare; it is a **documented limitation** that such a note can't
  be structured-edited (you can't obtain its hash via `vault_read`) — edit it in
  Obsidian directly, or split it.
- The bridge's `BODY_LIMIT_BYTES` (16 KiB) does **not** apply — `vault_read` is
  MCP stdio, not the bridge; there is no HTTP body limit on the read response.

---

## 3. Governance — same containment as propose, but excluded ≡ missing

`vault_read` enforces the SAME trust boundary as propose, with one deliberate
divergence at the read surface (the must-confirm below). The shared primitive
`assertContainedAndReadable(vaultRoot, manifest, path)` today throws a single
`FORBIDDEN_ZONE` code for three distinct causes (verified in `containment.ts`):
- **traversal** (`Notes/../../../etc/passwd`) — `"path escapes vault root"`;
- **symlink escape** — `"path escapes vault root via symlink"`;
- **excluded zone** (`resolveZone(...) === "excluded"`: the hard-coded
  `.ledger/**`/`.git/**`, plus anything the manifest's `excluded` globs match) —
  `"path is in excluded zone"`.

### MUST: an excluded path is agent-indistinguishable from a missing file (VL-SEC-S7-04)

If `vault_read` surfaced `FORBIDDEN_ZONE` (or any "excluded"/zone vocabulary) for
an excluded-but-existing path while a genuinely-absent path returned `NOT_FOUND`,
the tool becomes an **oracle**: an agent sweeps paths and reconstructs the
excluded-glob map from the error shapes — exactly the disclosure
`redactExcludedZones` (S7-04) exists to prevent. **Requirement:** at the read
boundary, an excluded path and a missing path produce **byte-identical
agent-visible rejections** — same `NOT_FOUND` code, same `retriable: true`, same
message template (`file not found: <path>`, echoing only the agent-supplied path,
**no zone vocabulary**). Traversal / symlink escape stay `FORBIDDEN_ZONE` — those
are agent-caused structural violations, not an excluded-map disclosure.

**Mechanism (single containment implementation — no divergence):** extract the
containment+symlink core of `assertContainedAndReadable` into a pure,
behavior-preserving `assertContained(vaultRoot, relPath): string` (steps 1–2 —
traversal/symlink → `FORBIDDEN_ZONE`), and make `assertContainedAndReadable =
assertContained` + the existing excluded-throw (so **propose is byte-for-byte
unchanged** — its write path still raises `FORBIDDEN_ZONE` for excluded).
`readVaultFile` then calls `assertContained`, and maps
`resolveZone(path, manifest) === "excluded"` to `NOT_FOUND` **itself** — the
generic `file not found: <path>`.

- **Scope note (deliberate, per the ruling):** this equivalence is applied at the
  READ boundary only. Propose's excluded → `FORBIDDEN_ZONE` is left as-is: a
  write attempt is already an observable, queue-touching action, and Kris scoped
  the oracle fix to `vault_read` (the sweepable surface). Propose's weaker
  excluded/missing distinguishability is a pre-existing, separately-considered
  property, not widened here.

Readable zones are therefore the governed non-excluded zones (trusted / agent /
scratch) — the set the propose tools write to; you read the note you're about to
propose against.

### `.obsidian` hardening (ruled: hard-exclude globally, both glob forms)

`.obsidian/**` is excluded by the **default** manifest (`scanVault`), but is NOT
in the hard-coded `ALWAYS_EXCLUDED_GLOBS` (only `.ledger`/`.git` are). A
hand-edited or malformed manifest that dropped it would let `.obsidian` default
to the **trusted** zone — and `.obsidian/plugins/vaultledger/` can hold the
bridge token and plugin data. **Fix: add BOTH `.obsidian` and `.obsidian/**`** to
`ALWAYS_EXCLUDED_GLOBS` in `zones.ts` (the bare form covers the dir itself; the
`/**` form the tree), making the denial unconditional, manifest-independent.

- The sanctioned `setup --install-plugin` copies into `.obsidian/` via **direct
  fs** (`cli/src/setup/plugin.ts`), NOT through the broker / `resolveZone`, so it
  is unaffected — this only closes a governed read/write path that should never
  have reached `.obsidian` in the first place.
- Because `.obsidian` is now `resolveZone` → `excluded`, it inherits the two
  surface behaviors: **read** of `.obsidian/...` → `NOT_FOUND` (indistinguishable,
  per the oracle rule); **propose** to `.obsidian/...` → `FORBIDDEN_ZONE`. Both
  are tested in BOTH directions, manifest notwithstanding (§7).

---

## 4. Encoding — UTF-8 only, non-text rejected

The byte-symmetry invariant requires `content` (a UTF-8 string) to re-encode to
exactly the hashed bytes. A binary/non-UTF-8 file (an image, a PDF) can't
round-trip — `buf.toString("utf8")` inserts U+FFFD and `Buffer.from(...)` won't
reproduce the original bytes.

**Decision: reject a file whose bytes don't round-trip as UTF-8** with a new,
non-retriable **`NOT_TEXT`** code. Notes are UTF-8 markdown; a non-text file
isn't a proposable note, and serving lossy content would silently violate the
invariant. Implementation: after reading `buf`, compute
`content = buf.toString("utf8")` and verify `Buffer.from(content, "utf8").equals(buf)`;
on mismatch → `NOT_TEXT`.

(Distinct code from `FILE_TOO_LARGE` — different defect, different code, per the
0.4.5 rejection-code principle.)

---

## 5. Not journaled, not locked (decisions)

- **No journal writes (ruled).** A read is not a mutation; the journal is
  mutation history — the disposable index of what *changed*. Recording reads
  would bloat it, muddy "mutation history," and force a write on every read. If
  read-auditing is ever wanted it is a separate agent-access log, not this
  journal. **v1: no journal writes.**
- **No vault lock.** The safety of a lock-free read rests on the **hash, not on
  timing**: `vault_read` returns a `hash` over exactly the bytes it read, and the
  propose tools RE-VERIFY that hash against live content at both propose and
  approve — so a read that raced a concurrent mutation self-corrects as a clean
  `STALE_HASH` at propose, never a silent bad edit. (Broker writes are
  additionally atomic temp+rename via `writeContainedFile`, so a same-process
  read is never byte-torn; but git-driven working-tree changes from
  `undo`/`reconcile` are NOT temp+rename — which is exactly why the hash
  re-verification, not write atomicity, is the load-bearing guarantee.) Skipping
  the lock also avoids stalling a cheap read behind a slow mutation.

---

## 6. Broker representation

`vault_read` is a **read primitive, not a `ProposedOperation`** — it does not go
through `Broker.apply` (no op in the discriminated union, no lock, no journal).
It mirrors `recall`: a **standalone, pure-ish core function** the MCP tool wires
directly.

- **`readVaultFile(vaultRoot, manifest, path, opts?): VaultReadResult`** in a new
  `packages/core/src/broker/read.ts` (composes `assertContained` + `resolveZone` +
  `statSync` + `readFileSync` + `hashBytes`). `opts.maxBytes` overrides
  `READ_MAX_BYTES` (for tests). Returns `{ path, content, hash, size }`. Order:
  1. `assertContained(vaultRoot, path)` → abs path (traversal / symlink escape →
     `FORBIDDEN_ZONE`; the extracted containment core — §3). **Then
     `resolveZone(path, manifest) === "excluded"` → `NOT_FOUND`** with the
     generic `file not found: <path>` message and `retriable: true` — the oracle
     rule (§3): an excluded path is byte-identical to a missing one, NO zone
     vocabulary. (This mapping happens HERE, at the read boundary, not in the
     shared gate — propose is unchanged.)
  2. `statSync(abs)` in a try: **`ENOENT` → `NOT_FOUND`** thrown with
     **`retriable: true` at the call site** (the enum default stays
     non-retriable; this per-call override matches the 0.4.5 `applyProposeReplace`
     precedent — a wrong path is agent-fixable); **a non-file** (`!st.isFile()` —
     directory, socket) → `NOT_FOUND` retriable (nothing readable as a note
     there); any other errno (`EACCES`, …) propagates. `statSync`-first is
     deliberate: `statSync` (not `readFileSync`) is where a missing path surfaces
     `ENOENT`, and the `isFile` guard keeps a **directory** path from reaching
     `readFileSync`, which would throw a raw `EISDIR` that `guarded()` mislabels
     as a generic non-retriable `INTERNAL`.
  3. **size gate**: `st.size > maxBytes` → **`FILE_TOO_LARGE`** — BEFORE any read,
     so a huge file is never loaded into memory.
  4. `readFileSync(abs)` → buffer, once.
  5. `hash = hashBytes(buf)`; `content = buf.toString("utf8")`; **UTF-8 round-trip
     gate**: `!Buffer.from(content, "utf8").equals(buf)` → **`NOT_TEXT`**.
  6. assemble `{ path, content, hash, size: buf.length }`.
- **MCP tool `vault_read`** in `mcp-server/src/tools.ts`: `ReadInput` = `{ path:
  z.string().min(1).max(PATH_MAX_LENGTH) }`, `.strict()`; handler calls
  `readVaultFile(ctx.vaultRoot, ctx.manifest, path)` inside the existing
  `guarded(...)` wrapper and returns the result object (a `BrokerError` becomes a
  structured `{ error }` via `brokerError`, exactly like the other tools).

### New rejection codes + the exhaustive-map couplings

**Retriable flag for every code this tool raises** (the exhaustive `RETRIABLE`
record forces the two new entries anyway — stating them so the intent is on record):

| code | new? | `retriable` | why |
|---|---|---|---|
| `NOT_FOUND` | existing | **`true`** (call-site override) | a wrong/missing path — and every excluded path (oracle rule) — is agent-fixable by correcting the path |
| `FILE_TOO_LARGE` | **new** | **`false`** | the file can't shrink; retrying the identical read never succeeds |
| `NOT_TEXT` | **new** | **`false`** | a binary/non-UTF-8 file never becomes text on retry |
| `FORBIDDEN_ZONE` | existing | `false` | traversal/symlink escape — a structural violation, not retriable |

**`FILE_TOO_LARGE` message states the honest consequence** — not a bare "too
large", but that the file is **out of reach of the structured-edit path
entirely** (its hash can't be obtained via `vault_read`, so it can't be safely
proposed against) and the agent should **report to the human and stop, NOT fall
back to guessing the bytes**. Guessing is the exact failure class this whole tool
exists to kill; the over-cap message must say so, e.g.: *"file <path> is <n>
bytes, over the <cap>-byte read cap; it cannot be read or structured-edited — ask
a human to edit it directly, do not reconstruct its contents from memory."*

**Pre-empt the couplings a new code / new tool always trips (learned in 0.4.5):**
- `packages/server/src/app.ts` `BROKER_ERROR_STATUS: Record<RejectionCode, number>`
  is exhaustive — add `FILE_TOO_LARGE: 413` (Payload Too Large) and `NOT_TEXT:
  415` (Unsupported Media Type). (These, like `INVARIANT_VIOLATION`, are not
  reachable through a server route today — `vault_read` is MCP-only — but the map
  must be exhaustive to compile. `server` stays 0.4.0.)
- **Catalog 11 → 12.** Thread the count through `mcp-server/src/index.ts`
  `listToolNames()` (a separate hard-coded array), and BOTH the numeric
  assertions AND the descriptive titles: `test/tools.test.ts` (`toBe(11)` +
  "registers exactly the 11 spec tools" + the "count 9 → 11" title),
  `test/placeholder.test.ts` (`toHaveLength(11)` + title), `test/stdio.smoke.test.ts`
  (`.toBe(11)` + "list 11 tools"). While threading, fix the pre-existing stale
  comments to 12: `tools.ts` ("Build the 9 spec tools") and `index.ts` ("Wire the
  9 tools").

---

## 7. Tests

- **hash-matches-bytes exactly**, including a file WITH a trailing newline and a
  file WITHOUT one (`hashBytes(Buffer.from(content,"utf8")) === hash` and
  `size === Buffer.byteLength(content)` both hold in each case).
- **cap boundary**: a file of exactly `READ_MAX_BYTES` reads OK; `READ_MAX_BYTES
  + 1` → `FILE_TOO_LARGE` (asserted via `opts.maxBytes` on a small fixture so the
  test isn't a 64 KiB blob). The size gate reads via `statSync` (a spy/asserting
  the file was never `readFileSync`'d when over cap is a nice-to-have).
- **traversal / symlink escape → `FORBIDDEN_ZONE`** (`../outside`, and a symlink
  pointing out of the vault) — these stay a distinct code (agent-caused, not an
  excluded-map disclosure).
- **excluded → `NOT_FOUND`, NOT `FORBIDDEN_ZONE`**: reading `.ledger/journal.db`,
  `.git/config`, `.obsidian/plugins/vaultledger/data.json`, and a
  manifest-excluded `Private/secret.md` each returns `NOT_FOUND` (`retriable:
  true`), with **no zone vocabulary** in the message. The `.obsidian` and
  `.ledger`/`.git` cases pinned **regardless of manifest** (proves the
  `ALWAYS_EXCLUDED_GLOBS` additions, not a manifest coincidence).
- **NAMED must-confirm — excluded ≡ missing (VL-SEC-S7-04 oracle test):** seed an
  EXISTING file in an excluded zone (`Private/secret.md`, manifest excludes
  `Private/**`) and pick a genuinely-absent path (`Notes/ghost.md`). Read both;
  assert the two rejection payloads are **indistinguishable**: identical `code`
  (`NOT_FOUND`) and `retriable` (`true`), and message shape identical modulo the
  echoed path (both match `/^file not found: /`; NEITHER contains
  `excluded`/`zone`/`forbidden`). This is the disclosure guarantee — pin it
  directly.
- **`.obsidian` in BOTH directions** (per the ruling): `vault_read`
  `.obsidian/plugins/vaultledger/data.json` → `NOT_FOUND` (indistinguishable);
  and a `vault_propose_create`/`vault_propose_replace` targeting `.obsidian/...`
  → `FORBIDDEN_ZONE` — both asserted with a manifest that does NOT list
  `.obsidian` (proves the hard-exclude, not a manifest coincidence). Plus a
  `zones` unit: bare `.obsidian` and `.obsidian/foo` both `resolveZone` →
  `excluded` (both glob forms).
- **missing file → `NOT_FOUND` with `retriable: true`** (surfaced from
  `statSync` `ENOENT`, not `readFileSync`).
- **directory path → `NOT_FOUND`** (the `!isFile()` guard — proves a dir never
  reaches `readFileSync` to throw a raw `EISDIR` the harness would mislabel).
- **non-UTF-8 → `NOT_TEXT`** (a fixture with an invalid UTF-8 byte sequence).
- **over-cap message** contains the honest consequence (mentions the cap and that
  the file can't be structured-edited); asserts it carries no "reconstruct"-able
  fallback framing.
- **NAMED integration test — the loop the field incident couldn't close:**
  `readVaultFile` a seeded note → take its `content` + `hash` → drive a
  `vault_propose_replace` with an `old_text` copied from `content` and
  `expected_hash = hash` → it queues a correct diff and approves cleanly. Proves
  read output feeds propose end-to-end.

### Fixtures — from real observed data (derived from `xxd`, not retyped)

Use the **actual "Testing" note from the field incident** as the primary
fixture, seeded **byte-for-byte** — exact frontmatter, LF endings, the underscore
timestamp, and (the detail `cat`/`sed` can't disambiguate) the **trailing-newline
state**. The fixture derives from an `xxd` dump Kris runs on the real vault
(`shasum -a 256` + `wc -c` + `xxd` of the note); the test does NOT retype the note
from a rendered view.

Pre-computed candidates (to confirm which state the file is in at capture):
- **with** a trailing newline → **150 bytes**, sha256
  `55bf4472169d83d1a0bf3da6dd03d010d3406a0c0ba2ae0b72d0d0b5e3add67b`;
- **without** → **149 bytes**, sha256 `6dd2241f…905b`.

If the live `shasum` matches **neither**, the note has since been modified (e.g.
Hermes's approved edit landed) — the `xxd` dump is then ground truth and the
fixture uses whichever state it shows, **labeled accordingly in the test**
(so the fixture's provenance is legible: which real state it captured, and when).
The `hash` the tests assert `vault_read` returns MUST equal the fixture's real
`shasum` (prefixed `sha256:`) — the whole point is real bytes → real hash.

---

## 8. Versioning & publish

- **core + mcp-server → 0.4.6.** core: `readVaultFile` + `READ_MAX_BYTES` + the
  two codes + the `.obsidian` hard-exclude (both glob forms) + the behavior-
  preserving `assertContained` extraction (so the read boundary can map excluded →
  `NOT_FOUND` without reimplementing containment, propose unchanged). mcp-server:
  the `vault_read` tool + catalog count. cli 0.4.1 / server 0.4.0 / plugin 0.4.1
  unchanged.
- Ordered publish **core → mcp-server**, same runbook.

## 9. Docs (build-time; sequenced after the 0.4.5 §9 doc pass merges)

The memory skill rule 6 and the integration guides currently say "read the
target fresh through VaultLedger." Change that to name **`vault_read`
explicitly** — there is no longer any direct-disk exception, and the fresh-read
step now has a concrete tool. Catalog references 11 → 12.

**Also correct the propose tool description STRINGS** (`tools.ts` — code, not
docs, and no dependency on the doc-branch sequencing below): `vault_propose_replace`'s
description currently tells the agent to get `expected_hash` "from memory_recall /
ledger_status", but neither reliably surfaces a note's hash — `recall()`'s result
has no hash field, and `ledger_status` only carries `hash_after` on VL-mutated
transaction rows, not an arbitrary trusted note. Name **`vault_read`** as the
canonical source of `expected_hash` (and of the content to copy `old_text` from)
in the `vault_propose_replace` and `vault_propose_edit` descriptions. This
inaccuracy is exactly the gap `vault_read` closes, so fixing it belongs in this
cycle.

> **Sequencing:** these edits build on the 0.4.5 §9 doc pass (branch
> `docs/structured-tools-guidance`, which added the rule-6 elaboration + 9→11
> counts). That branch must merge to `main` before this cycle's doc updates, or
> the two edits collide on rule 6 / the tool counts. The **code** work
> (§§1–8) has no such dependency.

---

## 10. Non-goals

- **No truncation / partial reads** — the byte-symmetry invariant forbids it;
  over-cap is a hard `FILE_TOO_LARGE`.
- **No binary/base64 content** — non-UTF-8 files are rejected (`NOT_TEXT`), not
  served as bytes. (A future `vault_read_binary` is out of scope.)
- **No journaling of reads** — the journal stays mutation history (§5).
- **No bridge route** — MCP-only; the plugin has native vault access.
- **No excluded-zone reads** — reading `Private/**` or `.obsidian`/`.ledger`/
  `.git` is denied by design (the redaction posture, S7-04).
- **No directory listing / glob read** — single file by exact path only.
