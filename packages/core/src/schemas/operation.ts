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
    expected_hash: z.string().min(1),
    patch: z.string().min(1),
    entity: z.string().optional(),
    ...commonOpFields,
  })
  .strict();

export const ProposeEditOp = ReviseOp.extend({ op: z.literal("propose_edit") });

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
  PromoteOp,
  ForgetOp,
  DistillOp,
]);
export type ProposedOperation = z.infer<typeof ProposedOperation>;
