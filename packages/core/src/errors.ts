export const RejectionCode = {
  FORBIDDEN_ZONE: "FORBIDDEN_ZONE",
  STALE_HASH: "STALE_HASH",
  PATCH_TOO_LARGE: "PATCH_TOO_LARGE",
  SYNTAX_BREAK: "SYNTAX_BREAK",
  NOT_FOUND: "NOT_FOUND",
  TARGET_EXISTS: "TARGET_EXISTS",
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  REVERT_CONFLICT: "REVERT_CONFLICT",
  // v0.1 addition (Phase 2c, undo): distinguishes "this transaction was
  // already reverted" from a true REVERT_CONFLICT (a git-level merge
  // conflict) or NOT_FOUND (no such transaction at all). Neither of those
  // codes fit this case, so it gets its own.
  ALREADY_REVERTED: "ALREADY_REVERTED",
  // v0.1 addition (Phase 3a, memory store promote()): a memory status
  // transition outside the two supported in v0.1 (scratch->working auto,
  // working->canonical via approval). None of the existing codes describe
  // "this state change isn't allowed", so it gets its own.
  INVALID_TRANSITION: "INVALID_TRANSITION",
  // v0.3a addition (conflicts queue resolve/dismiss): the conflict-side
  // analog of ALREADY_REVERTED above -- the target conflict is not `open`
  // (already resolved or dismissed by an earlier call), so the
  // resolve/dismiss must be rejected rather than silently flipping its state
  // a second time (an audit-integrity hole: two operators could each believe
  // THEY were the one who closed it).
  ALREADY_CLOSED: "ALREADY_CLOSED",
  // v0.3a addition (provenance tamper closure): an unapproved revise whose
  // patch changes a note's governed provenance -- the `ledger:` block
  // (status / supersedes) or the top-level `entity` field. Those are governed
  // -- an agent self-promoting to canonical, faking a supersedes lineage
  // link, or silently dropping a belief from its same-entity comparison set
  // by rewriting entity would each bypass the human approval gate, so none of
  // the existing codes fit and this gets its own.
  LEDGER_GUARD: "LEDGER_GUARD",
  // v0.3a addition (enqueue/apply-time input guard): a revise/propose_edit
  // op's `expected_hash` that does not match the canonical `sha256:<64 hex>`
  // format (e.g. a bare hex digest missing the `sha256:` prefix). Distinct
  // from STALE_HASH on purpose: STALE_HASH means "the file changed underneath
  // you, recompute and retry"; MALFORMED_HASH means "you formatted this
  // wrong" -- retrying the identical value can never fix it. Rejecting at
  // call time (rather than letting a malformed hash enter the queue and only
  // fail at approve-time as a confusing stale-hash) gives the caller an
  // immediate, actionable error.
  MALFORMED_HASH: "MALFORMED_HASH",
  // v0.3b addition (memory_distill source validation): a distillation cites
  // a source id that either doesn't exist, is `forgotten`, or (empty
  // `sources`) cites nothing at all. Distinct from NOT_FOUND -- NOT_FOUND is
  // "the thing you asked to operate ON doesn't exist"; INVALID_SOURCE is "one
  // of the things you're CITING is unusable as a citation" -- a distillation
  // with a bad source is a caller input error, not a missing-target error.
  // Checked BEFORE any write (store.distill validates every source up front),
  // so a bad citation never produces a half-written note or dangling
  // memory_relations row.
  INVALID_SOURCE: "INVALID_SOURCE",
  // VL-SEC-S7-03 fix: scanVault's own self-check that every folder matching
  // the Private-folder pattern (at any depth) actually resolves to the
  // excluded zone under the manifest it is about to propose. This is a
  // defense-in-depth backstop against a future regression re-introducing a
  // root-anchored-only exclusion glob -- the tool must catch its own
  // under-exclusion rather than silently handing `ledger init`/`setup` a
  // manifest that claims hasPrivate:true but doesn't actually exclude it.
  // Not retriable: the same scan of the same tree reproduces the identical
  // (broken) manifest every time -- only a code fix resolves it.
  INVARIANT_VIOLATION: "INVARIANT_VIOLATION",
  // v0.4.5 (structured replace): the `old_text` of a vault_propose_replace
  // replacement matched 0 times in the hash-pinned snapshot. Retriable and
  // DISTINCT from NOT_FOUND (which is a genuinely-missing FILE, non-retriable):
  // here the file exists and the fix is "add more surrounding context / correct
  // the text and retry", so it must tell the agent to retry.
  TEXT_NOT_FOUND: "TEXT_NOT_FOUND",
  // v0.4.5: an `old_text` matched a different number of times than
  // `expected_occurrences` (default 1). Retriable — the agent widens the
  // context to make the match unique (or sets expected_occurrences).
  AMBIGUOUS_MATCH: "AMBIGUOUS_MATCH",
  // v0.4.5: two replacements' match spans overlap in the one snapshot, so
  // "apply both" is undefined. Retriable — the agent drops/merges one.
  OVERLAPPING_REPLACEMENTS: "OVERLAPPING_REPLACEMENTS",
  // v0.4.6 (vault_read): file exceeds READ_MAX_BYTES. Non-retriable — the file
  // can't shrink; retrying the identical read never succeeds. The message tells
  // the agent the file is out of reach of the structured-edit path and to ask a
  // human rather than guess bytes (guessing is the failure class vault_read kills).
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  // v0.4.6 (vault_read): file isn't valid round-trippable UTF-8 (binary/attachment).
  // The byte-symmetry invariant requires content to re-encode to exactly the
  // hashed bytes; a non-text file can't. Non-retriable.
  NOT_TEXT: "NOT_TEXT",
  // v0.4.7 (vault_propose_move): the move destination is already occupied.
  // RETRIABLE and DELIBERATELY DISTINCT from create's TARGET_EXISTS: TARGET_EXISTS
  // is non-retriable and steers the caller to `edit` (the file exists; edit it in
  // place); DESTINATION_EXISTS is retriable and steers the caller to pick a
  // different `to` (or delete the occupant first) — the source still needs a home,
  // so retrying against a free destination is the fix.
  DESTINATION_EXISTS: "DESTINATION_EXISTS",
} as const;

