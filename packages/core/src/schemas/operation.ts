import { z } from "zod";
import { MemoryStatus } from "./provenance.js";

const base = {
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
    ...base,
  })
  .strict();

export const ReviseOp = z
  .object({
    op: z.literal("revise"),
    path: z.string().min(1),
    expected_hash: z.string().min(1),
    patch: z.string().min(1),
    entity: z.string().optional(),
    ...base,
  })
  .strict();

export const ProposeEditOp = ReviseOp.extend({ op: z.literal("propose_edit") });

export const PromoteOp = z
  .object({
    op: z.literal("promote"),
    id: z.string().min(1),
    target_status: MemoryStatus,
    ...base,
  })
  .strict();

export const ForgetOp = z
  .object({
    op: z.literal("forget"),
    id: z.string().min(1),
    ...base,
  })
  .strict();

export const ProposedOperation = z.discriminatedUnion("op", [
  CreateOp,
  ReviseOp,
  ProposeEditOp,
  PromoteOp,
  ForgetOp,
]);
export type ProposedOperation = z.infer<typeof ProposedOperation>;
