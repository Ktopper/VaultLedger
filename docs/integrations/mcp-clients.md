# VaultLedger + any MCP client

The two concrete guides — [Claude Code](claude-code.md) and [Hermes](hermes.md)
— are instances of one small contract. If your harness speaks MCP, this page is
what it needs. New to VaultLedger?
[`docs/GETTING_STARTED.md`](../GETTING_STARTED.md) is the 10-minute fast path.

## 1. Wire it

**The minimal contract.** VaultLedger ships a **stdio** MCP server. Your harness
needs to launch it with a `command` and `args`, where the args end in
`--vault <absolute path>`:

```
command: vaultledger-mcp
args:    ["--vault", "/absolute/path/to/vault"]
```

Three requirements, and only three:

1. **stdio transport.** The server talks JSON-RPC over stdin/stdout. No port, no
   URL, no auth token. If your harness only supports HTTP/SSE MCP servers, it
   can't launch this one directly.
2. **`--vault <absolute path>`, always absolute.** This binds the server to a
   vault. A relative path resolves against the harness's working directory,
   which is rarely what you think it is.
3. **A durable command.** Either form works:
   - **A published bin on `PATH`** — after `npm install -g
     @vault-ledger/mcp-server`, the bin is `vaultledger-mcp`. (Using nvm?
     Reinstall after switching Node versions — global bins are
     Node-version-scoped.)
   - **The npx form** — `npx` with args `["-y", "-p",
     "@vault-ledger/mcp-server", "vaultledger-mcp", "--vault", "<vault>"]`. The
     bin name differs from the package name, hence `-p <package> <bin>`.

**Never a path that can be pruned.** That's the actual rule — not "always use
npx." A `~/.npm/_npx/<hash>/node_modules/…` path works today and dies silently
weeks later when npm prunes the cache, presenting as a baffling "MCP server not
responding" long after you've forgotten you configured anything. A `PATH`-resolved
bin is durable. A stable physical path (a clone's
`packages/mcp-server/dist/index.js`) is durable. A cache path is not.

Whatever your harness's config format — JSON, YAML, TOML, a UI form — it's
carrying those same fields. Then **reload the harness** so it spawns the server.

## 2. Verify it

Two steps, because they catch different failures.

**Step 1 — the install side:**

```sh
npx @vault-ledger/cli@latest doctor /path/to/vault
```

Checks that the native binding loads, the mcp-server entry resolves, and the
vault, zones, and journal are healthy. `--json` emits `CheckResult[]`;
`--strict` treats warnings as failures (exit 1).

**Step 2 — end-to-end:** restart the harness, ask the agent to remember
something, then in a **new session** ask it to recall. Check that the note
landed in `Agent/Memory/` in the vault.

Step 2 is the real proof, because **doctor validates the install but never reads
YOUR harness config** — a stale path in there fails only at harness-connect
time, which doctor can't see. Step 1 tells you *which side* is broken when step
2 fails: doctor green + recall broken means the wiring.

## 3. Teach it

Your harness exposes some way to give the agent standing instructions — a system
prompt, a profile, a rules file, a skill. Whatever it's called, paste in
[`skills/vaultledger-memory/SNIPPET.md`](../../skills/vaultledger-memory/SNIPPET.md):
six rules that teach the agent *when* to reach for the fifteen tools, each with its
rationale. A taste:

> **Never edit vault files directly — every write goes through the tools** —
> because the broker is the only thing that makes a change attributable and
> reversible.

The fifteen default tools your harness will see: `memory_recall`,
`memory_remember`, `memory_revise`, `memory_promote`, `memory_retire`,
`memory_forget`, `memory_distill`, `vault_read`, `vault_search`, `vault_list`,
`vault_propose_replace`, `vault_propose_create`, `vault_propose_delete`,
`vault_propose_move`, `ledger_status`. For vault writes, `vault_propose_replace`
(edits), `vault_propose_create` (new files), `vault_propose_delete`, and
`vault_propose_move` (rename/relocate) are the path — the broker builds the diff
or does the git-committed op, all queued for approval; the raw-diff
`vault_propose_edit` is a 16th tool behind the `--allow-raw-diff` opt-in, not on
the default surface. For discovery, `vault_read` returns a note's exact bytes and
`hash` (the fresh read a replace copies `old_text`/`expected_hash` from),
`vault_search` greps raw note content ("which file says X"), and `vault_list`
enumerates a folder. Note that some harnesses **rename** tools on registration (Hermes prefixes
them `mcp_vaultledger_*`), so check yours before writing tool names into a filter
or a prompt.

## 4. Trust model

**Assume nothing about what your harness gates.** The catalog, approval, and
trust model differ per harness: some prompt before every tool call, some prompt
once, some maintain an allowlist, some — like Hermes — don't prompt at all for
custom entries. Some let you configure the prompting away entirely.

None of that changes what VaultLedger guarantees, and that's the point.
VaultLedger's broker is the enforcement layer: **trusted-zone writes queue for
human approval regardless of what the agent attempts**, whatever your harness
does or doesn't ask you first. The guarantees deliberately don't rely on the
harness — that's the whole reason they're enforced in code rather than in a
prompt. A harness's approval prompts are a bonus, never the guarantee.

So you don't need to audit your harness's trust model before wiring VaultLedger
in. That was the design goal.