export type RejectionCode = (typeof RejectionCode)[keyof typeof RejectionCode];

const RETRIABLE: Record<RejectionCode, boolean> = {
  FORBIDDEN_ZONE: false,
  STALE_HASH: true,
  PATCH_TOO_LARGE: false,
  SYNTAX_BREAK: false,
  NOT_FOUND: false,
  TARGET_EXISTS: false,
  APPROVAL_REQUIRED: true,
  REVERT_CONFLICT: false,
  ALREADY_REVERTED: false,
  INVALID_TRANSITION: false,
  ALREADY_CLOSED: false,
  // Retrying the identical unapproved revise won't help -- the ledger block
  // is still unapproved to change; the caller must go through
  // promote/forget/setStatus (or get human approval) instead.
  LEDGER_GUARD: false,
  // Retrying the identical malformed expected_hash string won't turn it into
  // a well-formed one -- the caller must fix its format and resubmit.
  MALFORMED_HASH: false,
  // Retrying with the identical source list won't help -- the caller must
  // fix the citation (drop the bad id, cite a live/retired one, or supply at
  // least one source) and resubmit.
  INVALID_SOURCE: false,
  INVARIANT_VIOLATION: false,
  // All three are agent-fixable input conditions against a live snapshot:
  // add context, correct the text, or drop an overlapping replacement.
  TEXT_NOT_FOUND: true,
  AMBIGUOUS_MATCH: true,
  OVERLAPPING_REPLACEMENTS: true,
  FILE_TOO_LARGE: false,
  NOT_TEXT: false,
  // Retriable: the same source still needs a destination, so retrying against a
  // free `to` (or after deleting the occupant) succeeds.
  DESTINATION_EXISTS: true,
};

export interface Rejection {
  code: RejectionCode;
  message: string;
  retriable: boolean;
}

export class BrokerError extends Error {
  code: RejectionCode;
  retriable: boolean;

  constructor(code: RejectionCode, message: string, retriable?: boolean) {
    super(message);
    this.name = "BrokerError";
    this.code = code;
    this.retriable = retriable ?? RETRIABLE[code];
  }

  toRejection(): Rejection {
    return { code: this.code, message: this.message, retriable: this.retriable };
  }
}
