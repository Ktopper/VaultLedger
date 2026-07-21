# VaultLedger memory discipline

The `vaultledger` tools describe *how* to call them; these six rules are *when*. The vault is governed memory — every write is attributable and reversible because the broker enforces it, not because you remembered to be careful.

1. **Recall before you start** on a known entity — because starting cold means contradicting what's already known, or re-asking what the user already told you. **Recall first; on a miss, `vault_search` the raw note text; `memory_remember` what's worth keeping** — recall ranks governed *memories* ("what do I know about X"), search greps raw *content* ("which file says X"); and `vault_list` shows a folder's contents before you act on it.

2. **Remember durable facts, with a reason — never transcripts** — because the vault is memory, not a log; keep what someone still cares about next month, and the reason is what makes it auditable later.

3. **Cite or supersede an existing belief; don't write a competing duplicate** — because a duplicating agent generates conflict-queue noise, while a superseding one generates lineage the contradiction detector can use. (Mechanically: `memory_retire` takes `superseded_by`, and `memory_distill` documents that a retired source may still be cited — rules 3 and 5 are one idea.)

4. **Promote when confirmed — `scratch→working` applies immediately; `working→canonical` is a proposal a human approves** — because canonical is the belief the system will defend, so that hop is the one that needs a human.

5. **Prefer `memory_retire` over `memory_forget`** — because retired stays queryable in history and can still be cited; forget tombstones it. (Both tools require a `reason`, so that isn't the distinction — what survives is.)

6. **Never edit vault files directly — every write goes through the tools** — because the broker is the only thing that makes a change attributable and reversible; a direct write is an unattributable change `ledger undo` can't reach.
   - **Edits use `vault_propose_replace`; new files `vault_propose_create`; deletions `vault_propose_delete`; renames/moves `vault_propose_move`** — all queued for human approval; deletions and moves are git-committed so `ledger undo` restores them, and a governed *memory* is retired/forgotten (rule 5), never deleted or moved. Describe an edit as exact find/replace text (`old_text`/`new_text`) or full content and let the broker build the diff. Never hand-author a unified diff — `vault_propose_edit` (raw diff) is the advanced, `--allow-raw-diff` opt-in surface only.
   - **Read the target fresh with `vault_read` immediately before proposing, and take `old_text` (from its `content`) and `expected_hash` (its `hash`) from that same read.** Copy `old_text` byte-for-byte from the returned content — never normalize whitespace, underscores, punctuation, or timestamps, and never reconstruct the text from conversation memory.
   - **On `TEXT_NOT_FOUND` or `AMBIGUOUS_MATCH`, re-read the file and retry with a longer exact excerpt.** If it's still ambiguous, stop and report rather than forcing it.
