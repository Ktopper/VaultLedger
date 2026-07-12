# VaultLedger — standing instructions

- The model never writes vault files directly; all mutations go through the broker.
- Patch-level edits only; whole-file rewrites are a broker rejection.
- Every mutation must be attributable: session, reason, commit.
- `.ledger/` is the only in-vault footprint of agent/broker writes besides the
  agent zone. (The one sanctioned human-initiated exception: `ledger setup
  --install-plugin` copies the review plugin into `<vault>/.obsidian/plugins/`
  — an explicit opt-in flag, touching Obsidian config, never notes.)
- When in doubt between convenience and auditability, choose auditability.
- Vault + Git are the source of truth; the SQLite journal is a disposable index.
