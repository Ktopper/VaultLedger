import { z } from "zod";

// v0.3b: "retired" is a terminal status for a memory that has been
// superseded by a distillation (see `derivation`/`superseded_by` below) or
// otherwise deliberately taken out of live circulation, distinct from
// "forgotten" (never should have existed) and "reverted" (undone broker
// write). It joins the non-live status sets that already anticipated it —
// `conflicts/queue.ts`'s DEAD_STATUSES already listed "retired" as
// forward-compat before this enum included it.
export const MemoryStatus = z.enum(["scratch", "working", "canonical", "forgotten", "reverted", "retired"]);
export const Confidence = z.enum(["low", "medium", "high"]);

// v0.3b: records that this memory is a distillation derived from the listed
// source memory ids. `kind` is a literal (not a free string) so the shape is
// extensible later without silently accepting garbage values today.
export const MemoryDerivation = z.object({
  kind: z.literal("distilled"),
  sources: z.array(z.string()),
});
export type MemoryDerivation = z.infer<typeof MemoryDerivation>;

export const MemoryProvenance = z.object({
  id: z.string().min(1),
  status: MemoryStatus,
  created: z.string().datetime(),
  source: z.string().min(1),
  reason: z.string().default(""),
  confidence: Confidence.default("medium"),
  supersedes: z.string().nullable().default(null),
  expires: z.string().datetime().nullable().default(null),
  // v0.3b lifecycle-ops fields — all OPTIONAL: a note written before this WU
  // (or one that never goes through distill/retire) has none of these and
  // must still parse cleanly.
  derivation: MemoryDerivation.optional(),
  retired_reason: z.string().optional(),
  superseded_by: z.string().nullable().optional(),
  score: z.number().optional(),
});
export type MemoryProvenance = z.infer<typeof MemoryProvenance>;
