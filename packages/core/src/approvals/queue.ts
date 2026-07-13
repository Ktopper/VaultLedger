import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { BrokerError } from "../errors.js";
import type { Broker } from "../broker/broker.js";
import { assertContainedAndReadable } from "../broker/containment.js";
import { checkContradictions } from "../contradiction/check.js";
import { checkSourceStaleness } from "../contradiction/staleness.js";
import type { ApprovalRow, Journal } from "../journal/journal.js";
import type { MemoryStore } from "../memory/store.js";
import type { PermissionsManifest } from "../schemas/manifest.js";
import type { ProposedOperation } from "../schemas/operation.js";

export interface ApprovalsOptions {
  broker: Broker;
  store: MemoryStore;
  journal: Journal;
  now: () => string;
  /** Absolute vault root, needed to read a revise op's target file's
   * before/after content for the source-linked staleness hook (design
   * v0.3b-2, dispatchApply's staleness pin — see dispatchApply's doc
   * comment). */
  vaultRoot: string;
  /** The vault's current permissions manifest (VL-SEC-S7-02) — REQUIRED and
   * threaded into `checkContradictions` at `dispatchApply`'s post-commit
   * hook (the approved-canonical-revise path, the OTHER content-changing
   * revise surface alongside `MemoryStore.revise`'s own immediate-apply
   * call). Omitting it here would leave `ledger approve` as a live route to
   * the same excluded-content leak (VL-SEC-S7-02) MemoryStore's own call
   * sites are gated against — see checkContradictions's doc comment. */
  manifest: PermissionsManifest;
  genId: (prefix: string) => string;
}

export type ApproveResult = { applied: true } | { stale: true };

/**
 * The "held op no longer applicable" class of dispatch failure -- the world
 * moved out from under a queued/held operation between enqueue and approve
 * time, and retrying the identical operation can never succeed. Any
 * BrokerError whose code is in this set causes `approve()` to mark the
 * approval `stale` (recording the code as `stale_reason`) and return
 * `{stale:true}` INSTEAD of throwing, across every dispatch arm (create/
 * revise/propose_edit via `dispatchApply`, and promote/forget/retire) -- see
 * `runDispatch` below.
 *
 * `NOT_FOUND` is DELIBERATELY EXCLUDED: a vanished target (file or memory
 * row) is ambiguous -- it could be a transient sync flake where the target
 * reappears -- so the conservative call is to leave the approval `pending`
 * for a human to review, not to auto-resolve it as stale.
 *
 * Any code NOT in this set propagates (throws) unchanged and leaves the
 * approval row `pending` -- a transient DB/lock bug or a real rejection
 * (FORBIDDEN_ZONE, PATCH_TOO_LARGE, SYNTAX_BREAK, NOT_FOUND, ...) must never
 * be silently buried by marking a legitimate approval stale.
 */
const STALE_ELIGIBLE_CODES = new Set<string>([
  "STALE_HASH",
  "INVALID_TRANSITION",
  "ALREADY_CLOSED",
  "ALREADY_REVERTED",
]);

