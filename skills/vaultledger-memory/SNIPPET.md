# VaultLedger memory discipline

The `vaultledger` tools describe *how* to call them; these six rules are *when*. The vault is governed memory — every write is attributable and reversible because the broker enforces it, not because you remembered to be careful.

1. **Recall before you start** on a known entity — because starting cold means contradicting what's already known, or re-asking what the user already told you.

2. **Remember durable facts, with a reason — never transcripts** — because the vault is memory, not a log; keep what someone still cares about next month, and the reason is what makes it auditable later.

3. **Cite or supersede an existing belief; don't write a competing duplicate** — because a duplicating agent generates conflict-queue noise, while a superseding one generates lineage the contradiction detector can use. (Mechanically: `memory_retire` takes `superseded_by`, and `memory_distill` documents that a retired source may still be cited — rules 3 and 5 are one idea.)

4. **Promote when confirmed — `scratch→working` applies immediately; `working→canonical` is a proposal a human approves** — because canonical is the belief the system will defend, so that hop is the one that needs a human.

5. **Prefer `memory_retire` over `memory_forget`** — because retired stays queryable in history and can still be cited; forget tombstones it. (Both tools require a `reason`, so that isn't the distinction — what survives is.)

6. **Never edit vault files directly — every write goes through the tools** — because the broker is the only thing that makes a change attributable and reversible; a direct write is an unattributable change `ledger undo` can't reach.
