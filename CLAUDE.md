# VaultLedger — standing instructions

- The model never writes vault files directly; all mutations go through the broker.
- Patch-level edits only; whole-file rewrites are a broker rejection.
- Every mutation must be attributable: session, reason, commit.
- `.ledger/` is the only in-vault footprint besides the agent zone.
- When in doubt between convenience and auditability, choose auditability.
- Vault + Git are the source of truth; the SQLite journal is a disposable index.