/**
 * The pending-approval queue (design §5.2/§approvals). This is the general
 * enqueue/resolve surface used by callers that hold an operation pending
 * human review — `propose_edit` (queued by the Broker itself) and
 * `promote` working->canonical (queued by `MemoryStore.promote`) both land
 * rows here via their own call sites; `Approvals.enqueue` is the same
 * primitive exposed for any other caller that needs to hold an op.
 *
 * `approve()` DISPATCHES on the held operation's `op` field rather than
 * blindly forwarding to `Broker.apply`:
 *   - `create` / `revise`: these apply via `Broker.apply(op, {approved:true})`
 *     unchanged.
 *   - `propose_edit`: `Broker.apply` never applies a `propose_edit` directly
 *     (it always re-queues one — that's how it lands in this queue in the
 *     first place). To actually apply the held edit, approve() re-shapes it
 *     into the equivalent `revise` op (same fields; only the `op` literal
 *     differs) and calls `Broker.apply({...op, op:"revise"}, {approved:true})`,
 *     which runs the real hash-check + patch + commit path.
 *   - `promote`: a canonical promotion is not a path-based broker op at all
 *     (`Broker.apply` rejects `promote` with NOT_FOUND by design — see
 *     broker.ts). It is applied via `MemoryStore.setStatus`, which writes the
 *     new status into the note's FILE frontmatter (design §6.0, durable
 *     status) AND mirrors it onto the journal row — NOT a bare
 *     `journal.setMemoryStatus`, which would leave the file stale and lose the
 *     promotion on the next reindex.
 *   - `forget`: a canonical-belief forget (queued by `MemoryStore.forget`,
 *     mirroring the `promote` gate) is likewise not a path-based broker op.
 *     It is applied via `MemoryStore.forget(input, {approved:true})`, which
 *     bypasses the gate and runs the real tombstone (frontmatter flip +
 *     archive move + journal update).
 *   - `retire`: a canonical-belief retire (queued by `MemoryStore.retire`,
 *     mirroring the `forget` gate exactly) is likewise not a path-based
 *     broker op. It is applied via `MemoryStore.retire(input, {approved:true})`,
 *     which bypasses the gate and runs the real metadata patch (frontmatter
 *     status/retired_reason/superseded_by flip).
 *   - anything else: INVALID_TRANSITION (an unrecognized held op is a
 *     journal-integrity problem, not a normal rejection path).
 */
export class Approvals {
  private readonly broker: Broker;
  private readonly store: MemoryStore;
  private readonly journal: Journal;
  private readonly now: () => string;
  private readonly vaultRoot: string;
  private readonly manifest: PermissionsManifest;
  private readonly genId: (prefix: string) => string;

  constructor(opts: ApprovalsOptions) {
    this.broker = opts.broker;
    this.store = opts.store;
    this.journal = opts.journal;
    this.now = opts.now;
    this.vaultRoot = opts.vaultRoot;
    this.manifest = opts.manifest;
    this.genId = opts.genId;
  }

  /** Enqueue an arbitrary held operation for later approval. Returns the new approval id. */
  enqueue(
    op: ProposedOperation,
    zone: string,
    reason: string,
    session: string,
    genId: (prefix: string) => string,
  ): string {
    const id = genId("apr");
    const row: ApprovalRow = {
      id,
      held_operation: JSON.stringify(op),
      zone,
      reason,
      session,
      state: "pending",
      created_at: this.now(),
      resolved_at: null,
      stale_reason: null,
    };
    this.journal.insertApproval(row);
    return id;
  }

  /** Every currently-pending approval. */
  list(): ApprovalRow[] {
    return this.journal.listApprovals("pending");
  }

