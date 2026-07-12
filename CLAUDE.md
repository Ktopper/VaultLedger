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
