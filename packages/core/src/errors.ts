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