  async approve(id: string): Promise<ApproveResult> {
    const approval = this.loadPending(id);
    const op = JSON.parse(approval.held_operation) as { op: string; [key: string]: unknown };

    switch (op.op) {
      case "create":
      case "revise": {
        return this.dispatchApply(id, op as unknown as ProposedOperation);
      }
      case "propose_edit": {
        // Broker.apply never applies a propose_edit directly — re-shape it
        // into the equivalent revise op so the real write path runs.
        const reviseOp = { ...op, op: "revise" } as unknown as ProposedOperation;
        return this.dispatchApply(id, reviseOp);
      }
      case "promote": {
        // Durable status (design §6.0): flip the FILE frontmatter (and the
        // journal row) to canonical via the store, not a bare
        // journal.setMemoryStatus — otherwise the promotion is lost on the
        // next reindex. Routed through runDispatch (like every other arm)
        // so a held promote whose target has since moved out from under it
        // (e.g. INVALID_TRANSITION) stales instead of throwing.
        const memoryId = op.id as string;
        const reason = typeof op.reason === "string" ? op.reason : "approved canonical promotion";
        const session = typeof op.session === "string" ? op.session : "approval";
        return this.runDispatch(id, async () => {
          await this.store.setStatus(memoryId, "canonical", reason, session);
        });
      }
      case "forget": {
        // A canonical-forget is not a path-based broker op at all
        // (Broker.apply rejects `forget` with NOT_FOUND by design, same as
        // `promote` — see broker.ts). It is applied via
        // MemoryStore.forget(..., {approved:true}), which bypasses the
        // canonical gate and runs the real tombstone (frontmatter flip +
        // archive move + journal update) — mirrors the `promote` case above.
        const memoryId = op.id as string;
        const reason = typeof op.reason === "string" ? op.reason : "approved canonical forget";
        const session = typeof op.session === "string" ? op.session : "approval";
        return this.runDispatch(id, async () => {
          await this.store.forget({ id: memoryId, reason, session }, { approved: true });
        });
      }
      case "retire": {
        // A canonical-retire (queued by `MemoryStore.retire`, mirroring the
        // `forget` gate exactly) is likewise not a path-based broker op. It
        // is applied via MemoryStore.retire(..., {approved:true}), which
        // bypasses the canonical gate and runs the real metadata patch
        // (frontmatter status/retired_reason/superseded_by flip) — mirrors
        // the `forget` case above. THIS is the arm that used to strand a
        // zombie pending approval when the target was forgotten out from
        // under a queued retire (INVALID_TRANSITION) — runDispatch now
        // stales it instead.
        const memoryId = op.id as string;
        const reason = typeof op.reason === "string" ? op.reason : "approved canonical retire";
        const session = typeof op.session === "string" ? op.session : "approval";
        const supersededBy = typeof op.superseded_by === "string" ? op.superseded_by : undefined;
        return this.runDispatch(id, async () => {
          await this.store.retire(
            { id: memoryId, reason, superseded_by: supersededBy, session },
            { approved: true },
          );
        });
      }
      default:
        throw new BrokerError(
          "INVALID_TRANSITION",
          `unknown held operation in approval ${id}: ${String(op.op)}`,
        );
    }
  }

  reject(id: string): void {
    this.loadPending(id);
    this.journal.setApprovalState(id, "rejected", this.now());
  }

  private loadPending(id: string): ApprovalRow {
    const approval = this.journal.getApproval(id);
    if (!approval || approval.state !== "pending") {
      throw new BrokerError("NOT_FOUND", `no pending approval with id ${id}`);
    }
    return approval;
  }

  /**
   * HOOK-POINT PIN (design v0.3b-2): this is the OTHER content-changing
   * revise surface, alongside `MemoryStore.revise`'s own immediate-apply
   * path — an approved canonical-source revise's actual write lands HERE
   * (`Broker.apply` directly), never re-entering `store.revise` (see that
   * method's EXECUTION CONTRACT doc comment). Both surfaces call the SAME
   * `checkSourceStaleness` helper (contradiction/staleness.ts) so neither
   * can silently drift out of coverage — the class of bug `supersedes` once
   * had before the matcher's lineage exclusion existed.
   *
   * `dispatchApply` also applies plain `create` ops and `propose_edit`-
   * reshaped-to-`revise` ops (see `approve()`'s dispatch table); only the
   * `revise` case (post-reshape) is a candidate, and only when its `path`
   * names a memory id with a `memories` journal row — the pre-check below
   * derives that id from the path (memory note paths are always
   * `<dir>/<id>.md`, both in Agent/Memory and Agent/Archive) and skips
   * everything else. `checkSourceStaleness`'s own cheap guard handles the
   * "cited by nobody" case, so this fires unconditionally for every
   * journal-known revise target and lets that guard do the filtering.
   */
  private async dispatchApply(id: string, op: ProposedOperation): Promise<ApproveResult> {
    return this.runDispatch(id, async () => {
      // Pre-image, read BEFORE broker.apply mutates the file below. Never
      // throws (non-blocking, mirrors checkContradictions/checkSourceStaleness):
      // a pre-image read failure just skips the staleness hook for this
      // apply, it must never abort the real approval dispatch.
      let stalenessTarget: { memoryId: string; path: string; beforeContent: string } | null = null;
      if (op.op === "revise") {
        try {
          const candidateId = basename(op.path, ".md");
          if (this.journal.getMemory(candidateId)) {
            stalenessTarget = {
              memoryId: candidateId,
              path: op.path,
              beforeContent: readFileSync(
                assertContainedAndReadable(this.vaultRoot, this.manifest, op.path),
                "utf8",
              ),
            };
          }
        } catch (err) {
          console.error(
            `dispatchApply: could not read staleness pre-image for ${op.path}:`,
            err,
          );
        }
      }

      // Pass approvalId so the transaction the broker records carries this
      // approval's id — the SOUND link reconcile.closeStaleApprovals uses to
      // close a stale pending approval by exact id-match after a crash in the
      // gap below (see that function). The promote/forget/retire arms of
      // approve() do NOT route through broker.apply at all (they call the
      // store directly, which records no approval_id-tagged transaction) — a
      // crash there just leaves the approval pending, which is safe: no
      // false-close, a human re-acts.
      await this.broker.apply(op, { approved: true, approvalId: id });

      // Post-commit, non-blocking detection for an APPROVED revise of a memory
      // (design v0.3b-2). This apply path never re-enters store.revise, so BOTH
      // post-commit hooks that store.revise runs must be mirrored here or an
      // approved revise silently skips them: (1) contradiction detection — an
      // approved revise that flips a canonical value against another live belief
      // would otherwise go unflagged until a `--rescan`; and (2) source-linked
      // staleness. Both `checkContradictions` and `checkSourceStaleness` are
      // self-swallowing (a detection failure never fails the committed write).
      if (stalenessTarget !== null) {
        checkContradictions(
          {
            journal: this.journal,
            vaultRoot: this.vaultRoot,
            manifest: this.manifest,
            now: this.now,
            genId: this.genId,
          },
          stalenessTarget.memoryId,
        );
        try {
          const afterContent = readFileSync(
            assertContainedAndReadable(this.vaultRoot, this.manifest, stalenessTarget.path),
            "utf8",
          );
          checkSourceStaleness(
            { journal: this.journal, now: this.now, genId: this.genId },
            stalenessTarget.memoryId,
            stalenessTarget.beforeContent,
            afterContent,
          );
        } catch (err) {
          console.error(
            `dispatchApply: checkSourceStaleness failed for ${stalenessTarget.memoryId}:`,
            err,
          );
        }
      }
    });
  }

