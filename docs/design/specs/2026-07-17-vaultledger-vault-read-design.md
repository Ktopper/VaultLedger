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

## 3. Governance — the same gate as propose

`vault_read` routes through **`assertContainedAndReadable(vaultRoot, manifest,
path)`** — the single shared trust-boundary primitive the broker and recall
already use. For free, this rejects:
- **traversal** (`Notes/../../../etc/passwd`) → `FORBIDDEN_ZONE`;
- **symlink escape** out of the vault root → `FORBIDDEN_ZONE`;
- **excluded-zone** paths, including the hard-coded `.ledger/**` and `.git/**`
  and anything the manifest's `excluded` globs match → `FORBIDDEN_ZONE`.

Readable zones are therefore exactly the governed non-excluded zones (trusted /
agent / scratch) — the same set the propose tools write to, which is the point:
you read the note you're about to propose against.

### `.obsidian` hardening (ruled: hard-exclude globally)

`.obsidian/**` is excluded by the **default** manifest (`scanVault`), but is NOT
in the hard-coded `ALWAYS_EXCLUDED_GLOBS` (only `.ledger`/`.git` are). A
hand-edited or malformed manifest that dropped it would let `.obsidian` default
to the **trusted** zone — and `.obsidian/plugins/vaultledger/` can hold the
bridge token and plugin data. **Fix: add `.obsidian` (and `.obsidian/**`) to
`ALWAYS_EXCLUDED_GLOBS`** in `zones.ts`, making the denial unconditional for
`vault_read` AND propose (defense in depth, manifest-independent).

- The sanctioned `setup --install-plugin` copies into `.obsidian/` via **direct
  fs** (`cli/src/setup/plugin.ts`), NOT through the broker / `resolveZone`, so it
  is unaffected — this only closes a governed read/write path that should never
  have reached `.obsidian` in the first place.
- Small change to a shared primitive; a `zones` test pins that `.obsidian/foo`,
  `.obsidian/plugins/vaultledger/data.json` resolve to `excluded` regardless of
  manifest.

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
  `packages/core/src/broker/read.ts` (composes `assertContainedAndReadable` +
  `statSync` + `readFileSync` + `hashBytes`). `opts.maxBytes` overrides
  `READ_MAX_BYTES` (for tests). Returns `{ path, content, hash, size }`. Order:
  1. `assertContainedAndReadable(vaultRoot, manifest, path)` → abs path
     (traversal / symlink / excluded → `FORBIDDEN_ZONE`).
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

Add to `RejectionCode` + the `RETRIABLE` map (both **non-retriable**):
- **`FILE_TOO_LARGE`** — file exceeds `READ_MAX_BYTES`.
- **`NOT_TEXT`** — file isn't valid round-trippable UTF-8.

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
- **governance denial**: traversal (`../outside`), `.ledger/journal.db`,
  `.git/config`, and **`.obsidian/plugins/vaultledger/data.json`** each →
  `FORBIDDEN_ZONE` — the `.obsidian` case pinned **regardless of manifest**
  (proves the `ALWAYS_EXCLUDED_GLOBS` addition, not a manifest coincidence).
- **missing file → `NOT_FOUND` with `retriable: true`** (surfaced from
  `statSync` `ENOENT`, not `readFileSync`).
- **directory path → `NOT_FOUND`** (the `!isFile()` guard — proves a dir never
  reaches `readFileSync` to throw a raw `EISDIR` the harness would mislabel).
- **non-UTF-8 → `NOT_TEXT`** (a fixture with an invalid UTF-8 byte sequence).
- **NAMED integration test — the loop the field incident couldn't close:**
  `readVaultFile` a seeded note → take its `content` + `hash` → drive a
  `vault_propose_replace` with an `old_text` copied from `content` and
  `expected_hash = hash` → it queues a correct diff and approves cleanly. Proves
  read output feeds propose end-to-end.

### Fixtures — from real observed data

Use the **actual "Testing" note from the field incident** as the primary fixture
(seeded verbatim — exact frontmatter, whitespace, and trailing-newline state), so
the hash/round-trip/propose tests exercise the real shape that surfaced the gap,
not a synthetic one. (Note content supplied by Kris; baked into the test at
build.)

---

## 8. Versioning & publish

- **core + mcp-server → 0.4.6.** core: `readVaultFile` + `READ_MAX_BYTES` + the
  two codes + the `.obsidian` hard-exclude. mcp-server: the `vault_read` tool +
  catalog count. cli 0.4.1 / server 0.4.0 / plugin 0.4.1 unchanged.
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
