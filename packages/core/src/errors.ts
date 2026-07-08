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
