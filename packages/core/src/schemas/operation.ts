import { z } from "zod";
import { Confidence, MemoryStatus } from "./provenance.js";

const commonOpFields = {
  reason: z.string().min(1),
  session: z.string().min(1),
};

export const CreateOp = z
  .object({
    op: z.literal("create"),
    path: z.string().min(1),
    content: z.string(),
    entity: z.string().optional(),
    tags: z.array(z.string()).optional(),
    ...commonOpFields,
  })
  .strict();

export const ReviseOp = z
  .object({
    op: z.literal("revise"),
    path: z.string().min(1),
    // Optional at the schema layer; the broker enforces it conditionally —
    // required for an edit, forbidden for a creation (`--- /dev/null`). A
    // hash-less edit is rejected in the broker (MALFORMED_HASH), not here.
    expected_hash: z.string().min(1).optional(),
    patch: z.string().min(1),
    entity: z.string().optional(),
    ...commonOpFields,
  })
  .strict();

export const ProposeEditOp = ReviseOp.extend({ op: z.literal("propose_edit") });

/** v0.4.5: structured replace. `expected_hash` is a REQUIRED field (not
 * conditional like revise/propose_edit) — a replace always pins an existing
 * snapshot. `old_text`/`new_text` are NOT `.min(1)`: an empty `old_text` is a
 * RETRIABLE broker reject (see broker.applyProposeReplace), not a shape error;
 * an empty `new_text` is a legal intra-file deletion. */
export const ProposeReplaceOp = z
  .object({
    op: z.literal("propose_replace"),
    path: z.string().min(1),
    expected_hash: z.string().min(1),
    replacements: z
      .array(
        z
          .object({
            old_text: z.string(),
            new_text: z.string(),
            expected_occurrences: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .min(1),
    ...commonOpFields,
  })
  .strict();

/** v0.4.5: structured creation from full content. No `expected_hash` (there is
 * nothing to hash — the file does not exist). The broker generates a
 * `/dev/null`-headed creation diff and feeds the create branch of
 * applyProposeEdit, which owns TARGET_EXISTS + Option B. */
export const ProposeCreateOp = z
  .object({
    op: z.literal("propose_create"),
    path: z.string().min(1),
    content: z.string(),
    ...commonOpFields,
  })
  .strict();

export const PromoteOp = z
  .object({
    op: z.literal("promote"),
    id: z.string().min(1),
    target_status: MemoryStatus,
    ...commonOpFields,
  })
  .strict();

export const ForgetOp = z
  .object({
    op: z.literal("forget"),
    id: z.string().min(1),
    ...commonOpFields,
  })
  .strict();

// v0.3b: like promote/forget, `retire` operates on a memory id, not a path --
// it is resolved by the memory store, which validates `superseded_by` (when
// present) and issues the underlying (approved) `revise` that flips
// `ledger.status`/`ledger.retired_reason`/`ledger.superseded_by`. This shape
// only exists for typing/journal/MCP; `Broker.apply()` rejects it outright
// (see broker.ts's promote/forget/distill reject arm).
export const RetireOp = z
  .object({
    op: z.literal("retire"),
    id: z.string().min(1),
    superseded_by: z.string().optional(),
    ...commonOpFields,
  })
  .strict();

// v0.3b: like promote/forget, `distill` operates on memory ids (the sources
// being cited), not a path -- it is resolved by the memory store, which
// validates the sources and issues the underlying `create`. This shape only
// exists for typing/journal/MCP; `Broker.apply()` rejects it outright (see
// broker.ts's promote/forget reject arm).
export const DistillOp = z
  .object({
    op: z.literal("distill"),
    content: z.string(),
    sources: z.array(z.string()),
    entity: z.string().optional(),
    confidence: Confidence.optional(),
    score: z.number().optional(),
    ...commonOpFields,
  })
  .strict();

export const ProposedOperation = z.discriminatedUnion("op", [
  CreateOp,
  ReviseOp,
  ProposeEditOp,
  ProposeReplaceOp,
  ProposeCreateOp,
  PromoteOp,
  ForgetOp,
  DistillOp,
  RetireOp,
]);
export type ProposedOperation = z.infer<typeof ProposedOperation>;
