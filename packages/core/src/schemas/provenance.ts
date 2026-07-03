import { z } from "zod";

export const MemoryStatus = z.enum(["scratch", "working", "canonical", "forgotten", "reverted"]);
export const Confidence = z.enum(["low", "medium", "high"]);

export const MemoryProvenance = z.object({
  id: z.string().min(1),
  status: MemoryStatus,
  created: z.string().datetime(),
  source: z.string().min(1),
  reason: z.string().default(""),
  confidence: Confidence.default("medium"),
  supersedes: z.string().nullable().default(null),
  expires: z.string().datetime().nullable().default(null),
});
export type MemoryProvenance = z.infer<typeof MemoryProvenance>;
