# VaultLedger — standing instructions

- The model never writes vault files directly; all mutations go through the broker.
- Patch-level edits only; whole-file rewrites are a broker rejection.
- Every mutation must be attributable: session, reason, commit.
- `.ledger/` is the only in-vault footprint of agent/broker writes besides the
  agent zone. Two sanctioned human-initiated exceptions, both disclosed and
  never touching notes: (1) `ledger init`/`setup` runs `git init` if the vault
  isn't already a repo — the `.git/` history is the rollback substrate `ledger
  undo` depends on; (2) `ledger setup --install-plugin` copies the review plugin
  into `<vault>/.obsidian/plugins/` (Obsidian config, opt-in flag).
- When in doubt between convenience and auditability, choose auditability.
- Vault + Git are the source of truth; the SQLite journal is a disposable index.

## API surface (frozen — v1)

The v1 agent surface is **frozen** as of 0.4.7. It is these **15 default tools**:
`memory_recall`, `memory_remember`, `memory_revise`, `memory_promote`,
`memory_retire`, `memory_forget`, `memory_distill`, `vault_read`,
`vault_propose_replace`, `vault_propose_create`, `vault_propose_delete`,
`vault_propose_move`, `vault_list`, `vault_search`, `ledger_status`.
`vault_propose_edit` (raw unified-diff) is the **sole expert opt-in**, exposed
only when the server is launched with `--allow-raw-diff` (16 tools with it).

- **Nothing new lands on the agent surface without something being removed** —
  a net-new tool is a deliberate un-freeze decision, not a default.
- Only **bug fixes** ship against this surface until an explicit un-freeze.
