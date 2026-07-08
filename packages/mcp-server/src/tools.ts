import { z } from "zod";
import { BrokerError, Confidence, recall, type RecallFilters } from "@vaultledger/core";
import type { ServerContext } from "./context.js";

/** Structured error shape every tool handler returns instead of throwing.
 * `code` is a BrokerError RejectionCode for core-level rejections, or
 * "INVALID_ARGS" for a zod validation failure. */
export interface ToolError {
  code: string;
  message: string;
  retriable: boolean;
}

/** A tool handler's result is a plain JSON-able object: either the
 * tool-specific success shape, or `{ error }` on failure. Never thrown. */
export type ToolResult = Record<string, unknown> & { error?: ToolError };

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  handler: (args: unknown) => Promise<ToolResult>;
}

function invalidArgs(message: string): ToolResult {
  return { error: { code: "INVALID_ARGS", message, retriable: false } };
}

function brokerError(e: BrokerError): ToolResult {
  return { error: e.toRejection() };
}

function internalError(e: unknown): ToolResult {
  return {
    error: {
      code: "INTERNAL_ERROR",
      message: e instanceof Error ? e.message : String(e),
      retriable: false,
    },
  };
}

/** Run a handler body, mapping a thrown BrokerError to a structured result
 * and any other thrown error to a generic INTERNAL_ERROR result. Handlers
 * must never let an exception escape to the transport layer. */
async function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BrokerError) return brokerError(e);
    return internalError(e);
  }
}