  /**
   * Shared dispatch wrapper for EVERY held-op arm of `approve()` (create/
   * revise/propose_edit via `dispatchApply` above, and promote/forget/retire
   * directly): run `fn` (the actual apply — broker.apply or a store call),
   * and
   *   - on success: mark the approval `approved` and return `{applied:true}`.
   *   - on a BrokerError whose code is in `STALE_ELIGIBLE_CODES` ("the world
   *     moved, this held op no longer applies"): mark the approval `stale`
   *     (recording the code as `stale_reason`) and return `{stale:true}` —
   *     NEVER throw. This is what fixes the retire-after-forget zombie: a
   *     queued canonical-retire whose target was forgotten out from under it
   *     used to throw INVALID_TRANSITION here and strand the approval
   *     `pending` forever; now it stales cleanly.
   *   - on any OTHER error (a non-allowlisted BrokerError, e.g.
   *     FORBIDDEN_ZONE/PATCH_TOO_LARGE/SYNTAX_BREAK/NOT_FOUND, or a
   *     non-BrokerError): propagate (throw) and leave the approval row
   *     `pending` — the write did not happen, and a human can inspect and
   *     reject() it. A transient DB/lock bug (or NOT_FOUND, deliberately
   *     excluded from the allowlist — see STALE_ELIGIBLE_CODES) must never be
   *     silently buried by auto-staling a legitimate approval.
   *
   * Crash gap (dispatchApply's broker.apply path only — see comment there):
   * the process can die between the write landing and this setApprovalState,
   * leaving the edit applied but the approval row still "pending". reconcile's
   * closeStaleApprovals repairs exactly this by approval_id id-match.
   */
  private async runDispatch(id: string, fn: () => Promise<void>): Promise<ApproveResult> {
    try {
      await fn();
    } catch (e) {
      if (e instanceof BrokerError && STALE_ELIGIBLE_CODES.has(e.code)) {
        this.journal.setApprovalStale(id, e.code, this.now());
        return { stale: true };
      }
      throw e;
    }
    this.journal.setApprovalState(id, "approved", this.now());
    return { applied: true };
  }
}