const RecallInput = z
  .object({
    entity: z.string().optional(),
    tag: z.string().optional(),
    status: z.enum(["scratch", "working", "canonical", "forgotten", "reverted"]).optional(),
    since: z.string().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

const RememberInput = z
  .object({
    content: z.string().min(1),
    entity: z.string().optional(),
    reason: z.string().min(1),
    tags: z.array(z.string()).optional(),
    confidence: Confidence.optional(),
    /** Id of the memory this new one supersedes (an updated belief). Forwarded
     * to MemoryStore.remember so the contradiction matcher's lineage
     * exclusion actually fires for agent-authored updates. */
    supersedes: z.string().optional(),
  })
  .strict();

const ReviseInput = z
  .object({
    id: z.string().min(1),
    patch: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

const PromoteInput = z
  .object({
    id: z.string().min(1),
    target_status: z.enum(["working", "canonical"]),
    reason: z.string().min(1),
  })
  .strict();

const ForgetInput = z
  .object({
    id: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

const DistillInput = z
  .object({
    content: z.string().min(1),
    // Not `.min(1)` at the zod layer on purpose: an empty `sources` array is
    // a semantic rejection (INVALID_SOURCE — "a distillation must cite at
    // least one source"), not a shape violation, so it's left to
    // `store.distill` to reject uniformly with everyone else's structured
    // BrokerError result rather than surfacing as a generic INVALID_ARGS
    // here.
    sources: z.array(z.string().min(1)),
    reason: z.string().min(1),
    entity: z.string().optional(),
    confidence: Confidence.optional(),
    score: z.number().optional(),
  })
  .strict();

const RetireInput = z
  .object({
    id: z.string().min(1),
    reason: z.string().min(1),
    superseded_by: z.string().optional(),
  })
  .strict();

const ProposeEditInput = z
  .object({
    path: z.string().min(1),
    patch: z.string().min(1),
    reason: z.string().min(1),
    expected_hash: z.string().min(1),
  })
  .strict();

const LedgerStatusInput = z.object({}).strict();

/**
 * Build the 9 spec tools (design §7 + v0.3b memory_distill/memory_retire) as a thin
 * adapter over `@vaultledger/core`.
 * Every handler validates its own args against its zod inputSchema and never
 * throws — invalid args and BrokerError rejections both come back as a
 * structured `{ error }` result, so the transport layer (stdio JSON-RPC) never
 * has to catch an exception mid-response.
 *
 * `session` is NOT a tool argument: every mutating tool uses `ctx.session`,
 * the MCP server's own per-process session id (design: the model doesn't get
 * to forge/choose a session).
 */
export function buildTools(ctx: ServerContext): ToolDef[] {
  return [
    {
      name: "memory_recall",
      description:
        "Retrieve memories and their provenance from the journal, optionally filtered by entity, tag, status, or since a timestamp.",
      inputSchema: RecallInput,
      handler: (rawArgs) =>
        guarded(async () => {
          const parsed = RecallInput.safeParse(rawArgs ?? {});
          if (!parsed.success) return invalidArgs(parsed.error.message);
          const { entity, tag, status, since, limit } = parsed.data;
          // Spec §9 filter set only: entity/tag/status/since/limit. Recall is
          // journal-indexed (exact matches); there is no free-text search in
          // v0.1, so there is deliberately no `query` param.
          const filters: RecallFilters = { entity, tag, status, since, limit };
          const memories = recall(ctx.journal, filters, ctx.now);
          return { memories };
        }),
    },
    {
      name: "memory_remember",
      description: "Create a new scratch memory note under the agent zone, attributed to this session.",
      inputSchema: RememberInput,
      handler: (rawArgs) =>
        guarded(async () => {
          const parsed = RememberInput.safeParse(rawArgs);
          if (!parsed.success) return invalidArgs(parsed.error.message);
          const { content, entity, reason, tags, confidence, supersedes } = parsed.data;
          const result = await ctx.store.remember({
            content,
            entity,
            reason,
            tags,
            confidence,
            supersedes,
            session: ctx.session,
          });
          const memRow = ctx.journal.getMemory(result.id);
          const memTags = ctx.journal.getTags(result.id);
          const provenance = memRow ? { ...memRow, tags: memTags } : null;
          return { id: result.id, path: result.path, status: "scratch", provenance };
        }),
    },
    {
      name: "memory_distill",
      description:
        "Create a new scratch memory DERIVED from other memories, citing them as sources. Every " +
        "cited source must exist and must not be forgotten (a retired source may still be cited); " +
        "a missing/forgotten source or an empty source list surfaces as a structured INVALID_SOURCE " +
        "result rather than a throw.",
      inputSchema: DistillInput,
      handler: (rawArgs) =>
        guarded(async () => {
          const parsed = DistillInput.safeParse(rawArgs);
          if (!parsed.success) return invalidArgs(parsed.error.message);
          const { content, sources, reason, entity, confidence, score } = parsed.data;
          const result = await ctx.store.distill({
            content,
            sources,
            reason,
            entity,
            confidence,
            score,
            session: ctx.session,
          });
          return { id: result.id, path: result.path, txnId: result.txnId };
        }),
    },
    {
      name: "memory_revise",
      description:
        "Patch an existing memory note's content with a unified diff. Revising a CANONICAL " +
        "memory's content is held for human approval (mirrors memory_promote/memory_forget's " +
        "canonical gate) instead of applying immediately.",
      inputSchema: ReviseInput,
      handler: (rawArgs) =>
        guarded(async () => {
          const parsed = ReviseInput.safeParse(rawArgs);
          if (!parsed.success) return invalidArgs(parsed.error.message);
          const { id, patch, reason } = parsed.data;
          const result = await ctx.store.revise({ id, patch, reason, session: ctx.session });
          if ("queued" in result) {
            return { queued: true, approvalId: result.approvalId };
          }
          return { id: result.id, revised: true };
        }),
    },
    {
      name: "memory_promote",
      description:
        "Request a memory lifecycle promotion (scratch->working applies immediately; working->canonical is held for approval).",
      inputSchema: PromoteInput,
      handler: (rawArgs) =>
        guarded(async () => {
          const parsed = PromoteInput.safeParse(rawArgs);
          if (!parsed.success) return invalidArgs(parsed.error.message);
          const { id, target_status, reason } = parsed.data;
          const result = await ctx.store.promote({
            id,
            target_status,
            reason,
            session: ctx.session,
          });
          return { promoted: result.promoted, approvalId: result.approvalId };
        }),
    },
    {
      name: "memory_forget",
      description:
        "Tombstone a memory: archive its file and mark it forgotten. Forgetting a canonical " +
        "memory is held for human approval (mirrors memory_promote's canonical gate) instead of " +
        "applying immediately.",
      inputSchema: ForgetInput,
      handler: (rawArgs) =>
        guarded(async () => {
          const parsed = ForgetInput.safeParse(rawArgs);
          if (!parsed.success) return invalidArgs(parsed.error.message);
          const { id, reason } = parsed.data;
          const result = await ctx.store.forget({ id, reason, session: ctx.session });
          if ("queued" in result) {
            return { queued: true, approvalId: result.approvalId };
          }
          return { id: result.id, forgotten: true };
        }),
    },
    {
      name: "memory_retire",
      description:
        "Mark a memory as no-longer-current: status -> retired, via a governed metadata patch " +
        "(never prose). Optionally cite a superseded_by memory id (must exist and not be forgotten). " +
        "Retiring a canonical memory is held for human approval (mirrors memory_forget's canonical gate) " +
        "instead of applying immediately.",
      inputSchema: RetireInput,
      handler: (rawArgs) =>
        guarded(async () => {
          const parsed = RetireInput.safeParse(rawArgs);
          if (!parsed.success) return invalidArgs(parsed.error.message);
          const { id, reason, superseded_by } = parsed.data;
          const result = await ctx.store.retire({ id, reason, superseded_by, session: ctx.session });
          if ("queued" in result) {
            return { queued: true, approvalId: result.approvalId };
          }
          return { id: result.id, retired: true };
        }),
    },
    {
      name: "vault_propose_edit",
      description:
        "Propose a patch to a trusted-zone note. Always queued for human approval; rejected outright for excluded paths.",
      inputSchema: ProposeEditInput,
      handler: (rawArgs) =>
        guarded(async () => {
          const parsed = ProposeEditInput.safeParse(rawArgs);
          if (!parsed.success) return invalidArgs(parsed.error.message);
          const { path, patch, reason, expected_hash } = parsed.data;
          const result = await ctx.broker.apply({
            op: "propose_edit",
            path,
            patch,
            expected_hash,
            reason,
            session: ctx.session,
          });
          if ("queued" in result && result.queued) {
            return { queued: true, approvalId: result.approvalId };
          }
          // propose_edit always queues (Broker.applyProposeEdit never applies
          // directly) — this branch is unreachable in practice but keeps the
          // handler total over ApplyResult's shape.
          return { queued: false };
        }),
    },
    {
      name: "ledger_status",
      description: "Report zones, pending approvals, and recent transactions.",
      inputSchema: LedgerStatusInput,
      handler: (rawArgs) =>
        guarded(async () => {
          const parsed = LedgerStatusInput.safeParse(rawArgs ?? {});
          if (!parsed.success) return invalidArgs(parsed.error.message);
          return {
            zones: ctx.manifest.zones,
            pendingApprovals: ctx.approvals.list(),
            recentTransactions: ctx.journal.listTransactions({ limit: 10 }),
          };
        }),
    },
  ];
}
